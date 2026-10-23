import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import type { NostrEvent } from "nostr-tools/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Db } from "../db/index.ts";
import { serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import { createMessenger, type Messenger } from "../messenger/messenger.ts";
import * as messengerSchema from "../messenger/schema/index.ts";
import * as signalsSchema from "../signals/schema/index.ts";
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
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createNostrChannel, type NostrChannel } from "./nostr-channel.ts";
import * as nostrChannelSchema from "./schema/index.ts";

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

function announcements(relay: FakeRelay): readonly NostrEvent[] {
  return relay.published.filter((event) => event.kind === 10050);
}

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

      assert.equal(relay.received.length, 0);

      await channel.start();
      await waitUntil("the Channel subscribes", async () =>
        relay.received.some((message) => message.verb === "REQ"),
      );
      const [request] = relay.received.filter((message) => message.verb === "REQ");
      assert.deepEqual(request?.filters, [{ kinds: [1059], "#p": [channel.publicKey] }]);

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

      const requests = relay.received.filter((message) => message.verb === "REQ");
      const resubscribed = requests.find(
        (message) => message.connection !== requests[0]?.connection,
      );
      assert.notEqual(resubscribed, undefined);
      assert.deepEqual(resubscribed?.filters, requests[0]?.filters);
    });
  });

  it("stops without leaving anything connected, so a second stop finds nothing to do", async () => {
    await withDeployment({}, async ({ channel }) => {
      await channel.start();
      await channel.stop();
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
        await waitUntil("the Message arrives", async () => {
          return (await messenger.history(user.id)).length === 1;
        });
        assert.equal(
          (await messenger.history(user.id))[0]?.text,
          `held for a client that authenticates ${timing}`,
        );

        const authenticated = relay.received.find((message) => message.verb === "AUTH");
        assert.equal(authenticated?.event?.pubkey, channel.publicKey);
        assert.equal(authenticated?.event?.kind, 22242);
        assert.deepEqual(
          authenticated?.event?.tags.find((tag) => tag[0] === "relay"),
          ["relay", relay.url],
        );

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
      assert.deepEqual(list?.tags, [["relay", relay.url]]);
      assert.equal(list?.pubkey, channel.publicKey);
      assert.equal(list?.content, "");

      assert.equal(relay.published.length, 1);
    });
  });

  it("passes on the Relay's address exactly as it was given, without normalising it", async () => {
    const relay = await startFakeRelay();
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

      const [first, second] = announcements(relay);
      assert.equal(first?.pubkey, channel.publicKey);
      assert.equal(second?.pubkey, first?.pubkey);
      assert.equal(second?.kind, first?.kind);
      assert.deepEqual(second?.tags, first?.tags);
      assert.equal(relay.published.length, 2);

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
      await channel.start();
      const user = await admit(channel);
      relay.hold(
        directMessage({
          senderSecretKey: user.secretKey,
          recipientPublicKey: channel.publicKey,
          text: "sent to an agent whose relay list was refused",
        }),
      );

      await waitUntil("the Message arrives anyway", async () => {
        return (await messenger.history(user.id)).length === 1;
      });
      assert.deepEqual(relay.published, []);

      await waitUntil("the refusal is on the log", async () => warnings.length > 0);
      assert.match(warnings[0] ?? "", /Relay list/);
    } finally {
      await channel.stop();
      await relay.stop();
    }
  });
});

describe("the shared agent's Nostr identity", () => {
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

    assert.equal(channel.publicKey, getPublicKey(secretKey));
    assert.match(channel.publicKey, /^[0-9a-f]{64}$/);
  });
});
