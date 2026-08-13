/**
 * What trusted code can do with the Decision log that no request can: commit to something
 * from inside its own transaction, and read the whole log without a Token and without a
 * route.
 *
 * A Signal Handler and an Operator's entry point are trusted code (ADR-0009, ADR-0020) and
 * hold the object the constructor returns. These two methods are the whole of what that
 * object adds to the two no-ops, and the pair is what makes a Handler able to commit to
 * something and build the next Prompt from what has already been committed to.
 *
 * The subject is still what a caller can observe. There is no second seam for these methods
 * and deliberately no route of their own, so they are reached the way an Operator reaches
 * them, in a transaction of this file's own, and confirmed the way the Messenger's pair
 * is confirmed: over HTTP, on the agent's route and a User's, against two real Fastify
 * instances and real PostgreSQL. **The two methods and the routes are the only path to a row
 * anywhere in this file**: nothing here writes SQL of its own, holds a handle, or names a
 * column.
 *
 * Two tests are the reason the file exists:
 *
 *  - `commits with the caller's own write, and a rollback loses both` is what taking the
 *    transaction first buys (ADR-0023). A Handler answering a Signal by committing to
 *    something and recording in the Operator's own tables *why* must commit as one, and the
 *    rollback half is the failure the split exists to prevent: a Decision published about
 *    something that was never recorded. Ambient enlistment is not available here for the
 *    reason it is not available to the Messenger, that a transaction started on one handle
 *    takes its own connection, so a second handle's writes would survive its rollback with
 *    nothing reported.
 *  - `is not capped at the limit the routes cap` is the one place the two surfaces
 *    deliberately differ. The cap bounds a response body a stranger or the agent reads, and
 *    trusted code asking for two hundred and one Decisions is not in that case.
 *
 * The Signal Worker stands in for the Operator's own tables in the transaction tests: a
 * Signal is a write in another part's schema, observable over the worker's own Agent routes,
 * which is a higher seam than any table this file could have created for itself. It is never
 * started, so nothing is drained and nothing dispatched.
 *
 * The record a publish answers with is checked the way a third party checks one, against the
 * key set served on the Public server and with `node:crypto` rather than the library that
 * signed it: trusted code publishes through the same write path the route reaches, and an
 * artifact it could not verify would be a second, worse path to a row.
 *
 * A database of this file's own, because no two test files may share one, a keypair generated
 * here, which is where a keypair may be generated (ADR-0041), and a deliberately cheap scrypt
 * cost, because the one Token here is bought with a password.
 */

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
/** The object under test, held the way a Signal Handler holds it. */
let decisions: Decisions;
let worker: SignalWorker;
/** Both servers, as an Operator constructs them: bare Fastify instances in a start order. */
let agentServer: ServerComponent<FastifyInstance>;
let publicServer: ServerComponent<FastifyInstance>;

/** Where the constructor put both route groups, and the login route of Password Auth. */
const prefix = "/decisions";
const auth = "/auth";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

/** A cost nobody should deploy, so that the one login here runs in a moment. */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

/** The one password in this file. Nothing here is about what a good password is. */
const password = "correct horse battery staple";

/** Nothing here starts a worker, and one line per signing is not this file's subject. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** The Token the Public read below is made with, bought at the real login route. */
let token: string;

before(async () => {
  database = await createTestDatabase("decisions_trusted");
  db = database.db;

  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);

  // Constructed and never started, with its own Agent routes on the Agent server: this file
  // emits Signals inside the transactions it tests and reads them back over `GET /signals`,
  // and a running worker would take them off the queue and try to handle them.
  worker = createSignalWorker({
    db,
    runtime: fakeRuntime(),
    handlers: {},
    agentServer,
    logger: silent,
  });
  // Users for the identity and Password Auth for the login under `/auth`, which is what makes
  // `publicServer.requireUser` able to authenticate the one read below. Construction order
  // against Decisions is free, unlike the Messenger's, there being no foreign key here
  // (ADR-0043).
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
  // And held, which this file is the first to have a reason to do.
  decisions = createDecisions({ db, signatures, agentServer, publicServer });

  await applySchema(db, signalsSchema, usersSchema, passwordAuthSchema, decisionsSchema);

  // Admitted from trusted code, in one transaction: there is no route that creates a User
  // (ADR-0052).
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
    // The call as a Handler writes it: the transaction first, then the Statement, and nothing
    // else at all (ADR-0023). There is no User to address and no artifact to supply.
    const published = await db.tx((tx) => decisions.publish(tx, "we will ship on Friday"));

    // The whole record against a literal the type checker holds to `DecisionRecord`: a field
    // added to the type and forgotten here stops this file compiling.
    assert.deepEqual(published, {
      seq: published.seq,
      statement: "we will ship on Friday",
      jws: published.jws,
      createdAt: published.createdAt,
    } satisfies DecisionRecord);
    assert.equal(typeof published.seq, "number");
    assert.equal(new Date(published.createdAt).toISOString(), published.createdAt);

    // Readable by the agent and by a User, byte for byte, which is what makes this the same
    // log the routes publish into rather than a second write path with a surface of its own.
    const window = `?after=${published.seq - 1}`;
    assert.deepEqual(await asAgent(window), [published]);
    assert.deepEqual(await ownLog(window), [published]);

    // And the artifact is a real one. Checked against the key set over HTTP and with
    // `node:crypto`, because a Decision trusted code published has to survive the same
    // hand-off as one the agent published: it is the artifact that is the Decision (ADR-0042).
    assert.equal(await checks(published.jws), true, "a published Decision should verify");
    assert.deepEqual(payloadOf(published.jws), {
      seq: published.seq,
      createdAt: published.createdAt,
      statement: published.statement,
    });
  });

  it("commits with the caller's own write, and a rollback loses both", async () => {
    // The pattern this method exists for: commit to something, and record in the caller's own
    // tables why. A Signal stands in for those tables here, because it is a write in another
    // part's schema that is observable over HTTP.
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

    // And the half the split exists for, which is the failure this whole shape prevents: a
    // Decision published about something that was never recorded. Neither of these happened,
    // and it is one rollback that undid both because both took the same transaction.
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

    // The number it burned is gone and nothing fills it, which is expected and means nothing:
    // gaplessness would prove nothing anyway, the Operator owning the database (ADR-0043).
    const next = await db.tx((tx) => decisions.publish(tx, "and the log carries on"));
    assert.ok(next.seq > attempted.seq, "a rolled-back publish burns its number");

    // And a citation of the burned number is a **404 rather than the Decision that took the
    // next one**, which is the one place a by-number read could quietly answer the wrong
    // record. It is asserted here because this is the only way a gap can be made: every other
    // file's log is a run of consecutive numbers, where a read that answered "the first
    // Decision at or after this number" would be indistinguishable from a correct one.
    const burned = await publicServer.fastify.inject({
      url: `${prefix}/${attempted.seq}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(burned.statusCode, 404, burned.body);
    assert.equal(
      (await agentServer.fastify.inject({ url: `${prefix}/${attempted.seq}` })).statusCode,
      404,
    );
    // While the number that was not burned answers with the Decision that holds it, so the 404
    // above is about that number and not about the route.
    const carried = await agentServer.fastify.inject({ url: `${prefix}/${next.seq}` });
    assert.deepEqual(carried.json<DecisionRecord>(), next);
  });

  it("answers with the record, which is what a caller cannot read back", async () => {
    // A read takes no transaction, so it is on another connection and cannot see an
    // uncommitted write (ADR-0023). Everything the caller needs is what `publish` returned,
    // which is why there is no read-back for this to be a surprise about, and why the agent
    // can quote a Decision to a User in the same Run.
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
    // Enough of a log to page through, written in one transaction, which is the shape trusted
    // code has and a request does not: three statements, one commit.
    const from = await mark();
    await db.tx(async (tx) => {
      for (const statement of ["one", "two", "three"]) {
        await decisions.publish(tx, statement);
      }
    });
    const [first, second, third] = await decisions.history({ after: from });
    assert.ok(first !== undefined && second !== undefined && third !== undefined);

    // The same query reached three ways, by a Token, by nothing at all and by an argument. The
    // whole point of there being one implementation is that these cannot come to disagree
    // about what `before` means (ADR-0035).
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

    // Ascending in every case, whatever the window, which is the one order all three cursor
    // cases answer in.
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
    // Two hundred and one, one more than the routes' cap, written in one transaction.
    const from = await mark();
    const many = 201;
    await db.tx(async (tx) => {
      for (let each = 1; each <= many; each += 1) {
        await decisions.publish(tx, `number ${each}`);
      }
    });

    // The cap bounds a response body a stranger or the agent reads, and a Handler building a
    // Prompt from everything already committed to is not in that case: it asks for all of them
    // and gets them.
    const whole = await decisions.history({ after: from, limit: many });
    assert.equal(whole.length, many);
    // By what was committed to rather than by absolute numbers, so that a gap burned anywhere
    // else in this file is what it is supposed to be here too: meaningless (ADR-0043). What
    // this asserts is every one of them, once, in the order they were published.
    assert.deepEqual(
      whole.map((decision) => decision.statement),
      Array.from({ length: many }, (_, index) => `number ${index + 1}`),
    );

    // While the same number on either route is a 400 from the shared schema, which is what
    // makes the difference deliberate rather than an oversight in one place or the other.
    const byTheAgent = await agentServer.fastify.inject({ url: `${prefix}?limit=${many}` });
    assert.equal(byTheAgent.statusCode, 400, byTheAgent.body);
    const byTheUser = await publicServer.fastify.inject({
      url: `${prefix}?limit=${many}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(byTheUser.statusCode, 400, byTheUser.body);
  });

  it("defaults to the number the routes default to", async () => {
    // The default is shared rather than restated, so a deployment reading the log from trusted
    // code and a client reading it over HTTP see the same page size. By now this file has
    // published well past a page, so the newest page is a full one.
    const page = await decisions.history();

    assert.equal(page.length, 50);
    assert.deepEqual(page, await asAgent(""));
    assert.deepEqual(page, await ownLog(""));
  });
});

describe("the object the constructor answers with", () => {
  it("carries a publish and a read, and nothing that names a User or takes an artifact", async () => {
    // An assertion of **absence**, and the reason it is the object's own keys rather than a
    // list of names to probe: a method added later appears here and fails this. There is no
    // `verify`, no `sign` and nothing anywhere on it naming a User, because this log has no
    // owner and the key that signs is Signatures' (ADR-0043).
    //
    // `start` and `stop` are the two that do nothing, and they are here because this part is
    // in the Gateway's record like every other one (ADR-0037).
    assert.deepEqual(Object.keys(decisions).sort(), ["history", "publish", "start", "stop"]);

    // Two parameters, the transaction and the Statement, which is the runtime shadow of the
    // claim the type makes: **the signature is not an argument**. There is no path anywhere
    // that puts a caller's own bytes into the artifact, so a Decision read from this log was
    // signed by this Gateway or it does not exist.
    assert.equal(decisions.publish.length, 2);

    // And the same fact from outside: what trusted code published verifies against the key
    // set the Public server serves, which is the one key this deployment has.
    const published = await db.tx((tx) => decisions.publish(tx, "signed by us or not at all"));
    assert.equal(await checks(published.jws), true);
  });
});

/** The newest `seq` this file has reached, as the cursor the next test walks forwards from. */
async function mark(): Promise<number> {
  const [newest] = await decisions.history({ limit: 1 });
  return newest?.seq ?? 0;
}

/** The log as the agent reads it, which takes no credential of any kind (ADR-0010). */
async function asAgent(window: string): Promise<DecisionRecord[]> {
  const answered = await agentServer.fastify.inject({ url: `${prefix}${window}` });
  assert.equal(answered.statusCode, 200, `the agent's read should have answered: ${answered.body}`);
  return answered.json<{ decisions: DecisionRecord[] }>().decisions;
}

/** The same log as a User reads it, with the Token this file bought. */
async function ownLog(window: string): Promise<DecisionRecord[]> {
  const answered = await publicServer.fastify.inject({
    url: `${prefix}${window}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(answered.statusCode, 200, `a User's read should have answered: ${answered.body}`);
  return answered.json<{ decisions: DecisionRecord[] }>().decisions;
}

/**
 * The Signals of one kind, over the Signal Worker's **own** Agent routes.
 *
 * That seam rather than the `signals` table: what a transaction did or did not commit is
 * observable where a deployment reads it, and this file writes one to stand in for whatever
 * the Operator's own tables would have recorded.
 */
async function signals(kind: string): Promise<SignalRecord[]> {
  const answered = await agentServer.fastify.inject({ url: `/signals?kind=${kind}` });
  assert.equal(answered.statusCode, 200, `GET /signals should have answered: ${answered.body}`);
  return answered.json<{ signals: SignalRecord[] }>().signals;
}

/** The `seq` of each Decision in a page, which is what most assertions here are about. */
function numbers(page: readonly DecisionRecord[]): number[] {
  return page.map((decision) => decision.seq);
}

/**
 * One verification, done the way a third party does it and with nothing else in hand.
 *
 * The signing input is **reconstructed by splitting the string that was returned** rather than
 * rebuilt from a header and a payload of this file's own, and the oracle is `node:crypto`
 * rather than the library that signed it (ADR-0042).
 */
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

/** The claims inside an artifact, decoded from the string that was returned. */
function payloadOf(jws: string): unknown {
  const [, payload] = jws.split(".");
  return JSON.parse(Buffer.from(String(payload), "base64url").toString("utf8"));
}
