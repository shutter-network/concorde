import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import { createHttpChannel } from "../http-channel/http-channel.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeAuth } from "../test-support/fake-auth.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import type { MessageRecord } from "./messages.ts";
import { createMessenger } from "./messenger.ts";
import * as messengerSchema from "./schema/index.ts";

let database: TestDatabase;
let db: Db;
let agentServer: ServerComponent<FastifyInstance>;
let publicServer: ServerComponent<FastifyInstance>;
let directory: Users;

const prefix = "/messages";

const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

before(async () => {
  database = await createTestDatabase("http_messages");
  db = database.db;

  agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  publicServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });

  const worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {} });
  directory = createUsers({ db, agentServer });
  publicServer.registerAuth(fakeAuth("Bearer"));
  createHttpChannel({
    db,
    messenger: createMessenger({ db, users: directory, worker, agentServer }),
    publicServer,
  });

  await applySchema(db, signalsSchema, usersSchema, messengerSchema);
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

async function admitted(): Promise<string> {
  return (await db.tx((tx) => directory.create(tx))).id;
}

function post(payload: Record<string, unknown>) {
  return agentServer.fastify.inject({ method: "POST", url: prefix, payload });
}

function read(query: string) {
  return agentServer.fastify.inject({ method: "GET", url: `${prefix}${query}` });
}

async function sent(userId: string, text: string): Promise<MessageRecord> {
  const response = await post({ userId, text });
  assert.equal(response.statusCode, 201, `POST ${prefix} should have answered: ${response.body}`);
  return response.json<MessageRecord>();
}

async function log(userId: string, window = ""): Promise<MessageRecord[]> {
  const response = await read(`?user=${userId}${window}`);
  assert.equal(response.statusCode, 200, `GET ${prefix} should have answered: ${response.body}`);
  return response.json<{ messages: MessageRecord[] }>().messages;
}

function numbers(messages: readonly MessageRecord[]): number[] {
  return messages.map((message) => message.seq);
}

describe("sending a Message to a User over the Agent server", () => {
  it("stores it, numbers it from 1, and answers with what the read answers with", async () => {
    const user = await admitted();
    const message = await sent(user, "what happened to the deploy?");

    assert.match(message.id, /^[0-9a-f-]{36}$/);
    assert.equal(message.userId, user);
    assert.equal(message.direction, "outbound");
    assert.equal(message.seq, 1);
    assert.equal(message.text, "what happened to the deploy?");
    assert.equal(new Date(message.createdAt).toISOString(), message.createdAt);

    assert.deepEqual(await log(user), [message]);
  });

  it("answers 404 for a well-formed uuid naming no User, and writes nothing", async () => {
    const refused = await post({ userId: nobody, text: "are you there?" });
    assert.equal(refused.statusCode, 404);
    assert.deepEqual(refused.json(), {
      statusCode: 404,
      error: "Not Found",
      message: `No user ${nobody} exists`,
    });

    assert.deepEqual(await log(nobody), []);
  });

  it("answers 400 for a malformed uuid, rather than a 500 out of PostgreSQL", async () => {
    assert.equal((await post({ userId: "not-an-id", text: "hello" })).statusCode, 400);
    assert.equal((await read("?user=not-an-id")).statusCode, 400);
  });

  it("refuses an empty text, and honours no direction the caller asks for", async () => {
    const user = await admitted();
    assert.equal((await post({ userId: user, text: "" })).statusCode, 400);

    const message = await post({ userId: user, text: "not from you", direction: "inbound" });
    assert.equal(message.statusCode, 201);
    assert.equal(message.json<MessageRecord>().direction, "outbound");
  });
});

describe("numbering a User's Messages", () => {
  it("numbers each User's log independently from 1", async () => {
    const one = await admitted();
    const other = await admitted();

    assert.equal((await sent(one, "first to one")).seq, 1);
    assert.equal((await sent(other, "first to the other")).seq, 1);
    assert.equal((await sent(one, "second to one")).seq, 2);
    assert.equal((await sent(other, "second to the other")).seq, 2);

    assert.deepEqual(numbers(await log(one)), [1, 2]);
    assert.deepEqual(numbers(await log(other)), [1, 2]);
  });

  it("gives concurrent sends distinct, gapless numbers", async () => {
    const user = await admitted();
    const at = ["one", "two", "three", "four", "five"];
    const sends = await Promise.all(at.map((which) => sent(user, `all at once: ${which}`)));

    assert.deepEqual(
      numbers(sends).sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
    );
    const stored = await log(user);
    assert.deepEqual(numbers(stored), [1, 2, 3, 4, 5]);
    assert.deepEqual(
      stored.map((message) => message.text).sort(),
      at.map((which) => `all at once: ${which}`).sort(),
    );
  });
});

describe("reading a User's Message log over the Agent server", () => {
  async function withFour(): Promise<string> {
    const user = await admitted();
    for (const which of ["first", "second", "third", "fourth"]) {
      await sent(user, which);
    }
    return user;
  }

  it("answers the newest page ascending, under a capped limit", async () => {
    const user = await withFour();
    assert.deepEqual(numbers(await log(user)), [1, 2, 3, 4]);
    assert.deepEqual(numbers(await log(user, "&limit=2")), [3, 4]);

    for (const window of [
      "&limit=0",
      "&limit=201",
      "&limit=none",
      "&after=-1",
      "&before=x",
      "&after=2147483648",
    ]) {
      assert.equal((await read(`?user=${user}${window}`)).statusCode, 400, window);
    }
  });

  it("walks backwards with before and forwards with after, and refuses both", async () => {
    const user = await withFour();
    assert.deepEqual(numbers(await log(user, "&before=3")), [1, 2]);
    assert.deepEqual(numbers(await log(user, "&before=3&limit=1")), [2]);
    assert.deepEqual(numbers(await log(user, "&after=2")), [3, 4]);
    assert.deepEqual(numbers(await log(user, "&after=4")), []);
    assert.deepEqual(numbers(await log(user, "&after=0")), [1, 2, 3, 4]);

    const both = await read(`?user=${user}&after=1&before=4`);
    assert.equal(both.statusCode, 400);
    assert.match(both.json<{ message: string }>().message, /not both/);
  });

  it("requires a User, and refuses an unknown query parameter", async () => {
    const user = await withFour();
    assert.equal((await read("")).statusCode, 400);
    assert.equal((await read("?limit=2")).statusCode, 400);

    for (const query of ["&text=hello", "&direction=inbound", "&limt=2"]) {
      const refused = await read(`?user=${user}${query}`);
      assert.equal(refused.statusCode, 400, query);
      assert.match(refused.json<{ message: string }>().message, /Supports cursor paging/);
    }
  });

  it("never answers with another User's Message", async () => {
    const user = await withFour();
    const other = await admitted();
    await sent(other, "meant for somebody else");

    assert.deepEqual(
      (await log(user)).map((message) => message.text),
      ["first", "second", "third", "fourth"],
    );
    assert.deepEqual(
      (await log(other)).map((message) => message.text),
      ["meant for somebody else"],
    );
  });
});

describe("the Public server's plugin", () => {
  it("needs a Token to read and to post", async () => {
    const read = await publicServer.fastify.inject({ method: "GET", url: prefix });
    assert.equal(read.statusCode, 401, read.body);

    const posted = await publicServer.fastify.inject({
      method: "POST",
      url: prefix,
      payload: { text: "not from a User at all" },
    });
    assert.equal(posted.statusCode, 401, posted.body);
  });
});
