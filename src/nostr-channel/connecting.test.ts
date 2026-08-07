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
 * Real PostgreSQL, a real WebSocket, and the Signal Worker constructed but never started: what an
 * inbound Message wakes is `receiving.test.ts`'s subject.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { serverComponent } from "../components.ts";
import type { Db } from "../db/index.ts";
import type { Logger } from "../logging.ts";
import { createMessenger, type Messenger } from "../messenger/messenger.ts";
import * as messengerSchema from "../messenger/schema.ts";
import * as signalsSchema from "../signals/schema.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { type FakeRelay, type FakeRelayAuth, startFakeRelay } from "../test-support/fake-relay.ts";
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
  users = createUsers({ db, tokenTtl: 60 * 60 * 1000 });
  worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {}, logger: silent });
});

after(() => database.drop());

type Deployment = {
  readonly relay: FakeRelay;
  readonly messenger: Messenger;
  readonly channel: NostrChannel;
};

/** A Relay, a Messenger and a Channel, all torn down whether the body passed or threw. */
async function withDeployment(
  auth: FakeRelayAuth,
  body: (deployment: Deployment) => Promise<void>,
): Promise<void> {
  const relay = await startFakeRelay({ auth });
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
    relayUrl: relay.url,
    logger: silent,
  });
  try {
    await body({ relay, messenger, channel });
  } finally {
    await channel.stop();
    await relay.stop();
  }
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
    await withDeployment("none", async ({ relay, messenger, channel }) => {
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
    await withDeployment("none", async ({ channel }) => {
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
      await withDeployment(timing, async ({ relay, messenger, channel }) => {
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
      });
    });
  }
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
