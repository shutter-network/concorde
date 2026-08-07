/**
 * Recording which Nostr public key belongs to which User: the whole of admission over this
 * medium, and the whole of what an injected prompt must not be able to do.
 *
 * Two claims are being made here and they pull in opposite directions, which is why they are
 * tested together. **An Operator can record a key from their own code**, in their own
 * transaction, and it proves nothing — the framework verifies nothing about it and cannot. And
 * **nothing else can record one**: there is no route on either server, so a prompt that talked the
 * agent into calling every capability it has still cannot claim a User's key and take over their
 * conversation
 * ([ADR-0049](../../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)).
 *
 * The refusals are the other subject. A key already recorded cannot be claimed by a second User,
 * and one User cannot hold two keys, because either would make "whose Message is this" ambiguous
 * in a component whose only authentication is a public key. Each is a constraint in the database
 * rather than a check in front of it, and each is asked for here.
 *
 * The rows are read directly, which is deliberate: "nothing was stored" has no other seam, and
 * the spec names a row that exists or does not as an observable. That a recorded key actually
 * admits a message is `receiving.test.ts`'s subject and is not repeated here.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
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
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import * as usersSchema from "../users/schema.ts";
import { createUsers, type Users } from "../users/users.ts";
import { MalformedPublicKeyError, NoSuchUserError, PublicKeyConflictError } from "./identities.ts";
import { createNostrChannel, type NostrChannel } from "./nostr-channel.ts";
import * as nostrChannelSchema from "./schema.ts";
import { nostrChannelTables, pubkeys } from "./schema.ts";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * A Relay address nothing answers on.
 *
 * Nothing in this file starts the Channel, and construction connects to nothing, so the address
 * is never dialled. A file about admission should not need a socket.
 */
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

  users = createUsers({ db, tokenTtl: 60 * 60 * 1000 });
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

/** A User admitted the way trusted code admits one, holding no Nostr key yet. */
async function admit(): Promise<string> {
  return (await db.tx((tx) => users.create(tx))).id;
}

/** The key recorded for one User, or `undefined`. The only place a row is read directly. */
async function keyOf(userId: string): Promise<string | undefined> {
  const rows = await db
    .handle(nostrChannelTables)
    .select({ pubkey: pubkeys.pubkey })
    .from(pubkeys)
    .where(eq(pubkeys.userId, userId));
  return rows[0]?.pubkey;
}

/** A public key in the form the wire uses, which is the only form this accepts. */
function aPublicKey(): string {
  return getPublicKey(generateSecretKey());
}

describe("an Operator recording a User's Nostr key", () => {
  it("records it inside the Operator's own transaction, and loses it when that rolls back", async () => {
    const userId = await admit();
    const publicKey = aPublicKey();

    // The transaction is the caller's, which is what makes recording a key and writing the
    // Operator's own note about why it was admitted one act. A rollback loses both.
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
      // The refusal ran in a savepoint, so this transaction is still usable and its later work
      // commits. Without that, a refusal would take the Operator's whole transaction with it.
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

    // The first User keeps it, and the second holds nothing: one key is one person's inbox, and
    // a second claimant would be reading their conversation.
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
    // Nothing was replaced either. There is no rotation here, in the same sense that there is
    // none for either of the agent's own identities.
    assert.equal(await keyOf(userId), original);
  });

  it("refuses anything that is not a public key on the wire, rather than storing it", async () => {
    const userId = await admit();
    const secretKey = generateSecretKey();

    // An `npub` is the form every tool prints and the one an Operator will reach for first. It
    // is refused at the call site because a stored one would be compared byte for byte against
    // the author of every decrypted message, match none of them, and leave a User who simply
    // never hears from the agent with nothing anywhere saying why.
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
    // The whole public surface of the object an Operator holds. `recordPublicKey` is the only
    // trusted-code method; everything else this component does, it does for the Relay or for the
    // Messenger. `drain` is the exception that proves it: a testing seam onto the half of a send
    // that happens after the commit, which a running deployment reaches by notification and never
    // by hand. A route plugin among these would be a door onto admission.
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

    // A whole deployment, built the way an Operator builds one: the Messenger with the agent's
    // own routes, and this Channel beside it. The Channel is handed neither server, and there is
    // no option on it for one — which is the mechanism, and this is the observation of it.
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

    // Nothing at all on the Public server: a User reaches this Channel through a Relay, so a
    // deployment running it has nothing of the Messenger's on the server Users can reach.
    assert.deepEqual(registered.public, []);
    // And on the Agent server, only the Messenger's own group. Every one of them is about the
    // log; none is about a key.
    assert.equal(registered.agent.length > 0, true);
    for (const route of registered.agent) {
      assert.equal(route.startsWith("/messages"), true, `${route} is not the Messenger's`);
    }
  });
});

/** Collects every route each server ends up with, from before anything is registered on either. */
function routesOf(
  publicServer: FastifyInstance,
  agentServer: FastifyInstance,
): { readonly public: string[]; readonly agent: string[] } {
  const collected = { public: [] as string[], agent: [] as string[] };
  publicServer.addHook("onRoute", (route) => void collected.public.push(route.url));
  agentServer.addHook("onRoute", (route) => void collected.agent.push(route.url));
  return collected;
}
