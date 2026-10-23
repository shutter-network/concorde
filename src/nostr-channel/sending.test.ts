import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import type { NostrEvent } from "nostr-tools/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Db } from "../db/index.ts";
import { serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import type { MessageRecord } from "../messenger/messages.ts";
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
import { readDirectMessage } from "../test-support/nostr-envelopes.ts";
import { waitUntil } from "../test-support/wait.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createNostrChannel, type NostrChannel } from "./nostr-channel.ts";
import * as nostrChannelSchema from "./schema/index.ts";
import { nostrChannelTables, outbox } from "./schema/index.ts";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let database: TestDatabase;
let db: Db;
let users: Users;
let worker: SignalWorker;

before(async () => {
  database = await createTestDatabase("nostr_sending");
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

function deploymentFor(relay: FakeRelay, secretKey: Uint8Array = generateSecretKey()): Deployment {
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
    relayUrl: relay.url,
    logger: silent,
  });
  return { relay, messenger, channel };
}

async function withDeployment(
  body: (deployment: Deployment) => Promise<void>,
  options: FakeRelayOptions = {},
): Promise<void> {
  const relay = await startFakeRelay(options);
  const deployment = deploymentFor(relay);
  await deployment.channel.start();
  try {
    await body(deployment);
  } finally {
    await deployment.channel.stop();
    await relay.stop();
  }
}

type Recipient = { readonly id: string; readonly secretKey: Uint8Array };

async function admit(channel: NostrChannel): Promise<Recipient> {
  const secretKey = generateSecretKey();
  const id = await db.tx(async (tx) => {
    const user = await users.create(tx);
    await channel.recordPublicKey(tx, user.id, getPublicKey(secretKey));
    return user.id;
  });
  return { id, secretKey };
}

async function unreachable(): Promise<string> {
  const user = await db.tx((tx) => users.create(tx));
  return user.id;
}

function answer(messenger: Messenger, userId: string, text: string): Promise<MessageRecord> {
  return db.tx((tx) => messenger.send(tx, userId, text));
}

function queuedFor(userId: string): Promise<(typeof outbox.$inferSelect)[]> {
  return db.handle(nostrChannelTables).select().from(outbox).where(eq(outbox.userId, userId));
}

function replies(relay: FakeRelay): readonly NostrEvent[] {
  return relay.published.filter((event) => event.kind === 1059);
}

function offered(relay: FakeRelay, eventId: string): number {
  return relay.received.filter(
    (message) => message.verb === "EVENT" && message.event?.id === eventId,
  ).length;
}

function soleReplyTo(relay: FakeRelay, recipient: Recipient): string | undefined {
  assert.equal(replies(relay).length, 1);
  const [wrap] = replies(relay);
  return wrap === undefined
    ? undefined
    : readDirectMessage(wrap, recipient.secretKey)?.rumor.content;
}

describe("the agent's reply reaching a User's Nostr client", () => {
  it("arrives once, readable by that User alone, with the agent as its sealed author", async () => {
    await withDeployment(async ({ relay, messenger, channel }) => {
      const recipient = await admit(channel);
      const eavesdropper = generateSecretKey();

      await answer(messenger, recipient.id, "the deploy finished");
      await channel.drain();

      assert.equal(replies(relay).length, 1);
      const [wrap] = replies(relay);
      assert.ok(wrap !== undefined);

      const read = readDirectMessage(wrap, recipient.secretKey);
      assert.equal(read?.rumor.content, "the deploy finished");
      assert.equal(read?.sealAuthor, channel.publicKey);
      assert.equal(read?.rumor.pubkey, channel.publicKey);
      assert.equal(read?.rumor.kind, 14);
      assert.deepEqual(read?.rumor.tags, [["p", getPublicKey(recipient.secretKey)]]);

      assert.equal(readDirectMessage(wrap, eavesdropper), undefined);

      assert.deepEqual(await queuedFor(recipient.id), []);
    });
  });

  it("tells the Relay nothing about who is being answered, or when", async () => {
    await withDeployment(async ({ relay, messenger, channel }) => {
      const recipient = await admit(channel);
      const recipientKey = getPublicKey(recipient.secretKey);

      for (const nth of [1, 2, 3, 4, 5]) await answer(messenger, recipient.id, `reply ${nth}`);
      await channel.drain();
      assert.equal(replies(relay).length, 5);

      const seconds = Math.floor(Date.now() / 1000);
      for (const wrap of replies(relay)) {
        assert.deepEqual(wrap.tags, [["p", recipientKey]]);
        assert.notEqual(wrap.pubkey, channel.publicKey);
        assert.notEqual(wrap.pubkey, recipientKey);
        assert.equal(wrap.content.includes("reply"), false);
        assert.ok(wrap.created_at <= seconds);
      }

      const oldest = Math.min(...replies(relay).map((wrap) => wrap.created_at));
      assert.ok(oldest < seconds - 3600, "the published timestamps should not be the real ones");
    });
  });

  it("publishes without being told to, because the queue row wakes the drain", async () => {
    await withDeployment(async ({ relay, messenger, channel }) => {
      const recipient = await admit(channel);

      await answer(messenger, recipient.id, "nobody drained this");

      await waitUntil(
        "the notification reaches the Relay",
        async () => (await queuedFor(recipient.id)).length === 0,
      );
      assert.equal(soleReplyTo(relay, recipient), "nobody drained this");
      assert.deepEqual(await queuedFor(recipient.id), []);
    });
  });
});

describe("a reply that could never go out", () => {
  it("refuses a User with no recorded key, and records no Message", async () => {
    await withDeployment(async ({ relay, messenger }) => {
      const stranger = await unreachable();

      await assert.rejects(
        () => answer(messenger, stranger, "nobody will read this"),
        /UnrecordedPublicKeyError/,
      );

      assert.deepEqual(await messenger.history(stranger), []);
      assert.deepEqual(await queuedFor(stranger), []);
      assert.deepEqual(replies(relay), []);
    });
  });

  it("refuses a reply larger than the Relay accepts, and records no Message", async () => {
    await withDeployment(
      async ({ relay, messenger, channel }) => {
        const recipient = await admit(channel);

        await assert.rejects(
          () => answer(messenger, recipient.id, "x".repeat(8000)),
          /MessageTooLargeError/,
        );
        assert.deepEqual(await messenger.history(recipient.id), []);
        assert.deepEqual(await queuedFor(recipient.id), []);
        assert.deepEqual(replies(relay), []);

        await answer(messenger, recipient.id, "short enough");
        await channel.drain();
        assert.equal(replies(relay).length, 1);
      },
      { information: { limitation: { max_message_length: 4096 } } },
    );
  });

  it("publishes nothing for a transaction that rolls back", async () => {
    await withDeployment(async ({ relay, messenger, channel }) => {
      const recipient = await admit(channel);

      await assert.rejects(
        () =>
          db.tx(async (tx) => {
            await messenger.send(tx, recipient.id, "said inside a doomed transaction");
            await users.setAttributes(tx, recipient.id, { told: "yes" });
            throw new Error("the Operator's own work failed");
          }),
        /the Operator's own work failed/,
      );

      await channel.drain();
      assert.deepEqual(await messenger.history(recipient.id), []);
      assert.deepEqual(await queuedFor(recipient.id), []);
      assert.deepEqual(replies(relay), []);
      assert.deepEqual((await users.get(recipient.id))?.attributes, {});
    });
  });

  it("commits the answer and the Operator's own record together", async () => {
    await withDeployment(async ({ relay, messenger, channel }) => {
      const recipient = await admit(channel);

      const said = await db.tx(async (tx) => {
        const message = await messenger.send(tx, recipient.id, "we shipped it");
        await users.setAttributes(tx, recipient.id, { told: "yes" });
        return message;
      });

      await channel.drain();
      assert.equal((await messenger.history(recipient.id))[0]?.id, said.id);
      assert.deepEqual((await users.get(recipient.id))?.attributes, { told: "yes" });
      assert.equal(soleReplyTo(relay, recipient), "we shipped it");
    });
  });
});

describe("a publish the Relay will not take", () => {
  it("leaves one durable row carrying the Relay's own reason, and is never attempted again", async () => {
    await withDeployment(
      async ({ relay, messenger, channel }) => {
        const recipient = await admit(channel);

        const said = await answer(messenger, recipient.id, "the Relay will not take this");
        await channel.drain();

        assert.equal(
          (await messenger.history(recipient.id))[0]?.text,
          "the Relay will not take this",
        );

        const [row] = await queuedFor(recipient.id);
        assert.ok(row !== undefined, "a refused publish should leave a row an Operator can find");
        assert.equal(row.reason, "blocked: this Relay does not take those");
        assert.notEqual(row.failedAt, null);
        assert.equal(row.messageId, said.id);

        const eventId = row.eventId;
        assert.equal(offered(relay, eventId), 1);

        await channel.drain();
        await answer(messenger, recipient.id, "a later reply, which wakes the drain again");
        await channel.drain();
        await channel.stop();
        await channel.start();
        await channel.drain();

        assert.equal(offered(relay, eventId), 1);
        assert.equal((await queuedFor(recipient.id)).length, 2);
      },
      { refuse: () => "blocked: this Relay does not take those" },
    );
  });
});

describe("a reply queued while the Channel is not running", () => {
  it("is published when it starts, which is how work outlives a process", async () => {
    const relay = await startFakeRelay();
    const secretKey = generateSecretKey();
    const { messenger, channel: first } = deploymentFor(relay, secretKey);
    const { channel: second } = deploymentFor(relay, secretKey);

    try {
      const recipient = await admit(first);
      await answer(messenger, recipient.id, "queued by a process that went away");
      assert.equal((await queuedFor(recipient.id)).length, 1);
      assert.deepEqual(replies(relay), []);

      await second.start();
      await waitUntil(
        "the next process publishes it and forgets the row",
        async () => (await queuedFor(recipient.id)).length === 0,
      );
      assert.equal(soleReplyTo(relay, recipient), "queued by a process that went away");
      assert.deepEqual(await queuedFor(recipient.id), []);
    } finally {
      await first.stop();
      await second.stop();
      await relay.stop();
    }
  });

  it("survives a stop in the middle of the publish, and goes out on the next start", async () => {
    let stalledOnce = false;
    const relay = await startFakeRelay({
      stall: () => {
        if (stalledOnce) return false;
        stalledOnce = true;
        return true;
      },
    });
    const { messenger, channel } = deploymentFor(relay);

    try {
      await channel.start();
      const recipient = await admit(channel);

      const said = await answer(messenger, recipient.id, "interrupted halfway out");
      await waitUntil("the Channel is waiting inside the publish", async () =>
        relay.received.some((message) => message.verb === "EVENT"),
      );

      await channel.stop();

      const [row] = await queuedFor(recipient.id);
      assert.equal(row?.reason, null);
      assert.equal(row?.failedAt, null);
      assert.equal(row?.messageId, said.id);
      assert.equal((await messenger.history(recipient.id))[0]?.id, said.id);
      assert.deepEqual(replies(relay), []);

      await channel.start();
      await waitUntil(
        "the reply goes out after the restart and the row is forgotten",
        async () => (await queuedFor(recipient.id)).length === 0,
      );
      assert.equal(soleReplyTo(relay, recipient), "interrupted halfway out");
      assert.deepEqual(await queuedFor(recipient.id), []);
    } finally {
      await channel.stop();
      await relay.stop();
    }
  });
});
