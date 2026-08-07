/**
 * A User reading the Decision log, and then checking one **without trusting the Gateway** —
 * which is the whole reason the feature exists and the only beat in it that a document cannot
 * make.
 *
 * The subject is what a person's own client sees: every assertion here is made over HTTP
 * against two real Fastify instances and real PostgreSQL, **nothing inserts a row directly**,
 * and every Token is bought with a real password at the Users component's own login route,
 * because a Token minted any other way would be testing a shortcut this surface does not have.
 *
 * The last suite is the demoable one and it is written as the third party would: it holds the
 * key set fetched over HTTP with no Token, the artifact fetched over HTTP with one, and
 * **nothing else** — no `KeyObject` this file constructed, no header or payload of its own
 * rebuilt from the record, and no `jose`. The oracle is `node:crypto`, because `jose` is what
 * signs, and the signing input is reconstructed by splitting the emitted string, which is what
 * catches signing bytes that are not the bytes that were stored (ADR-0042).
 *
 * A database of this file's own, because no two test files may share one, and a deliberately
 * cheap scrypt cost, because every Token here starts with a login.
 */

import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, type JsonWebKey, verify } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type Component, serverComponent } from "../gateway/components.ts";
import { createSignatures } from "../signatures/index.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import type { UserRecord } from "../users/routes.ts";
import * as usersSchema from "../users/schema.ts";
import type { ScryptParameters } from "../users/secrets.ts";
import { createUsers } from "../users/users.ts";
import { createDecisions, type DecisionRecord } from "./decisions.ts";
import * as decisionsSchema from "./schema.ts";

let database: TestDatabase;
let db: Db;
let agentServer: Component & { readonly fastify: FastifyInstance };
let publicServer: Component & { readonly fastify: FastifyInstance };

/** Where the constructor put both route groups, and the login route of Users. */
const prefix = "/decisions";
const auth = "/auth";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

/**
 * A cost nobody should deploy, so that a file full of logins runs in a moment.
 *
 * Legitimate because each digest carries the parameters it was written under: this is a
 * construction-time number and not a property of the schema (ADR-0030).
 */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

/** The one password in this file. Nothing here is about what a good password is. */
const password = "correct horse battery staple";

/** A logger with nothing to say: one line per signing is `signatures.test.ts`'s subject. */
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** The Token this file reads with, bought at the real login route in `before`. */
let token: string;

before(async () => {
  database = await createTestDatabase("decisions_public");
  db = database.db;

  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);

  // No Signal Worker anywhere in this file, and that is worth noticing rather than reading as
  // an omission: neither part here is a Producer and neither holds one, so unlike every
  // messaging suite there is nothing to construct and nothing that could wake (ADR-0043).
  const users = createUsers({ db, tokenTtl: hour, scrypt: cheap, agentServer, publicServer });
  // The keypair is generated here, which is where a keypair may be generated: the framework
  // generates none, because a fresh key per restart leaves every artifact ever published
  // unverifiable with nothing saying so (ADR-0041).
  const { privateKey } = generateKeyPairSync("ed25519");
  const signatures = createSignatures({
    signingKey: privateKey,
    agentServer,
    publicServer,
    users,
    logger: silent,
  });
  createDecisions({ db, signatures, users, agentServer, publicServer });

  await applySchema(db, usersSchema, decisionsSchema);

  const created = await agentServer.fastify.inject({
    method: "POST",
    url: "/users",
    payload: { password },
  });
  assert.equal(created.statusCode, 201, `admitting a User should have answered: ${created.body}`);
  const issued = await publicServer.fastify.inject({
    method: "POST",
    url: `${auth}/tokens`,
    payload: { user: created.json<UserRecord>().id, password },
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

    // The same record, from two surfaces, with nothing scoping either: the agent's read and a
    // User's are one query, and the two route groups differ only in whether an auth hook ran
    // (ADR-0043). Compared whole, so a field declared in one response schema and forgotten in
    // the other differs here.
    const read = await ownLog(`?after=${published.seq - 1}`);
    assert.deepEqual(read, [published]);

    const agentRead = await agentServer.fastify.inject({
      url: `${prefix}?after=${published.seq - 1}`,
    });
    assert.deepEqual(agentRead.json<{ decisions: DecisionRecord[] }>().decisions, read);
  });

  it("is refused without a Token, in the single 401 of Users", async () => {
    // This part authenticates nobody: the hook belongs to Users, taken as one option on the
    // route, so a missing header, a header in another scheme, an unknown Token and an expired
    // one are one status and one message (ADR-0030).
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
    // What a citation is for: somebody quotes "Decision 7" and the number is the whole of what
    // the reader needs. Compared whole against both surfaces, because the log is global and the
    // two reads are one query with nothing to scope (ADR-0043).
    const published = await publish("the term somebody will quote by number");

    const cited = await citing(published.seq);
    assert.equal(cited.statusCode, 200, cited.body);
    assert.deepEqual(cited.json<DecisionRecord>(), published);

    const agents = await agentServer.fastify.inject({ url: `${prefix}/${published.seq}` });
    assert.equal(agents.body, cited.body);
  });

  it("is refused without a Token, in the same 401 the log read answers", async () => {
    const published = await publish("not for whoever found the port");

    // The Gateway is not a public bulletin board: a Decision is public because a *User* takes
    // one away and hands it on, not because a stranger can fetch one (ADR-0043). The refusal is
    // the Users component's, so it is byte for byte the one the log read answers with.
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

    // A word rather than a number, which is a 400 and not a 500, and which is answered before
    // the Token is looked at: validation runs at `preValidation` and `requireUser` at
    // `preHandler`, the order every other Public route already answers in. That leaks nothing,
    // a refusal about a path naming no User.
    const word = await publicServer.fastify.inject({ url: `${prefix}/seven` });
    assert.equal(word.statusCode, 400, word.body);
  });
});

describe("a third party holding nothing but the public key", () => {
  it("checks a Decision without asking this Gateway whether it is real", async () => {
    // The demoable end of the whole feature. Everything below comes off a wire: the artifact
    // over the Public server with a Token, the key over the same server with none. Nothing
    // here holds the `KeyObject` the Gateway was constructed with, and nothing here calls
    // `jose`.
    const published = await publish("we will honour the terms as written");
    const [read] = await ownLog(`?after=${published.seq - 1}`);
    assert.ok(read !== undefined);

    const [header, payload, signature] = read.jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined, read.jws);

    // Base64url and not base64, which is what makes the artifact URL-safe and is what lets a
    // Party paste one into a bug report, an email or a URL without it arriving mangled.
    for (const segment of [header, payload, signature]) {
      assert.match(segment, /^[A-Za-z0-9_-]+$/, read.jws);
    }
    // Exactly 64 bytes for Ed25519 (RFC 8037), which is the shape every other library on
    // earth insists on and a self-consistent verifier of our own would never have noticed.
    assert.equal(Buffer.from(signature, "base64url").length, 64);

    // The header says which algorithm and what kind of thing this is, and both are inside the
    // signature, so neither can be swapped by whoever hands the artifact on (ADR-0042).
    assert.deepEqual(decoded(header), { alg: "EdDSA", typ: "saf-decision+jws" });
    // And the payload says the same as the record: a verifier who was given only the artifact
    // reconstructs the log entry from it, which is why a row is not needed for one to be real.
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

    // A statement that says something else under a signature over something else. This is the
    // case the artifact exists to make impossible, and it is what a Party is protected by when
    // they show a Decision to somebody who does not trust the Operator.
    const edited = encoded({
      seq: published.seq,
      createdAt: published.createdAt,
      statement: "the version somebody would have preferred",
    });
    assert.equal(await checks(`${header}.${edited}.${signature}`), false);

    // A different number under the same words, which is the other edit worth trying: `seq`
    // orders two contradictory Decisions, so it is inside the signature too.
    const renumbered = encoded({
      seq: published.seq + 1000,
      createdAt: published.createdAt,
      statement: published.statement,
    });
    assert.equal(await checks(`${header}.${renumbered}.${signature}`), false);

    // And the type alone, which is what proves the header is signed: a receipt presented as a
    // Decision changes nothing else.
    const relabelled = encoded({ alg: "EdDSA", typ: "saf-receipt+jws" });
    assert.equal(await checks(`${relabelled}.${payload}.${signature}`), false);
  });
});

/** One `POST /decisions`, the way the agent publishes one. */
async function publish(statement: string): Promise<DecisionRecord> {
  const answered = await agentServer.fastify.inject({
    method: "POST",
    url: prefix,
    payload: { statement },
  });
  assert.equal(answered.statusCode, 201, `publishing should have answered: ${answered.body}`);
  return answered.json<DecisionRecord>();
}

/** One `GET /decisions` on the Public server, with the Token this file bought. */
async function ownLog(window: string): Promise<DecisionRecord[]> {
  const answered = await publicServer.fastify.inject({
    url: `${prefix}${window}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(answered.statusCode, 200, `reading should have answered: ${answered.body}`);
  return answered.json<{ decisions: DecisionRecord[] }>().decisions;
}

/** One `GET /decisions/:seq` on the Public server, unasserted: three statuses are its subject. */
function citing(seq: number) {
  return publicServer.fastify.inject({
    url: `${prefix}/${seq}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * One verification, done the way a third party does it and with nothing else in hand.
 *
 * The signing input is **reconstructed by splitting the string that was served** rather than
 * rebuilt from a header and a payload of this file's own: a rebuilt input would agree with a
 * signer that had covered different bytes, and the artifact would still be unverifiable by
 * everybody else. `node:crypto` and not `jose`, because `jose` is what signed it.
 */
async function checks(jws: string): Promise<boolean> {
  // With no Token, which is the point of this route: a verifier who never authenticates and
  // never will still gets the key (ADR-0042).
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

/** One segment as the JSON it holds. */
function decoded(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/** The same, backwards, for the segments this file substitutes to see them refused. */
function encoded(claims: unknown): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}
