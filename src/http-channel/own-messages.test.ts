import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import type { MessageRecord } from "../messenger/messages.ts";
import { createMessenger } from "../messenger/messenger.ts";
import * as messengerSchema from "../messenger/schema/index.ts";
import { createPasswordAuth, type PasswordAuth } from "../password-auth/password-auth.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import type { ScryptParameters } from "../password-auth/secrets.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createHttpChannel } from "./http-channel.ts";

let database: TestDatabase;
let db: Db;
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

type Client = {
  readonly id: string;
  readonly token: string;
};

before(async () => {
  database = await createTestDatabase("http_messages_own");
  db = database.db;

  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);

  const worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {} });
  users = createUsers({ db, agentServer, publicServer });
  passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl: hour, scrypt: cheap });
  createHttpChannel({
    db,
    messenger: createMessenger({ db, users, worker, agentServer }),
    publicServer,
  });

  await applySchema(db, signalsSchema, usersSchema, passwordAuthSchema, messengerSchema);
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

async function admitted(): Promise<Client> {
  const created = await db.tx(async (tx) => {
    const user = await users.create(tx);
    await passwordAuth.setPassword(tx, user.id, password);
    return user;
  });
  return { id: created.id, token: await tokenFor(created.id) };
}

async function tokenFor(id: string, server = () => publicServer.fastify): Promise<string> {
  const issued = await server().inject({
    method: "POST",
    url: `${auth}/tokens`,
    payload: { user: id, password },
  });
  assert.equal(issued.statusCode, 201, `logging in should have answered: ${issued.body}`);
  return issued.json<{ token: string }>().token;
}

async function sent(userId: string, text: string): Promise<MessageRecord> {
  const response = await agentServer.fastify.inject({
    method: "POST",
    url: prefix,
    payload: { userId, text },
  });
  assert.equal(response.statusCode, 201, `sending should have answered: ${response.body}`);
  return response.json<MessageRecord>();
}

async function posted(token: string, text: string): Promise<MessageRecord> {
  const response = await publicServer.fastify.inject({
    method: "POST",
    url: prefix,
    headers: { authorization: `Bearer ${token}` },
    payload: { text },
  });
  assert.equal(response.statusCode, 201, `posting should have answered: ${response.body}`);
  return response.json<MessageRecord>();
}

function presenting(authorization: string | undefined, window = "") {
  return publicServer.fastify.inject({
    method: "GET",
    url: `${prefix}${window}`,
    headers: authorization === undefined ? {} : { authorization },
  });
}

function bearing(token: string, window = "") {
  return presenting(`Bearer ${token}`, window);
}

async function log(token: string, window = ""): Promise<MessageRecord[]> {
  const response = await bearing(token, window);
  assert.equal(response.statusCode, 200, `GET ${prefix} should have answered: ${response.body}`);
  return response.json<{ messages: MessageRecord[] }>().messages;
}

function numbers(messages: readonly MessageRecord[]): number[] {
  return messages.map((message) => message.seq);
}

const said = ["one", "two", "three", "four", "five", "six", "seven"];

async function withSeven(): Promise<Client> {
  const client = await admitted();
  for (const text of said) {
    await sent(client.id, text);
  }
  return client;
}

describe("a User reading their own Messages", () => {
  it("answers the newest page ascending, and the whole log whatever direction wrote it", async () => {
    const client = await admitted();
    const first = await sent(client.id, "what happened to the deploy?");

    assert.deepEqual(await log(client.token), [first]);
    assert.equal(first.userId, client.id);
    assert.equal(first.direction, "outbound");

    const answered = await posted(client.token, "it finished, thanks");
    assert.equal(answered.direction, "inbound");
    assert.deepEqual(await log(client.token), [first, answered]);
    assert.deepEqual(
      (await log(client.token)).map((message) => message.direction),
      ["outbound", "inbound"],
    );

    for (const text of ["and the migration?", "and the rollback?"]) {
      await sent(client.id, text);
    }
    assert.deepEqual(numbers(await log(client.token)), [1, 2, 3, 4]);
    assert.deepEqual(numbers(await log(client.token, "?limit=2")), [3, 4]);

    for (const window of [
      "?limit=0",
      "?limit=201",
      "?limit=none",
      "?after=-1",
      "?before=x",
      "?after=2147483648",
    ]) {
      assert.equal((await bearing(client.token, window)).statusCode, 400, window);
    }
  });

  it("walks backwards with before and forwards with after, and refuses both", async () => {
    const client = await withSeven();

    assert.deepEqual(numbers(await log(client.token, "?before=4")), [1, 2, 3]);
    assert.deepEqual(numbers(await log(client.token, "?before=4&limit=2")), [2, 3]);
    assert.deepEqual(numbers(await log(client.token, "?before=1")), []);
    assert.deepEqual(numbers(await log(client.token, "?after=5")), [6, 7]);
    assert.deepEqual(numbers(await log(client.token, "?after=7")), []);
    assert.deepEqual(numbers(await log(client.token, "?after=0")), [1, 2, 3, 4, 5, 6, 7]);

    const both = await bearing(client.token, "?after=1&before=7");
    assert.equal(both.statusCode, 400);
    assert.match(both.json<{ message: string }>().message, /two different windows/);
  });

  it("reconstructs a log longer than one page, walked backwards then forwards", async () => {
    const client = await withSeven();

    const backwards = await walkBackwards(client, 3);
    const forwards = await walkForwards(client, 3);

    assert.deepEqual(backwards.map(numbers), [[1], [2, 3, 4], [5, 6, 7]]);
    assert.deepEqual(forwards.map(numbers), [[1, 2, 3], [4, 5, 6], [7]]);

    assert.deepEqual(
      backwards.flat().map((message) => message.text),
      said,
    );
    assert.deepEqual(backwards.flat(), forwards.flat());
  });

  it("never answers with another User's Message, whatever is passed", async () => {
    const client = await withSeven();
    const other = await admitted();
    await sent(other.id, "meant for somebody else");

    for (const window of [`?user=${other.id}`, `?userId=${other.id}`, "?direction=inbound"]) {
      const refused = await bearing(client.token, window);
      assert.equal(refused.statusCode, 400, window);
      assert.match(refused.json<{ message: string }>().message, /read by cursor/);
    }

    assert.deepEqual(
      (await log(client.token)).map((message) => message.text),
      said,
    );
    assert.deepEqual(
      (await log(other.token)).map((message) => message.text),
      ["meant for somebody else"],
    );
  });

  it("refuses an unknown query parameter with this part's own sentence", async () => {
    const client = await withSeven();

    for (const window of ["?text=hello", "?limt=2", "?before=4&order=desc"]) {
      const refused = await bearing(client.token, window);
      assert.equal(refused.statusCode, 400, window);
      assert.match(refused.json<{ message: string }>().message, /cannot be searched or filtered/);
    }
  });
});

describe("an unauthenticated read", () => {
  it("is the single 401 of the Public server, however the Token is missing or refused", async () => {
    const client = await admitted();
    await sent(client.id, "not for a stranger");

    const briefly = serverComponent(Fastify(), nowhere);
    createPasswordAuth({ db, users, publicServer: briefly, tokenTtl: 1, scrypt: cheap });
    let expired: string;
    try {
      expired = await tokenFor(client.id, () => briefly.fastify);
    } finally {
      await briefly.stop();
    }

    const refusals = [
      await presenting(undefined),
      await presenting(`Basic ${Buffer.from(`${client.id}:${password}`).toString("base64")}`),
      await presenting(client.token),
      await presenting(`Bearer concorde_${"A".repeat(43)}`),
      await presenting(`Bearer ${expired}`),
      await presenting(`Bearer ${expired}`, "?after=0&limit=2"),
    ];

    for (const refused of refusals) {
      assert.equal(refused.statusCode, 401, refused.body);
      assert.deepEqual(refused.json(), {
        statusCode: 401,
        error: "Unauthorized",
        message: "authentication failed",
      });
    }

    const [first, ...rest] = refusals;
    assert.ok(first !== undefined);
    for (const refused of rest) {
      assert.equal(refused.body, first.body);
    }

    assert.equal((await bearing(client.token)).statusCode, 200);
  });

  it("answers a malformed request before it looks at a Token, as GET /users/me does", async () => {
    assert.equal((await presenting(undefined, "?text=hello")).statusCode, 400);
    assert.equal((await presenting(undefined, "?limit=201")).statusCode, 400);
  });
});

async function walkBackwards(client: Client, size: number): Promise<MessageRecord[][]> {
  const pages: MessageRecord[][] = [];
  let window = `?limit=${size}`;
  for (;;) {
    const page = await log(client.token, window);
    const oldest = page[0];
    if (oldest === undefined) return pages;
    pages.unshift(page);
    window = `?before=${oldest.seq}&limit=${size}`;
  }
}

async function walkForwards(client: Client, size: number): Promise<MessageRecord[][]> {
  const pages: MessageRecord[][] = [];
  let cursor = 0;
  for (;;) {
    const page = await log(client.token, `?after=${cursor}&limit=${size}`);
    const newest = page.at(-1);
    if (newest === undefined) return pages;
    pages.push(page);
    cursor = newest.seq;
  }
}
