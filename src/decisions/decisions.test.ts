/**
 * The agent's surface on the Decision log, as the agent can observe it.
 *
 * The subject is what a caller sees, never how a Decision is stored: every assertion here is
 * made over HTTP against two real Fastify instances and real PostgreSQL, **nothing inserts a
 * row directly**, and no assertion names a column. Numbering is observed as a field on a
 * record.
 *
 * Two things are proved here that are proved nowhere else. The first is that the artifact and
 * the record **agree**: the payload's `seq`, `createdAt` and `statement` are the record's, read
 * by splitting the emitted string, so a write path that signed one thing and stored another
 * fails here rather than in somebody's verifier. The second is that publishing **wakes
 * nothing** — a Signal Worker is constructed and its own routes are asked, afterwards, for an
 * empty queue.
 *
 * The Signal Worker below is never started, which is why the empty queue means what it says:
 * nothing could have consumed a Signal that had been emitted, so the queue being empty is the
 * Signal never existing (ADR-0043).
 *
 * A database of this file's own, because no two test files may share one, and a keypair
 * generated here, which is where a keypair may be generated: the framework generates none
 * (ADR-0041).
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { type Component, serverComponent } from "../components.ts";
import type { Db } from "../db/index.ts";
import type { SignalRecord } from "../signals/routes.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { createSignatures } from "../signatures/index.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { createUsers } from "../users/users.ts";
import { createDecisions, type DecisionRecord } from "./decisions.ts";

let database: TestDatabase;
let db: Db;
let agentServer: Component & { readonly fastify: FastifyInstance };
let publicServer: Component & { readonly fastify: FastifyInstance };

/** Where the constructor put both route groups. */
const prefix = "/decisions";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

/** A logger with nothing to say: one line per signing is not this file's subject. */
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

before(async () => {
  database = await createTestDatabase("decisions_agent");
  db = database.db;

  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);

  // Constructed and never started, so nothing drains and nothing dispatches. Its Agent server
  // routes are what this file asks about the queue, which is a higher seam than a table.
  createSignalWorker({ db, runtime: fakeRuntime(), handlers: {}, agentServer });
  // Required by Decisions for its Public read's 401 and by nothing else here. Construction
  // order against it is free, unlike the HTTP Messenger's, there being no foreign key
  // (ADR-0043).
  const users = createUsers({ db, tokenTtl: hour, agentServer, publicServer });
  const { privateKey } = generateKeyPairSync("ed25519");
  // Its own routes are registered on both servers and are not this file's subject; what
  // Decisions wants of it is the in-process `sign`.
  const signatures = createSignatures({
    signingKey: privateKey,
    agentServer,
    publicServer,
    users,
    logger: silent,
  });
  // Nothing is held: everything under test is a route the constructor registered itself
  // (ADR-0032).
  createDecisions({ db, signatures, users, agentServer, publicServer });

  await db.migrate();
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

describe("publishing a Decision", () => {
  it("answers the record it stored, artifact included, with no read-back to do", async () => {
    const published = await publish("the first thing we committed to");

    // The whole body against a literal the type checker holds to the record type: add a field
    // to `DecisionRecord` and this file stops compiling, leave it out of the response schema
    // and this comparison fails, because a response schema is a serializer (ADR-0040).
    assert.deepEqual(published, {
      seq: published.seq,
      statement: "the first thing we committed to",
      // Checked rather than copied, since a dropped field is `undefined` on both sides of a
      // `deepEqual` and would pass.
      jws: published.jws,
      createdAt: published.createdAt,
    } satisfies DecisionRecord);
    assert.equal(typeof published.seq, "number");
    assert.ok(published.jws.length > 0, "the artifact is the Decision and cannot be absent");
    assert.equal(new Date(published.createdAt).toISOString(), published.createdAt);
  });

  it("numbers the log globally, with nothing to scope the sequence to", async () => {
    const first = await publish("one");
    const second = await publish("two");

    // Consecutive rather than absolute, because this file publishes in several tests and the
    // sequence is one log's. What is asserted is that the number moves by one per publish and
    // belongs to nobody: there is no parameter anywhere naming a User (ADR-0043).
    assert.equal(second.seq, first.seq + 1);
  });

  it("signs the number and the timestamp it stored, and not some other pair", async () => {
    // The claim the write path's whole ordering exists for: the number is drawn first and the
    // timestamp second precisely so that both can go inside the signature, and the values
    // signed have to be the values kept. Read by **splitting the emitted string**, which is
    // the only reading that could disagree with the record (ADR-0042, ADR-0043).
    const published = await publish("the statement whose payload is read back");

    assert.deepEqual(payloadOf(published.jws), {
      seq: published.seq,
      createdAt: published.createdAt,
      statement: published.statement,
    });
  });

  it("refuses a statement that says nothing", async () => {
    // `minLength: 1`, so a signed empty commitment is unreachable, and a missing field is the
    // same 400 rather than a Decision about `undefined`.
    assert.equal((await publishing({ statement: "" })).statusCode, 400);
    assert.equal((await publishing({})).statusCode, 400);
  });

  it("ignores an artifact a caller wrote into the body, and signs its own", async () => {
    // There is no field for the signature and nowhere for one to arrive: a `jws` in the body
    // is stripped before the handler by `additionalProperties: false` and reaches nothing, so
    // "no path writes a Decision with a caller's bytes in it" is a fact about the surface
    // rather than a check that could be got wrong (ADR-0043).
    const published = await publish("mine, whatever else I sent with it", {
      jws: "not.a.signature",
    });

    assert.notEqual(published.jws, "not.a.signature");
    assert.deepEqual(payloadOf(published.jws), {
      seq: published.seq,
      createdAt: published.createdAt,
      statement: published.statement,
    });
  });

  it("wakes nothing at all, which is why the agent cannot queue work for itself", async () => {
    // A Decision is published *during* a Run and the worker is serial, so emitting a Signal
    // would have the agent's own action queue work behind the Run still in flight, and the
    // Handler it woke could publish again. Nothing here is started, so an emitted Signal would
    // still be sitting in the queue for this read to find (ADR-0043).
    await publish("this one notifies nobody");

    const queue = await agentJson<{ signals: SignalRecord[] }>("/signals");
    assert.deepEqual(queue.signals, []);
  });
});

describe("the agent reading the log", () => {
  it("answers the whole log ascending, which is what a fresh Session reads", async () => {
    // A Session is a lossy cache, so an agent with no memory of what it decided reads it here
    // (ADR-0011). `after=0` is how a reader with nothing in hand asks from the beginning.
    const before = await read("?after=0&limit=200");
    const published = await publish("and something after everything else");
    const whole = await read("?after=0&limit=200");

    assert.deepEqual(
      whole.map((decision) => decision.seq),
      [...before.map((decision) => decision.seq), published.seq],
    );
    assert.deepEqual(whole.at(-1), published);
  });

  it("pages by cursor, all three cases the same way up", async () => {
    const first = await publish("page one of the walk");
    const second = await publish("page two of the walk");
    const third = await publish("page three of the walk");

    // No cursor is the newest page, which is the case a client cannot guess and the
    // description is what tells it.
    assert.deepEqual(await seqs("?limit=2"), [second.seq, third.seq]);
    // `before` is the newest page strictly below, answering ascending like the rest.
    assert.deepEqual(await seqs(`?before=${third.seq}&limit=2`), [first.seq, second.seq]);
    // And `after` walks forwards from a number the caller already holds.
    assert.deepEqual(await seqs(`?after=${first.seq}&limit=2`), [second.seq, third.seq]);
  });

  it("refuses two windows in one request, and a parameter it does not have", async () => {
    const both = await agentServer.fastify.inject({ url: `${prefix}?after=1&before=4` });
    assert.equal(both.statusCode, 400, both.body);
    assert.match(both.json<{ message: string }>().message, /two different windows/);

    // `?user=` above all, since a reader arriving from the Message log will try it: this log
    // has no owner, so there is nothing to scope and nothing to omit.
    const scoped = await agentServer.fastify.inject({ url: `${prefix}?user=someone` });
    assert.equal(scoped.statusCode, 400, scoped.body);
    assert.match(scoped.json<{ message: string }>().message, /"user" is not a parameter/);
  });
});

/** One `POST /decisions`, the way the agent publishes one. */
async function publish(
  statement: string,
  alsoSent: Record<string, unknown> = {},
): Promise<DecisionRecord> {
  const answered = await publishing({ statement, ...alsoSent });
  assert.equal(answered.statusCode, 201, `publishing should have answered: ${answered.body}`);
  return answered.json<DecisionRecord>();
}

/** The same request, unasserted, for the bodies that are supposed to be refused. */
function publishing(payload: Record<string, unknown>) {
  return agentServer.fastify.inject({ method: "POST", url: prefix, payload });
}

/** One `GET /decisions` on the Agent server, with whatever window is asked for. */
async function read(window: string): Promise<DecisionRecord[]> {
  return (await agentJson<{ decisions: DecisionRecord[] }>(`${prefix}${window}`)).decisions;
}

/** That window as its numbers, which is how the cursor cases are read. */
async function seqs(window: string): Promise<number[]> {
  return (await read(window)).map((decision) => decision.seq);
}

/** One read of the Agent server, which takes no credential of any kind (ADR-0010). */
async function agentJson<T>(url: string): Promise<T> {
  const answered = await agentServer.fastify.inject({ url });
  assert.equal(answered.statusCode, 200, `${url} should have answered: ${answered.body}`);
  return answered.json<T>();
}

/**
 * The claims inside an artifact, decoded from the string that was emitted.
 *
 * By splitting rather than by rebuilding from a header and a payload of this file's own, which
 * is the whole point: a rebuilt payload would agree with a write path that had signed
 * something else entirely.
 */
function payloadOf(jws: string): unknown {
  const [, payload] = jws.split(".");
  return JSON.parse(Buffer.from(String(payload), "base64url").toString("utf8"));
}
