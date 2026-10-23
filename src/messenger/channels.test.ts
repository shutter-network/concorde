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

function messenger(): Messenger {
  const agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  servers.push(agentServer);
  return createMessenger({ db, users, worker, agentServer });
}

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

async function admit(): Promise<string> {
  return (await db.tx((tx) => users.create(tx))).id;
}

describe("a Messenger and the one Channel registered with it", () => {
  it("refuses a second Channel, so a Message can only ever have travelled one way", async () => {
    const log = messenger();
    const first = recordingChannel("first");
    log.register(first);

    assert.throws(() => log.register(recordingChannel("second")), ChannelAlreadyRegisteredError);

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

    assert.deepEqual(carried, [sent]);
    assert.deepEqual(await log.history(userId), [sent]);
  });

  it("keeps the inbound write off the Messenger, so only a registered Channel can write one", async () => {
    const log = messenger();

    assert.deepEqual(Object.keys(log).sort(), ["history", "register", "send", "start", "stop"]);
    assert.equal("receive" in log, false);

    const handle = log.register(recordingChannel("inbound"));
    assert.deepEqual(Object.keys(handle), ["receive"]);

    const userId = await admit();
    const arrived = await db.tx((tx) => handle.receive(tx, userId, "a User said this"));
    assert.equal(arrived.direction, "inbound");
    assert.deepEqual(await log.history(userId), [arrived]);
  });

  it("names the HTTP Channel by its type, with no option to call it anything else", async () => {
    const log = messenger();
    const publicServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
    servers.push(publicServer);

    const channel = createHttpChannel({ db, messenger: log, publicServer });
    assert.equal(channel.name, "http");

    const userId = await admit();
    const sent = await db.tx((tx) => log.send(tx, userId, "poll for me"));
    assert.deepEqual(await log.history(userId), [sent]);
  });
});
