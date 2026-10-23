import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
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
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import { MalformedPublicKeyError, NoSuchUserError, PublicKeyConflictError } from "./identities.ts";
import { createNostrChannel, type NostrChannel } from "./nostr-channel.ts";
import * as nostrChannelSchema from "./schema/index.ts";
import { nostrChannelTables, pubkeys } from "./schema/index.ts";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const unreachable = "ws://127.0.0.1:1";

let database: TestDatabase;
let db: Db;
let users: Users;
let worker: SignalWorker;
let messenger: Messenger;
let channel: NostrChannel;

before(async () => {
  database = await createTestDatabase("nostr_recording");
  db = database.db;
  await applySchema(db, signalsSchema, usersSchema, messengerSchema, nostrChannelSchema);

  users = createUsers({ db });
  worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {}, logger: silent });
  messenger = createMessenger({
    db,
    users,
    worker,
    agentServer: serverComponent(Fastify(), nowhere),
  });
  channel = createNostrChannel({
    db,
    messenger,
    users,
    secretKey: generateSecretKey(),
    relayUrl: unreachable,
    logger: silent,
  });
});

after(() => database.drop());

async function admit(): Promise<string> {
  return (await db.tx((tx) => users.create(tx))).id;
}

async function keyOf(userId: string): Promise<string | undefined> {
  const rows = await db
    .handle(nostrChannelTables)
    .select({ pubkey: pubkeys.pubkey })
    .from(pubkeys)
    .where(eq(pubkeys.userId, userId));
  return rows[0]?.pubkey;
}

function aPublicKey(): string {
  return getPublicKey(generateSecretKey());
}

describe("an Operator recording a User's Nostr key", () => {
  it("records it inside the Operator's own transaction, and loses it when that rolls back", async () => {
    const userId = await admit();
    const publicKey = aPublicKey();

    await assert.rejects(
      () =>
        db.tx(async (tx) => {
          await channel.recordPublicKey(tx, userId, publicKey);
          throw new Error("the Operator changed their mind");
        }),
      { message: "the Operator changed their mind" },
    );
    assert.equal(await keyOf(userId), undefined);

    await db.tx((tx) => channel.recordPublicKey(tx, userId, publicKey));
    assert.equal(await keyOf(userId), publicKey);
  });

  it("refuses a User who does not exist, without abandoning the caller's transaction", async () => {
    const survivor = await admit();
    const missing = "00000000-0000-4000-8000-000000000000";

    await db.tx(async (tx) => {
      await assert.rejects(
        () => channel.recordPublicKey(tx, missing, aPublicKey()),
        NoSuchUserError,
      );
      await channel.recordPublicKey(tx, survivor, aPublicKey());
    });
    assert.notEqual(await keyOf(survivor), undefined);
  });

  it("refuses a key that already belongs to somebody else", async () => {
    const first = await admit();
    const second = await admit();
    const shared = aPublicKey();

    await db.tx((tx) => channel.recordPublicKey(tx, first, shared));
    await assert.rejects(
      () => db.tx((tx) => channel.recordPublicKey(tx, second, shared)),
      PublicKeyConflictError,
    );

    assert.equal(await keyOf(first), shared);
    assert.equal(await keyOf(second), undefined);
  });

  it("refuses a second key for a User who already has one", async () => {
    const userId = await admit();
    const original = aPublicKey();
    await db.tx((tx) => channel.recordPublicKey(tx, userId, original));

    await assert.rejects(
      () => db.tx((tx) => channel.recordPublicKey(tx, userId, aPublicKey())),
      PublicKeyConflictError,
    );
    assert.equal(await keyOf(userId), original);
  });

  it("refuses anything that is not a public key on the wire, rather than storing it", async () => {
    const userId = await admit();
    const secretKey = generateSecretKey();

    for (const wrong of [
      "npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9",
      getPublicKey(secretKey).toUpperCase(),
      `0x${getPublicKey(secretKey)}`,
      "",
    ]) {
      await assert.rejects(
        () => db.tx((tx) => channel.recordPublicKey(tx, userId, wrong)),
        MalformedPublicKeyError,
      );
    }
    assert.equal(await keyOf(userId), undefined);
  });
});

describe("what the Nostr Channel exposes, and what it deliberately does not", () => {
  it("carries no method but the one that records a key, and no route plugin", async () => {
    assert.deepEqual(Object.keys(channel).sort(), [
      "drain",
      "name",
      "publicKey",
      "recordPublicKey",
      "send",
      "start",
      "stop",
    ]);
    assert.equal(channel.name, "nostr");
  });

  it("puts no route on either server, so no request anywhere can record a key", async () => {
    const publicServer = Fastify();
    const agentServer = Fastify();
    const registered = routesOf(publicServer, agentServer);

    const log = createMessenger({ db, users, worker, agentServer: { fastify: agentServer } });
    createNostrChannel({
      db,
      messenger: log,
      users,
      secretKey: generateSecretKey(),
      relayUrl: unreachable,
      logger: silent,
    });
    await publicServer.ready();
    await agentServer.ready();

    assert.deepEqual(registered.public, []);
    assert.equal(registered.agent.length > 0, true);
    for (const route of registered.agent) {
      assert.equal(route.startsWith("/messages"), true, `${route} is not the Messenger's`);
    }
  });
});

function routesOf(
  publicServer: FastifyInstance,
  agentServer: FastifyInstance,
): { readonly public: string[]; readonly agent: string[] } {
  const collected = { public: [] as string[], agent: [] as string[] };
  publicServer.addHook("onRoute", (route) => void collected.public.push(route.url));
  agentServer.addHook("onRoute", (route) => void collected.agent.push(route.url));
  return collected;
}
