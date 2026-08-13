/**
 * The seam between the Messenger and the one Channel that reaches people.
 *
 * Everything here is asked of the two objects an Operator holds, with a Channel of this file's
 * own: a Channel is a public interface a deployment implements
 * ([ADR-0048](../../docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)), so
 * the one below is an Operator's Channel rather than a mock of anything internal. What it does is
 * record what it was handed, or refuse.
 *
 * Four claims, and each one is a thing an Operator or a User can observe:
 *
 *  - **A second Channel is refused**, so the configuration the design does not support is
 *    unrepresentable rather than subtly broken. One Channel per Messenger is why nothing records
 *    which Channel a Message travelled by.
 *  - **A Messenger with no Channel refuses to send**, and records nothing. A Message stored as
 *    sent that nothing will deliver is a durable claim that somebody was told something.
 *  - **A Channel that throws takes the Message with it.** `channel.send` runs inside the caller's
 *    transaction and everything knowable at send time is knowable there, so a refusal is a
 *    rollback and not a half-sent Message.
 *  - **The inbound write is only on what registration hands back.** There is no `receive` on the
 *    Messenger, so nothing but a registered Channel can put words in a User's log.
 *
 * A database of this file's own, because no two test files may share one. The Signal Worker is
 * constructed and never started: what an inbound Message wakes is `posted-messages.test.ts`'s
 * subject.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import type { Db } from "../db/index.ts";
import { type Component, serverComponent } from "../gateway/components.ts";
import { createHttpChannel } from "../http-channel/http-channel.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import type { MessageRecord } from "./messages.ts";
import {
  type Channel,
  ChannelAlreadyRegisteredError,
  createMessenger,
  type Messenger,
  NoChannelError,
} from "./messenger.ts";
import * as messengerSchema from "./schema/index.ts";

let database: TestDatabase;
let db: Db;
let users: Users;
let worker: SignalWorker;
/** A server per Messenger, because each one registers a plugin at the same path on it. */
let servers: Component[];

before(async () => {
  database = await createTestDatabase("messenger_channels");
  db = database.db;
  servers = [];

  worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {} });
  users = createUsers({ db });

  await applySchema(db, signalsSchema, usersSchema, messengerSchema);
});

after(async () => {
  for (const server of servers) await server.stop();
  await database.drop();
});

/**
 * A Messenger of its own, on a server of its own.
 *
 * One per test, because `register` is a one-shot and a Messenger shared between tests would
 * carry the first one's Channel into the second.
 */
function messenger(): Messenger {
  const agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  servers.push(agentServer);
  return createMessenger({ db, users, worker, agentServer });
}

/**
 * A Channel an Operator could have written: it remembers what it was handed, or refuses.
 *
 * `name` is a constant of the type, exactly as the HTTP Channel's is, so there is no
 * construction option for it here either.
 */
function recordingChannel(name: string, refusal?: Error): Channel & { readonly carried: string[] } {
  const carried: string[] = [];
  return {
    name,
    carried,
    send: async (_tx, message) => {
      if (refusal !== undefined) throw refusal;
      carried.push(message.text);
    },
    start: async () => {},
    stop: async () => {},
  };
}

/** A User to send to, admitted the way trusted code admits one. */
async function admit(): Promise<string> {
  return (await db.tx((tx) => users.create(tx))).id;
}

describe("a Messenger and the one Channel registered with it", () => {
  it("refuses a second Channel, so a Message can only ever have travelled one way", async () => {
    const log = messenger();
    const first = recordingChannel("first");
    log.register(first);

    assert.throws(() => log.register(recordingChannel("second")), ChannelAlreadyRegisteredError);

    // And the refusal was total: the Messenger still holds the first, so a send goes there and
    // nowhere else. A registration that had half-succeeded would be worse than one that threw.
    const userId = await admit();
    await db.tx((tx) => log.send(tx, userId, "to the first Channel"));
    assert.deepEqual(first.carried, ["to the first Channel"]);
  });

  it("refuses to send with no Channel registered, and records nothing", async () => {
    const log = messenger();
    const userId = await admit();

    await assert.rejects(
      () => db.tx((tx) => log.send(tx, userId, "nobody carries this")),
      NoChannelError,
    );

    // The point of the refusal: a Message recorded as sent is a durable claim that somebody was
    // told something, and there is nothing here that could have told them.
    assert.deepEqual(await log.history(userId), []);
  });

  it("loses the Message when the Channel refuses it, rather than recording a half-sent one", async () => {
    const log = messenger();
    log.register(recordingChannel("refusing", new Error("the relay said no")));
    const userId = await admit();

    await assert.rejects(() => db.tx((tx) => log.send(tx, userId, "never handed over")), {
      message: "the relay said no",
    });

    assert.deepEqual(await log.history(userId), []);
  });

  it("hands the Channel the Message as it was stored, numbered and all", async () => {
    const log = messenger();
    const carried: MessageRecord[] = [];
    log.register({
      name: "carrying",
      send: async (_tx, message) => void carried.push(message),
      start: async () => {},
      stop: async () => {},
    });
    const userId = await admit();

    const sent = await db.tx((tx) => log.send(tx, userId, "the deploy finished"));

    // The same record the caller got back, `seq` included: a Channel addressing somebody has
    // everything the log has, and nothing has to be read back to get it.
    assert.deepEqual(carried, [sent]);
    assert.deepEqual(await log.history(userId), [sent]);
  });

  it("keeps the inbound write off the Messenger, so only a registered Channel can write one", async () => {
    const log = messenger();

    // The whole of what an Operator holds. `receive` is not among it and cannot be: it exists
    // only on the object `register` answers with, so a Signal Handler, an entry point and an
    // injected prompt alike have no way to write a Message as if a User had sent it.
    assert.deepEqual(Object.keys(log).sort(), ["history", "register", "send", "start", "stop"]);
    assert.equal("receive" in log, false);

    const handle = log.register(recordingChannel("inbound"));
    assert.deepEqual(Object.keys(handle), ["receive"]);

    // And it writes an inbound Message, which is the other half of the same claim.
    const userId = await admit();
    const arrived = await db.tx((tx) => handle.receive(tx, userId, "a User said this"));
    assert.equal(arrived.direction, "inbound");
    assert.deepEqual(await log.history(userId), [arrived]);
  });

  it("names the HTTP Channel by its type, with no option to call it anything else", async () => {
    const log = messenger();
    const publicServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
    servers.push(publicServer);

    // There is no `name` in these options, and there is nowhere else to put one: the name is a
    // constant of the Channel's type, which is what makes it useless to lie about.
    const channel = createHttpChannel({ db, messenger: log, publicServer });
    assert.equal(channel.name, "http");

    // And its `send` is the no-op the type argues for, because HTTP delivery is the User asking:
    // an outbound Message is in the log, and the next poll carries it.
    const userId = await admit();
    const sent = await db.tx((tx) => log.send(tx, userId, "poll for me"));
    assert.deepEqual(await log.history(userId), [sent]);
  });
});
