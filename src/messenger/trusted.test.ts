import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import { createHttpChannel } from "../http-channel/http-channel.ts";
import type { Logger } from "../logging/logging.ts";
import { createPasswordAuth, type PasswordAuth } from "../password-auth/password-auth.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import type { ScryptParameters } from "../password-auth/secrets.ts";
import type { SignalRecord } from "../signals/routes.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import type { MessageRecord } from "./messages.ts";
import { createMessenger, type Messenger } from "./messenger.ts";
import * as messengerSchema from "./schema/index.ts";

let database: TestDatabase;
let db: Db;
let messenger: Messenger;
let worker: SignalWorker;
let agentServer: ServerComponent<FastifyInstance>;
let publicServer: ServerComponent<FastifyInstance>;
let users: Users;
let passwordAuth: PasswordAuth;

const prefix = "/messages";
const auth = "/auth";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

const password = "correct horse battery staple";

const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

type Client = {
  readonly id: string;
  readonly token: string;
};

before(async () => {
  database = await createTestDatabase("http_messages_trusted");
  db = database.db;

  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);

  worker = createSignalWorker({
    db,
    runtime: fakeRuntime(),
    handlers: {},
    agentServer,
    logger: silent,
  });
  users = createUsers({ db, agentServer, publicServer });
  passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl: hour, scrypt: cheap });
  messenger = createMessenger({ db, users, worker, agentServer });
  createHttpChannel({ db, messenger, publicServer });

  await applySchema(db, signalsSchema, usersSchema, passwordAuthSchema, messengerSchema);
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await worker.stop();
  await database.drop();
});

async function admitted(): Promise<Client> {
  const { id } = await db.tx(async (tx) => {
    const user = await users.create(tx);
    await passwordAuth.setPassword(tx, user.id, password);
    return user;
  });

  const issued = await publicServer.fastify.inject({
    method: "POST",
    url: `${auth}/tokens`,
    payload: { user: id, password },
  });
  assert.equal(issued.statusCode, 201, `logging in should have answered: ${issued.body}`);
  return { id, token: issued.json<{ token: string }>().token };
}

async function posted(client: Client, text: string): Promise<MessageRecord> {
  const response = await publicServer.fastify.inject({
    method: "POST",
    url: prefix,
    headers: { authorization: `Bearer ${client.token}` },
    payload: { text },
  });
  assert.equal(response.statusCode, 201, `posting should have answered: ${response.body}`);
  return response.json<MessageRecord>();
}

async function own(client: Client, window = ""): Promise<MessageRecord[]> {
  const response = await publicServer.fastify.inject({
    method: "GET",
    url: `${prefix}${window}`,
    headers: { authorization: `Bearer ${client.token}` },
  });
  assert.equal(response.statusCode, 200, `GET ${prefix} should have answered: ${response.body}`);
  return response.json<{ messages: MessageRecord[] }>().messages;
}

async function asAgent(userId: string, window = ""): Promise<MessageRecord[]> {
  const response = await agentServer.fastify.inject({
    method: "GET",
    url: `${prefix}?user=${userId}${window.replace("?", "&")}`,
  });
  assert.equal(response.statusCode, 200, `the agent's read should have answered: ${response.body}`);
  return response.json<{ messages: MessageRecord[] }>().messages;
}

async function signals(kind: string): Promise<SignalRecord[]> {
  const response = await agentServer.fastify.inject({
    method: "GET",
    url: `/signals?kind=${kind}`,
  });
  assert.equal(response.statusCode, 200, `GET /signals should have answered: ${response.body}`);
  return response.json<{ signals: SignalRecord[] }>().signals;
}

function numbers(messages: readonly MessageRecord[]): number[] {
  return messages.map((message) => message.seq);
}

describe("a Handler sending a Message", () => {
  it("writes it inside its own transaction, and the User reads it back", async () => {
    const client = await admitted();

    const answered = await db.tx((tx) => messenger.send(tx, client.id, "the deploy finished"));

    assert.match(answered.id, /^[0-9a-f-]{36}$/);
    assert.equal(answered.userId, client.id);
    assert.equal(answered.direction, "outbound");
    assert.equal(answered.seq, 1);
    assert.equal(answered.text, "the deploy finished");
    assert.equal(new Date(answered.createdAt).toISOString(), answered.createdAt);

    assert.deepEqual(await own(client), [answered]);
    assert.deepEqual(await asAgent(client.id), [answered]);

    const replied = await posted(client, "thanks for letting me know");
    const again = await db.tx((tx) => messenger.send(tx, client.id, "and the migration ran"));
    assert.equal(replied.direction, "inbound");
    assert.deepEqual(numbers(await own(client)), [1, 2, 3]);
    assert.deepEqual(await own(client), [answered, replied, again]);
  });

  it("commits with the caller's own write, and a rollback loses both", async () => {
    const client = await admitted();

    const told = await db.tx(async (tx) => {
      const message = await messenger.send(tx, client.id, "that run failed, sorry");
      await worker.emit(tx, { kind: "run.reported", payload: { messageId: message.id } });
      return message;
    });

    assert.deepEqual(await own(client), [told]);
    assert.deepEqual(
      (await signals("run.reported")).map((signal) => signal.payload),
      [{ messageId: told.id }],
    );

    let attempted: MessageRecord | undefined;
    await assert.rejects(
      db.tx(async (tx) => {
        attempted = await messenger.send(tx, client.id, "that run failed too");
        await worker.emit(tx, { kind: "run.reported", payload: { messageId: attempted.id } });
        throw new Error("the Handler's own write failed");
      }),
      /the Handler's own write failed/,
    );

    assert.ok(attempted !== undefined, "the Message should have been written before the rollback");
    assert.deepEqual(await own(client), [told], "the Message should not have been sent");
    assert.deepEqual(
      (await signals("run.reported")).map((signal) => signal.payload),
      [{ messageId: told.id }],
      "the Handler's own write should have gone with it",
    );
  });

  it("answers with the record, which is what a caller cannot read back", async () => {
    const client = await admitted();

    const inside = await db.tx(async (tx) => {
      const message = await messenger.send(tx, client.id, "written but not committed");
      assert.deepEqual(await messenger.history(client.id), [], "the read is on another connection");
      assert.deepEqual(await own(client), [], "and so is the User's own route");
      return message;
    });

    assert.deepEqual(await messenger.history(client.id), [inside]);
    assert.deepEqual(await own(client), [inside]);
  });

  it("throws when No user has that id, rather than writing a row nobody can read", async () => {
    const client = await admitted();

    await assert.rejects(
      db.tx((tx) => messenger.send(tx, nobody, "into the void")),
      new RegExp(`No user ${nobody} exists`),
    );
    assert.deepEqual(await asAgent(nobody), [], "nothing should have been written for nobody");

    const carried = await db.tx(async (tx) => {
      await assert.rejects(messenger.send(tx, nobody, "into the void again"));
      await worker.emit(tx, { kind: "run.recovered", payload: { of: client.id } });
      return messenger.send(tx, client.id, "sent after a refusal in the same transaction");
    });

    assert.deepEqual(await own(client), [carried]);
    assert.equal((await signals("run.recovered")).length, 1);
  });
});

describe("a Handler reading a Message log", () => {
  async function withSeven(): Promise<Client> {
    const client = await admitted();
    await db.tx(async (tx) => {
      for (const text of ["one", "two", "three", "four", "five", "six", "seven"]) {
        await messenger.send(tx, client.id, text);
      }
    });
    return client;
  }

  it("answers the same records the two routes answer", async () => {
    const client = await withSeven();
    await posted(client, "eight, from me");

    for (const [window, asked] of [
      ["", {}],
      ["?limit=3", { limit: 3 }],
      ["?before=4", { before: 4 }],
      ["?before=4&limit=2", { before: 4, limit: 2 }],
      ["?after=5", { after: 5 }],
      ["?after=0&limit=100", { after: 0, limit: 100 }],
      ["?after=7", { after: 7 }],
      ["?before=1", { before: 1 }],
    ] as const) {
      const answered = await messenger.history(client.id, asked);
      assert.deepEqual(answered, await own(client, window), `the User's own read: ${window}`);
      assert.deepEqual(answered, await asAgent(client.id, window), `the agent's read: ${window}`);
    }

    assert.deepEqual(numbers(await messenger.history(client.id)), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(
      (await messenger.history(client.id, { limit: 2 })).map((message) => message.direction),
      ["outbound", "inbound"],
    );

    const other = await admitted();
    await db.tx((tx) => messenger.send(tx, other.id, "meant for somebody else"));
    assert.deepEqual(
      (await messenger.history(other.id)).map((message) => message.text),
      ["meant for somebody else"],
    );
  });

  it("is not capped at the limit the routes cap", async () => {
    const client = await admitted();
    const many = 201;
    await db.tx(async (tx) => {
      for (let each = 1; each <= many; each += 1) {
        await messenger.send(tx, client.id, `number ${each}`);
      }
    });

    const whole = await messenger.history(client.id, { limit: many });
    assert.equal(whole.length, many);
    assert.deepEqual(
      numbers(whole),
      Array.from({ length: many }, (_, index) => index + 1),
    );

    const byTheAgent = await agentServer.fastify.inject({
      method: "GET",
      url: `${prefix}?user=${client.id}&limit=${many}`,
    });
    assert.equal(byTheAgent.statusCode, 400, byTheAgent.body);
    const byTheUser = await publicServer.fastify.inject({
      method: "GET",
      url: `${prefix}?limit=${many}`,
      headers: { authorization: `Bearer ${client.token}` },
    });
    assert.equal(byTheUser.statusCode, 400, byTheUser.body);
  });

  it("defaults to the number the routes default to", async () => {
    const client = await admitted();
    await db.tx(async (tx) => {
      for (let each = 1; each <= 55; each += 1) {
        await messenger.send(tx, client.id, `number ${each}`);
      }
    });

    const page = await messenger.history(client.id);
    assert.equal(page.length, 50);
    assert.deepEqual(
      numbers(page),
      Array.from({ length: 50 }, (_, index) => index + 6),
    );
    assert.deepEqual(page, await own(client));
  });
});

describe("the object the constructor answers with", () => {
  it("carries a send and a read, and nothing that writes an inbound Message", async () => {
    assert.deepEqual(Object.keys(messenger).sort(), [
      "history",
      "register",
      "send",
      "start",
      "stop",
    ]);

    const client = await admitted();
    await db.tx((tx) => messenger.send(tx, client.id, "from a Handler"));
    await posted(client, "from the person");
    assert.deepEqual(
      (await messenger.history(client.id)).map((message) => message.direction),
      ["outbound", "inbound"],
    );
  });
});
