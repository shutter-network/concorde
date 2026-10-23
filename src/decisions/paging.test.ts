import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import { createPasswordAuth } from "../password-auth/password-auth.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import type { ScryptParameters } from "../password-auth/secrets.ts";
import { limitSchema } from "../route-conventions.ts";
import { createSignatures } from "../signatures/index.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers } from "../users/users.ts";
import { createDecisions, type DecisionRecord } from "./decisions.ts";
import * as decisionsSchema from "./schema/index.ts";

let database: TestDatabase;
let db: Db;
let agentServer: ServerComponent<FastifyInstance>;
let publicServer: ServerComponent<FastifyInstance>;

const prefix = "/decisions";
const auth = "/auth";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

const password = "correct horse battery staple";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const committed = [
  "we will ship on the first of the month",
  "we will not ship anything unreviewed",
  "we will keep the Gateway trusted and say so",
  "we will publish a reversal rather than edit one",
  "we will answer within a day",
  "we will not read a Message we were not sent",
  "we will hold to all of the above in writing",
] as const;

const page = 3;

let token: string;

before(async () => {
  database = await createTestDatabase("decisions_paging");
  db = database.db;

  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);

  const users = createUsers({ db, agentServer, publicServer });
  const passwordAuth = createPasswordAuth({
    db,
    users,
    publicServer,
    tokenTtl: hour,
    scrypt: cheap,
  });
  const { privateKey } = generateKeyPairSync("ed25519");
  const signatures = createSignatures({
    signingKey: privateKey,
    agentServer,
    publicServer,
    logger: silent,
  });
  createDecisions({ db, signatures, agentServer, publicServer });

  await applySchema(db, usersSchema, passwordAuthSchema, decisionsSchema);

  const created = await db.tx(async (tx) => {
    const user = await users.create(tx);
    await passwordAuth.setPassword(tx, user.id, password);
    return user;
  });
  const issued = await publicServer.fastify.inject({
    method: "POST",
    url: `${auth}/tokens`,
    payload: { user: created.id, password },
  });
  assert.equal(issued.statusCode, 201, `logging in should have answered: ${issued.body}`);
  token = issued.json<{ token: string }>().token;

  for (const statement of committed) {
    const published = await agentServer.fastify.inject({
      method: "POST",
      url: prefix,
      payload: { statement },
    });
    assert.equal(published.statusCode, 201, `publishing should have answered: ${published.body}`);
  }
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

describe("walking the log", () => {
  it("reconstructs it backwards and then forwards, exactly once each", async () => {
    const backwards = await walkBackwards();
    const forwards = await walkForwards();

    assert.deepEqual(backwards.map(numbers), [[1], [2, 3, 4], [5, 6, 7]]);
    assert.deepEqual(forwards.map(numbers), [[1, 2, 3], [4, 5, 6], [7]]);

    assert.deepEqual(
      backwards.flat().map((decision) => decision.statement),
      [...committed],
    );
    assert.deepEqual(backwards.flat(), forwards.flat());

    assert.deepEqual(backwards.flat(), await log(`?after=0&limit=${committed.length}`));
  });

  it("is the same walk for the agent, whose read is a User's with no Token wanted", async () => {
    for (const window of [`?limit=${page}`, "?before=5&limit=3", "?after=0&limit=3", "?after=6"]) {
      const theirs = await publicServer.fastify.inject({
        url: `${prefix}${window}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const agents = await agentServer.fastify.inject({ url: `${prefix}${window}` });
      assert.equal(agents.statusCode, 200, agents.body);
      assert.equal(agents.body, theirs.body, window);
    }
  });
});

describe("citing what the walk found", () => {
  it("answers each Decision to its own number, which is the same read once more", async () => {
    for (const decision of await log("?after=0")) {
      const cited = await publicServer.fastify.inject({
        url: `${prefix}/${decision.seq}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(cited.statusCode, 200, cited.body);
      assert.deepEqual(cited.json<DecisionRecord>(), decision);
    }
  });
});

describe("the cursor cases, and what a client is refused", () => {
  it("reads from the beginning with after=0, which no cursor does not", async () => {
    assert.deepEqual(numbers(await log(`?after=0&limit=${page}`)), [1, 2, 3]);
    assert.deepEqual(numbers(await log(`?limit=${page}`)), [5, 6, 7]);
    assert.deepEqual(numbers(await log(`?after=1&limit=${page}`)), [2, 3, 4]);

    assert.deepEqual(numbers(await log("?after=0")), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(numbers(await log("")), [1, 2, 3, 4, 5, 6, 7]);
  });

  it("scrolls back with before and forwards with after, both ascending", async () => {
    assert.deepEqual(numbers(await log("?before=4")), [1, 2, 3]);
    assert.deepEqual(numbers(await log("?before=4&limit=2")), [2, 3]);
    assert.deepEqual(numbers(await log("?before=1")), []);
    assert.deepEqual(numbers(await log("?after=5")), [6, 7]);
    assert.deepEqual(numbers(await log("?after=7")), []);
  });

  it("refuses two windows in one request, on both surfaces", async () => {
    for (const answered of [
      await reading("?after=1&before=7"),
      await asAgent("?after=1&before=7"),
    ]) {
      assert.equal(answered.statusCode, 400, answered.body);
      assert.match(answered.json<{ message: string }>().message, /two different windows/);
    }
  });

  it("caps the limit at the shared maximum rather than quietly reducing it", async () => {
    assert.equal((await reading(`?limit=${limitSchema.maximum}`)).statusCode, 200);
    assert.equal((await reading(`?limit=${limitSchema.maximum + 1}`)).statusCode, 400);
    for (const window of ["?limit=0", "?limit=none", "?after=-1", "?before=x"]) {
      assert.equal((await reading(window)).statusCode, 400, window);
    }

    for (const answered of [
      await reading("?after=2147483648"),
      await asAgent("?after=2147483648"),
    ]) {
      assert.equal(answered.statusCode, 400, answered.body);
      const { message } = answered.json<{ message: string }>();
      assert.match(message, /after/);
      assert.doesNotMatch(message, /select|from/i);
    }
  });

  it("refuses a parameter this log has no answer for", async () => {
    for (const window of ["?statement=ship", "?limt=2", "?user=someone", "?before=4&order=desc"]) {
      const refused = await reading(window);
      assert.equal(refused.statusCode, 400, window);
      assert.match(refused.json<{ message: string }>().message, /cannot be searched or filtered/);
    }
  });
});

async function walkBackwards(): Promise<DecisionRecord[][]> {
  const pages: DecisionRecord[][] = [];
  let window = `?limit=${page}`;
  for (;;) {
    const answered = await log(window);
    const oldest = answered[0];
    if (oldest === undefined) return pages;
    pages.unshift(answered);
    window = `?before=${oldest.seq}&limit=${page}`;
  }
}

async function walkForwards(): Promise<DecisionRecord[][]> {
  const pages: DecisionRecord[][] = [];
  let cursor = 0;
  for (;;) {
    const answered = await log(`?after=${cursor}&limit=${page}`);
    const newest = answered.at(-1);
    if (newest === undefined) return pages;
    pages.push(answered);
    cursor = newest.seq;
  }
}

async function log(window: string): Promise<DecisionRecord[]> {
  const answered = await reading(window);
  assert.equal(answered.statusCode, 200, `reading should have answered: ${answered.body}`);
  return answered.json<{ decisions: DecisionRecord[] }>().decisions;
}

function reading(window: string) {
  return publicServer.fastify.inject({
    url: `${prefix}${window}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function asAgent(window: string) {
  return agentServer.fastify.inject({ url: `${prefix}${window}` });
}

function numbers(decisions: readonly DecisionRecord[]): number[] {
  return decisions.map((decision) => decision.seq);
}
