import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, type JsonWebKey, verify } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import { createPasswordAuth } from "../password-auth/password-auth.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import type { ScryptParameters } from "../password-auth/secrets.ts";
import type { SignalRecord } from "../signals/routes.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { createSignatures } from "../signatures/index.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers } from "../users/users.ts";
import { createDecisions, type DecisionRecord, type Decisions } from "./decisions.ts";
import * as decisionsSchema from "./schema/index.ts";

let database: TestDatabase;
let db: Db;
let decisions: Decisions;
let worker: SignalWorker;
let agentServer: ServerComponent<FastifyInstance>;
let publicServer: ServerComponent<FastifyInstance>;

const prefix = "/decisions";
const auth = "/auth";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

const password = "correct horse battery staple";

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let token: string;

before(async () => {
  database = await createTestDatabase("decisions_trusted");
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
  decisions = createDecisions({ db, signatures, agentServer, publicServer });

  await applySchema(db, signalsSchema, usersSchema, passwordAuthSchema, decisionsSchema);

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
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await worker.stop();
  await database.drop();
});

describe("a Handler publishing a Decision", () => {
  it("writes it inside its own transaction, and both surfaces read it back", async () => {
    const published = await db.tx((tx) => decisions.publish(tx, "we will ship on Friday"));

    assert.deepEqual(published, {
      seq: published.seq,
      statement: "we will ship on Friday",
      jws: published.jws,
      createdAt: published.createdAt,
    } satisfies DecisionRecord);
    assert.equal(typeof published.seq, "number");
    assert.equal(new Date(published.createdAt).toISOString(), published.createdAt);

    const window = `?after=${published.seq - 1}`;
    assert.deepEqual(await asAgent(window), [published]);
    assert.deepEqual(await ownLog(window), [published]);

    assert.equal(await checks(published.jws), true, "a published Decision should verify");
    assert.deepEqual(payloadOf(published.jws), {
      seq: published.seq,
      createdAt: published.createdAt,
      statement: published.statement,
    });
  });

  it("commits with the caller's own write, and a rollback loses both", async () => {
    const committed = await db.tx(async (tx) => {
      const decision = await decisions.publish(tx, "we will refund everybody affected");
      await worker.emit(tx, { kind: "decision.recorded", payload: { seq: decision.seq } });
      return decision;
    });

    assert.deepEqual(await asAgent(`?after=${committed.seq - 1}`), [committed]);
    assert.deepEqual(
      (await signals("decision.recorded")).map((signal) => signal.payload),
      [{ seq: committed.seq }],
    );

    let attempted: DecisionRecord | undefined;
    await assert.rejects(
      db.tx(async (tx) => {
        attempted = await decisions.publish(tx, "we will refund everybody twice");
        await worker.emit(tx, { kind: "decision.recorded", payload: { seq: attempted.seq } });
        throw new Error("the Handler's own write failed");
      }),
      /the Handler's own write failed/,
    );

    assert.ok(attempted !== undefined, "the Decision should have been written before the rollback");
    assert.deepEqual(
      await asAgent(`?after=${attempted.seq - 1}`),
      [],
      "the Decision should not have been published",
    );
    assert.deepEqual(
      (await signals("decision.recorded")).map((signal) => signal.payload),
      [{ seq: committed.seq }],
      "the Handler's own write should have gone with it",
    );

    const next = await db.tx((tx) => decisions.publish(tx, "and the log carries on"));
    assert.ok(next.seq > attempted.seq, "a rolled-back publish burns its number");

    const burned = await publicServer.fastify.inject({
      url: `${prefix}/${attempted.seq}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(burned.statusCode, 404, burned.body);
    assert.equal(
      (await agentServer.fastify.inject({ url: `${prefix}/${attempted.seq}` })).statusCode,
      404,
    );
    const carried = await agentServer.fastify.inject({ url: `${prefix}/${next.seq}` });
    assert.deepEqual(carried.json<DecisionRecord>(), next);
  });

  it("answers with the record, which is what a caller cannot read back", async () => {
    const inside = await db.tx(async (tx) => {
      const decision = await decisions.publish(tx, "written but not committed");
      const window = `?after=${decision.seq - 1}`;
      assert.deepEqual(
        await decisions.history({ after: decision.seq - 1 }),
        [],
        "the read is on another connection",
      );
      assert.deepEqual(await asAgent(window), [], "and so is the agent's own route");
      return decision;
    });

    assert.deepEqual(await decisions.history({ after: inside.seq - 1 }), [inside]);
    assert.deepEqual(await asAgent(`?after=${inside.seq - 1}`), [inside]);
  });
});

describe("a Handler reading the Decision log", () => {
  it("answers the same records the two routes answer", async () => {
    const from = await mark();
    await db.tx(async (tx) => {
      for (const statement of ["one", "two", "three"]) {
        await decisions.publish(tx, statement);
      }
    });
    const [first, second, third] = await decisions.history({ after: from });
    assert.ok(first !== undefined && second !== undefined && third !== undefined);

    for (const [window, asked] of [
      ["", {}],
      ["?limit=3", { limit: 3 }],
      [`?before=${third.seq}&limit=2`, { before: third.seq, limit: 2 }],
      [`?after=${first.seq}&limit=2`, { after: first.seq, limit: 2 }],
      [`?after=${from}`, { after: from }],
      [`?after=${third.seq}`, { after: third.seq }],
    ] as const) {
      const answered = await decisions.history(asked);
      assert.deepEqual(answered, await asAgent(window), `the agent's read: ${window}`);
      assert.deepEqual(answered, await ownLog(window), `a User's read: ${window}`);
    }

    assert.deepEqual(numbers(await decisions.history({ after: from })), [
      first.seq,
      second.seq,
      third.seq,
    ]);
    assert.deepEqual(numbers(await decisions.history({ before: third.seq, limit: 2 })), [
      first.seq,
      second.seq,
    ]);
  });

  it("is not capped at the limit the routes cap", async () => {
    const from = await mark();
    const many = 201;
    await db.tx(async (tx) => {
      for (let each = 1; each <= many; each += 1) {
        await decisions.publish(tx, `number ${each}`);
      }
    });

    const whole = await decisions.history({ after: from, limit: many });
    assert.equal(whole.length, many);
    assert.deepEqual(
      whole.map((decision) => decision.statement),
      Array.from({ length: many }, (_, index) => `number ${index + 1}`),
    );

    const byTheAgent = await agentServer.fastify.inject({ url: `${prefix}?limit=${many}` });
    assert.equal(byTheAgent.statusCode, 400, byTheAgent.body);
    const byTheUser = await publicServer.fastify.inject({
      url: `${prefix}?limit=${many}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(byTheUser.statusCode, 400, byTheUser.body);
  });

  it("defaults to the number the routes default to", async () => {
    const page = await decisions.history();

    assert.equal(page.length, 50);
    assert.deepEqual(page, await asAgent(""));
    assert.deepEqual(page, await ownLog(""));
  });
});

describe("the object the constructor answers with", () => {
  it("carries a publish and a read, and nothing that names a User or takes an artifact", async () => {
    assert.deepEqual(Object.keys(decisions).sort(), ["history", "publish", "start", "stop"]);

    assert.equal(decisions.publish.length, 2);

    const published = await db.tx((tx) => decisions.publish(tx, "signed by us or not at all"));
    assert.equal(await checks(published.jws), true);
  });
});

async function mark(): Promise<number> {
  const [newest] = await decisions.history({ limit: 1 });
  return newest?.seq ?? 0;
}

async function asAgent(window: string): Promise<DecisionRecord[]> {
  const answered = await agentServer.fastify.inject({ url: `${prefix}${window}` });
  assert.equal(answered.statusCode, 200, `the agent's read should have answered: ${answered.body}`);
  return answered.json<{ decisions: DecisionRecord[] }>().decisions;
}

async function ownLog(window: string): Promise<DecisionRecord[]> {
  const answered = await publicServer.fastify.inject({
    url: `${prefix}${window}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(answered.statusCode, 200, `a User's read should have answered: ${answered.body}`);
  return answered.json<{ decisions: DecisionRecord[] }>().decisions;
}

async function signals(kind: string): Promise<SignalRecord[]> {
  const answered = await agentServer.fastify.inject({ url: `/signals?kind=${kind}` });
  assert.equal(answered.statusCode, 200, `GET /signals should have answered: ${answered.body}`);
  return answered.json<{ signals: SignalRecord[] }>().signals;
}

function numbers(page: readonly DecisionRecord[]): number[] {
  return page.map((decision) => decision.seq);
}

async function checks(jws: string): Promise<boolean> {
  const answered = await publicServer.fastify.inject({ url: "/jwks.json" });
  assert.equal(answered.statusCode, 200, answered.body);
  const [key] = answered.json<{ keys: JsonWebKey[] }>().keys;
  assert.ok(key !== undefined, answered.body);

  const [header, payload, signature] = jws.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return false;
  return verify(
    null,
    Buffer.from(`${header}.${payload}`, "utf8"),
    createPublicKey({ key, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
}

function payloadOf(jws: string): unknown {
  const [, payload] = jws.split(".");
  return JSON.parse(Buffer.from(String(payload), "base64url").toString("utf8"));
}
