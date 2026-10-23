import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, type JsonWebKey, verify } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import { createPasswordAuth } from "../password-auth/password-auth.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import type { ScryptParameters } from "../password-auth/secrets.ts";
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

let token: string;

before(async () => {
  database = await createTestDatabase("decisions_public");
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
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

describe("a User reading the log", () => {
  it("gets the same records the agent published, byte for byte", async () => {
    const published = await publish("the thing everybody gets to see");

    const read = await ownLog(`?after=${published.seq - 1}`);
    assert.deepEqual(read, [published]);

    const agentRead = await agentServer.fastify.inject({
      url: `${prefix}?after=${published.seq - 1}`,
    });
    assert.deepEqual(agentRead.json<{ decisions: DecisionRecord[] }>().decisions, read);
  });

  it("is refused without a Token, in the single 401 the Public server answers", async () => {
    for (const headers of [{}, { authorization: "Basic nope" }, { authorization: "Bearer nope" }]) {
      const refused = await publicServer.fastify.inject({ url: prefix, headers });
      assert.equal(refused.statusCode, 401, refused.body);
      assert.match(refused.json<{ message: string }>().message, /authentication failed/i);
    }
  });

  it("has no parameter naming a User, this log having no owner", async () => {
    const scoped = await publicServer.fastify.inject({
      url: `${prefix}?user=someone`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(scoped.statusCode, 400, scoped.body);
    assert.match(scoped.json<{ message: string }>().message, /"user" is not a parameter/);
  });
});

describe("a User citing a Decision by number", () => {
  it("fetches the one that was cited at them, and the agent's copy of it is identical", async () => {
    const published = await publish("the term somebody will quote by number");

    const cited = await citing(published.seq);
    assert.equal(cited.statusCode, 200, cited.body);
    assert.deepEqual(cited.json<DecisionRecord>(), published);

    const agents = await agentServer.fastify.inject({ url: `${prefix}/${published.seq}` });
    assert.equal(agents.body, cited.body);
  });

  it("is refused without a Token, in the same 401 the log read answers", async () => {
    const published = await publish("not for whoever found the port");

    const refused = await publicServer.fastify.inject({ url: `${prefix}/${published.seq}` });
    assert.equal(refused.statusCode, 401, refused.body);
    const log = await publicServer.fastify.inject({ url: prefix });
    assert.equal(refused.body, log.body);
  });

  it("gets the 404 and the 400 behind that Token, and not before it", async () => {
    const beyond = (await publish("the newest thing this file published")).seq + 1000;

    const missing = await citing(beyond);
    assert.equal(missing.statusCode, 404, missing.body);
    assert.deepEqual(missing.json(), {
      statusCode: 404,
      error: "Not Found",
      message: `no Decision ${beyond} exists`,
    });

    const word = await publicServer.fastify.inject({ url: `${prefix}/seven` });
    assert.equal(word.statusCode, 400, word.body);
  });
});

describe("a third party holding nothing but the public key", () => {
  it("checks a Decision without asking this Gateway whether it is real", async () => {
    const published = await publish("we will honour the terms as written");
    const [read] = await ownLog(`?after=${published.seq - 1}`);
    assert.ok(read !== undefined);

    const [header, payload, signature] = read.jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined, read.jws);

    for (const segment of [header, payload, signature]) {
      assert.match(segment, /^[A-Za-z0-9_-]+$/, read.jws);
    }
    assert.equal(Buffer.from(signature, "base64url").length, 64);

    assert.deepEqual(decoded(header), { alg: "EdDSA", typ: "concorde-decision+jws" });
    assert.deepEqual(decoded(payload), {
      seq: read.seq,
      createdAt: read.createdAt,
      statement: read.statement,
    });

    assert.equal(await checks(read.jws), true, "a Decision as published should verify");
  });

  it("catches a Decision somebody edited on the way", async () => {
    const published = await publish("the version that was actually committed to");
    const [header, payload, signature] = published.jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined);

    const edited = encoded({
      seq: published.seq,
      createdAt: published.createdAt,
      statement: "the version somebody would have preferred",
    });
    assert.equal(await checks(`${header}.${edited}.${signature}`), false);

    const renumbered = encoded({
      seq: published.seq + 1000,
      createdAt: published.createdAt,
      statement: published.statement,
    });
    assert.equal(await checks(`${header}.${renumbered}.${signature}`), false);

    const relabelled = encoded({ alg: "EdDSA", typ: "concorde-receipt+jws" });
    assert.equal(await checks(`${relabelled}.${payload}.${signature}`), false);
  });
});

async function publish(statement: string): Promise<DecisionRecord> {
  const answered = await agentServer.fastify.inject({
    method: "POST",
    url: prefix,
    payload: { statement },
  });
  assert.equal(answered.statusCode, 201, `publishing should have answered: ${answered.body}`);
  return answered.json<DecisionRecord>();
}

async function ownLog(window: string): Promise<DecisionRecord[]> {
  const answered = await publicServer.fastify.inject({
    url: `${prefix}${window}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(answered.statusCode, 200, `reading should have answered: ${answered.body}`);
  return answered.json<{ decisions: DecisionRecord[] }>().decisions;
}

function citing(seq: number) {
  return publicServer.fastify.inject({
    url: `${prefix}/${seq}`,
    headers: { authorization: `Bearer ${token}` },
  });
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

function decoded(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function encoded(claims: unknown): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}
