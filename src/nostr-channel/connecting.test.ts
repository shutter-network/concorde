/**
 * The one connection this component holds: when it opens, when it closes, and what it says to a
 * Relay that will not serve an anonymous client.
 *
 * The Nostr Channel is the first part of the framework that keeps a long-lived connection it
 * opened itself to something other than the Db, so the lifecycle rule every other Component gets
 * for free has to be asked for here: **nothing connects at construction**, the connection is
 * `start`'s, and `stop` gives it back. A stop followed by a start is a separate claim, because
 * the client library's `close` is terminal and a Channel that reused it would come back deaf.
 *
 * **Both authentication timings are exercised, and that is not redundancy.** Relays differ on
 * whether the NIP-42 challenge arrives on connect or only when a client first asks for something
 * restricted, and a client that waited for a challenge before subscribing would deadlock against
 * the second kind. What is asserted is a Message that arrived, not a handshake that happened.
 *
 * The relay list is here too, because publishing it is something a start does to a connection.
 * **What the Relay then does with it is deliberately not asserted.** The fake Relay implements no
 * replaceable-event semantics, so a second kind 10050 is a second stored event rather than a
 * replacement — and teaching it to replace would only prove the fixture replaces, which is a
 * Relay's obligation under NIP-01 and not this Channel's. What is the Channel's obligation, and is
 * what these assert, is that every announcement it ever makes is the same replaceable coordinate:
 * one pubkey, one kind in the replaceable range. A Relay holding one of those is then arithmetic.
 *
 * Real PostgreSQL, a real WebSocket, and the Signal Worker constructed but never started: what an
 * inbound Message wakes is `receiving.test.ts`'s subject.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import type { NostrEvent } from "nostr-tools/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Db } from "../db/index.ts";
import { serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import { createMessenger, type Messenger } from "../messenger/messenger.ts";
import * as messengerSchema from "../messenger/schema.ts";
import * as signalsSchema from "../signals/schema.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import {
  type FakeRelay,
  type FakeRelayOptions,
  startFakeRelay,
} from "../test-support/fake-relay.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { directMessage } from "../test-support/nostr-envelopes.ts";
import { waitUntil } from "../test-support/wait.ts";
import * as usersSchema from "../users/schema.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createNostrChannel, type NostrChannel } from "./nostr-channel.ts";
import * as nostrChannelSchema from "./schema.ts";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let database: TestDatabase;
let db: Db;
let users: Users;
let worker: SignalWorker;

before(async () => {
  database = await createTestDatabase("nostr_connecting");
  db = database.db;
  await applySchema(db, signalsSchema, usersSchema, messengerSchema, nostrChannelSchema);
  users = createUsers({ db });
  worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {}, logger: silent });
});

after(() => database.drop());

type Deployment = {
  readonly relay: FakeRelay;
  readonly messenger: Messenger;
  readonly channel: NostrChannel;
};

/**
 * A Messenger and the one Channel registered with it, pointed at a Relay and **not started**.
 *
 * A Messenger of its own each time, because a Channel registers with one Messenger once. The
 * address is an override rather than the Relay's own, for the one test whose subject is that this
 * component passes on whatever it was given.
 */
function deploymentFor(
  relay: FakeRelay,
  overrides: { readonly relayUrl?: string; readonly logger?: Logger } = {},
): Deployment {
  const messenger = createMessenger({
    db,
    users,
    worker,
    agentServer: serverComponent(Fastify(), nowhere),
  });
  const channel = createNostrChannel({
    db,
    messenger,
    users,
    secretKey: generateSecretKey(),
    relayUrl: overrides.relayUrl ?? relay.url,
    logger: overrides.logger ?? silent,
  });
  return { relay, messenger, channel };
}

/** A Relay, a Messenger and a Channel, all torn down whether the body passed or threw. */
async function withDeployment(
  options: FakeRelayOptions,
  body: (deployment: Deployment) => Promise<void>,
): Promise<void> {
  const relay = await startFakeRelay(options);
  const deployment = deploymentFor(relay);
  try {
    await body(deployment);
  } finally {
    await deployment.channel.stop();
    await relay.stop();
  }
}

/** Every relay list the Relay took, which is what a client asking where to write would read. */
function announcements(relay: FakeRelay): readonly NostrEvent[] {
  return relay.published.filter((event) => event.kind === 10050);
}

/** A User admitted the way trusted code admits one, with a Nostr key recorded for them. */
async function admit(channel: NostrChannel): Promise<{ id: string; secretKey: Uint8Array }> {
  const secretKey = generateSecretKey();
  const id = await db.tx(async (tx) => {
    const user = await users.create(tx);
    await channel.recordPublicKey(tx, user.id, getPublicKey(secretKey));
    return user.id;
  });
  return { id, secretKey };
}

describe("the Nostr Channel's one connection", () => {
  it("connects on start and not before, and works again after a stop", async () => {
    await withDeployment({}, async ({ relay, messenger, channel }) => {
      const user = await admit(channel);

      // Constructed, and the Relay has heard nothing: a Component that dialled at construction
      // would make building a Gateway a network act, and the whole framework builds first and
      // starts second.
      assert.equal(relay.received.length, 0);

      await channel.start();
      await waitUntil("the Channel subscribes", async () =>
        relay.received.some((message) => message.verb === "REQ"),
      );
      // The filter carries no `since`: a gift wrap's timestamp is randomised into the past, so a
      // watermark would discard most of what is in flight (ADR-0049). What is asked for is every
      // gift wrap addressed to this agent, every time.
      const [request] = relay.received.filter((message) => message.verb === "REQ");
      assert.deepEqual(request?.filters, [{ kinds: [1059], "#p": [channel.publicKey] }]);

      // Stopped and started again, which the library's terminal `close` makes a real question:
      // the Channel has to build a fresh client or come back deaf. What proves it did is a
      // message published afterwards arriving.
      await channel.stop();
      await channel.start();
      relay.hold(
        directMessage({
          senderSecretKey: user.secretKey,
          recipientPublicKey: channel.publicKey,
          text: "sent after a stop and a start",
        }),
      );
      await waitUntil("the Message arrives on the second connection", async () => {
        return (await messenger.history(user.id)).length === 1;
      });

      // Two connections, and the second asked for exactly what the first did.
      const requests = relay.received.filter((message) => message.verb === "REQ");
      assert.equal(requests.length >= 2, true);
      assert.notEqual(requests.at(-1)?.connection, requests[0]?.connection);
      assert.deepEqual(requests.at(-1)?.filters, requests[0]?.filters);
    });
  });

  it("stops without leaving anything connected, so a second stop finds nothing to do", async () => {
    await withDeployment({}, async ({ channel }) => {
      await channel.start();
      await channel.stop();
      // Idempotent, and a `stop` before any `start` is the same no-op. Both are what a Gateway
      // does to a Component whose start failed, or which was never reached.
      await channel.stop();
    });
  });
});

describe("a Relay that serves nobody it has not authenticated", () => {
  for (const timing of ["on-connect", "on-demand"] as const) {
    it(`authenticates and is served when the challenge arrives ${timing}`, async () => {
      await withDeployment({ auth: timing }, async ({ relay, messenger, channel }) => {
        const user = await admit(channel);
        relay.hold(
          directMessage({
            senderSecretKey: user.secretKey,
            recipientPublicKey: channel.publicKey,
            text: `held for a client that authenticates ${timing}`,
          }),
        );

        await channel.start();
        // The assertion is the Message, not the handshake: a Channel that authenticated and was
        // still refused, or that deadlocked waiting for a challenge that only comes on demand,
        // would never get here.
        await waitUntil("the Message arrives", async () => {
          return (await messenger.history(user.id)).length === 1;
        });
        assert.equal(
          (await messenger.history(user.id))[0]?.text,
          `held for a client that authenticates ${timing}`,
        );

        // And it authenticated as the agent itself, with the agent's own Nostr identity — which
        // is what makes closing a Relay to outsiders possible at all.
        const authenticated = relay.received.find((message) => message.verb === "AUTH");
        assert.equal(authenticated?.event?.pubkey, channel.publicKey);
        assert.equal(authenticated?.event?.kind, 22242);
        // The Relay's address goes in the tag exactly as the Operator gave it, with no
        // normalisation: Relays treat trailing variants as distinct addresses.
        assert.deepEqual(
          authenticated?.event?.tags.find((tag) => tag[0] === "relay"),
          ["relay", relay.url],
        );

        // The relay list goes out on the same connection, and it is offered before the challenge
        // has been answered — so what gets it there is the client retrying a refused event once
        // authentication completes. Without this the announcement would silently never happen on
        // every Relay worth authenticating to, and the Message above would still arrive.
        await waitUntil(
          "the relay list survives the handshake",
          async () => announcements(relay).length === 1,
        );
      });
    });
  }
});

describe("the agent saying where it can be messaged", () => {
  it("announces one Relay at start, in the form the specification defines, and nothing else", async () => {
    await withDeployment({}, async ({ relay, channel }) => {
      await channel.start();
      await waitUntil("the agent announces its Relay", async () => announcements(relay).length > 0);

      const [list] = announcements(relay);
      // The spec's tag name, and not the `["r", url]` a near-half of the ecosystem emits: a client
      // reading the specification is the only kind that reaches this agent at all.
      assert.deepEqual(list?.tags, [["relay", relay.url]]);
      // Signed by the agent's own identity, because a relay list is only about the key that signed
      // it. One signed by anything else says where somebody else receives messages.
      assert.equal(list?.pubkey, channel.publicKey);
      assert.equal(list?.content, "");

      // And that is the whole of what this agent says about itself. No kind 0 profile, no name and
      // no picture: an Operator hand-picks these Users, so there is nobody to introduce it to.
      assert.equal(relay.published.length, 1);
    });
  });

  it("passes on the Relay's address exactly as it was given, without normalising it", async () => {
    const relay = await startFakeRelay();
    // A trailing slash, which is the ordinary way two spellings of one Relay come about. Relays
    // treat them as distinct addresses, so a Channel that tidied this up would announce an address
    // its own Users' clients then failed to match.
    const asWritten = `${relay.url}/`;
    const { channel } = deploymentFor(relay, { relayUrl: asWritten });

    try {
      await channel.start();
      await waitUntil("the agent announces its Relay", async () => announcements(relay).length > 0);
      assert.deepEqual(announcements(relay)[0]?.tags, [["relay", asWritten]]);
      assert.notEqual(asWritten, relay.url);
    } finally {
      await channel.stop();
      await relay.stop();
    }
  });

  it("announces again on a restart, and every announcement is the same replaceable event", async () => {
    await withDeployment({}, async ({ relay, messenger, channel }) => {
      await channel.start();
      await waitUntil("the first announcement", async () => announcements(relay).length === 1);

      await channel.stop();
      await channel.start();
      await waitUntil("the second announcement", async () => announcements(relay).length === 2);

      // Nothing accumulates, and this is where that claim is earned rather than watched: NIP-01
      // has a Relay keep one event per author and kind in this range, so two announcements sharing
      // both are two spellings of one row. The fake Relay stores them separately and that is fine
      // — replacing is its obligation, not this Channel's, and a fixture taught to do it would
      // only be a fixture asserting itself.
      const [first, second] = announcements(relay);
      assert.equal(first?.pubkey, channel.publicKey);
      assert.equal(second?.pubkey, first?.pubkey);
      assert.equal(second?.kind, first?.kind);
      assert.deepEqual(second?.tags, first?.tags);
      // Two of them and no third: one start says this once, however many envelopes it then reads.
      assert.equal(relay.published.length, 2);

      // And the restart that republished it is a working Channel, not merely a talking one.
      const user = await admit(channel);
      relay.hold(
        directMessage({
          senderSecretKey: user.secretKey,
          recipientPublicKey: channel.publicKey,
          text: "sent after the second announcement",
        }),
      );
      await waitUntil("the Message arrives", async () => {
        return (await messenger.history(user.id)).length === 1;
      });
    });
  });

  it("starts, warns and keeps working when the Relay will not take the announcement", async () => {
    const warnings: string[] = [];
    const relay = await startFakeRelay({
      refuse: (event) => (event.kind === 10050 ? "blocked: we do not take relay lists" : undefined),
    });
    const { messenger, channel } = deploymentFor(relay, {
      logger: { ...silent, warn: (_fields, message) => void warnings.push(message) },
    });

    try {
      // Returning at all is the first half of the claim: the Relay's mood is not a boot dependency
      // for a Gateway that is much more than this Channel.
      await channel.start();
      const user = await admit(channel);
      relay.hold(
        directMessage({
          senderSecretKey: user.secretKey,
          recipientPublicKey: channel.publicKey,
          text: "sent to an agent whose relay list was refused",
        }),
      );

      // The second half: everything this Channel is for still works. The announcement buys a
      // client's willingness to write, and a client already willing is unaffected.
      await waitUntil("the Message arrives anyway", async () => {
        return (await messenger.history(user.id)).length === 1;
      });
      assert.deepEqual(relay.published, []);

      // Visible rather than silent, because the Operator's Users may now be holding a client that
      // refuses to message this agent and nothing else would say why.
      await waitUntil("the refusal is on the log", async () => warnings.length > 0);
      assert.match(warnings[0] ?? "", /relay list/);
    } finally {
      await channel.stop();
      await relay.stop();
    }
  });
});

describe("the Shared Agent's Nostr identity", () => {
  it("is derived from the raw bytes it was constructed with, and nothing else", async () => {
    const secretKey = generateSecretKey();
    const messenger = createMessenger({
      db,
      users,
      worker,
      agentServer: serverComponent(Fastify(), nowhere),
    });
    const channel = createNostrChannel({
      db,
      messenger,
      users,
      secretKey,
      relayUrl: "ws://127.0.0.1:1",
      logger: silent,
    });

    // 32 raw bytes in, a lowercase hex public key out. The framework parses no key material and
    // generates none: there is no `nsec` decoder here, no file path option and no environment
    // variable, so a deployment brings its own identity or does not start (ADR-0050).
    assert.equal(channel.publicKey, getPublicKey(secretKey));
    assert.match(channel.publicKey, /^[0-9a-f]{64}$/);
  });
});
