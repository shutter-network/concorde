/**
 * The Decision log proven to page: a client walking it backwards and then forwards reconstructs
 * it **exactly once**, with nothing dropped and nothing repeated.
 *
 * The claim is the one the HTTP Messenger's own walk makes, and it is here for a sharper reason:
 * that log is per User, so a test can have one of its own by admitting one, and this log is
 * global. There is no window a reader can floor, a backwards walk running to the beginning of the
 * whole log because `after` and `before` together are refused as two windows, so the only way to
 * know what a walk should reconstruct is for the file to own the log. That is what a database
 * of this file's own buys here, and it is why the walk is not in the two surface files beside it:
 * every other test publishes, and a log whose length depends on what ran before it cannot say
 * where its pages should break.
 *
 * So **everything is published in `before` and nothing below publishes anything**. The seven
 * Decisions are numbered 1 to 7 because the sequence is this database's and nothing else drew
 * from it, which is also the only place in the suite where the numbers can be written down.
 *
 * Alongside the walk, the refusals and the cursor cases the shared conventions provide, asserted
 * here because this is the surface a client meets rather than because this part implements them
 * ([ADR-0035](../../docs/adr/0035-a-users-messages-are-one-log-read-by-cursor.md)).
 *
 * Every read below is made over HTTP against two real Fastify instances and real PostgreSQL,
 * nothing inserts a row directly, and the Token is bought with a real password at the User
 * Manager's own login route.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { type Component, serverComponent } from "../components.ts";
import type { Db } from "../db/index.ts";
import { limitSchema } from "../route-conventions.ts";
import { createSignatures } from "../signatures/index.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import type { UserRecord } from "../users/routes.ts";
import type { ScryptParameters } from "../users/secrets.ts";
import { createUsers } from "../users/users.ts";
import { createDecisions, type DecisionRecord } from "./decisions.ts";

let database: TestDatabase;
let db: Db;
let agentServer: Component & { readonly fastify: FastifyInstance };
let publicServer: Component & { readonly fastify: FastifyInstance };

/** Where the constructor put both route groups, and the User Manager's login. */
const prefix = "/decisions";
const auth = "/auth";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

/** A cost nobody should deploy, because the one login here should take no time. */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

const password = "correct horse battery staple";

/** A logger with nothing to say: one line per signing is `signatures.test.ts`'s subject. */
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * The whole log, in the order it was published, and the only publishing this file does.
 *
 * Seven and a page of three, so that neither walk divides evenly into the other's: seven is
 * `2 × 3 + 1`, which is what puts the short page at the **start** of the backwards walk and at
 * the **end** of the forwards one. Two walks that broke in the same places would agree about a
 * log they had both mis-paged, and would prove much less.
 */
const committed = [
  "we will ship on the first of the month",
  "we will not ship anything unreviewed",
  "we will keep the Gateway trusted and say so",
  "we will publish a reversal rather than edit one",
  "we will answer within a day",
  "we will not read a Message we were not sent",
  "we will hold to all of the above in writing",
] as const;

/** The page size both walks take, and the whole of the arithmetic above. */
const page = 3;

/** The Token this file reads with, bought at the real login route in `before`. */
let token: string;

before(async () => {
  database = await createTestDatabase("decisions_paging");
  db = database.db;

  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);

  const users = createUsers({ db, tokenTtl: hour, scrypt: cheap, agentServer, publicServer });
  // Generated here, which is where a keypair may be generated: the framework generates none
  // (ADR-0041). Nothing in this file looks at an artifact; the key is what Decisions needs to
  // exist at all.
  const { privateKey } = generateKeyPairSync("ed25519");
  const signatures = createSignatures({
    signingKey: privateKey,
    agentServer,
    publicServer,
    users,
    logger: silent,
  });
  createDecisions({ db, signatures, users, agentServer, publicServer });

  await db.migrate();

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

  // One at a time and in order, because the number is what everything below is written in terms
  // of and the sequence hands them out in the order the writes reach it.
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

    // The two walks share not one page boundary: backwards lands on the end of the log and pages
    // down from it, forwards starts at the beginning. That is what makes the agreement below a
    // claim about the cursor rather than about arithmetic.
    assert.deepEqual(backwards.map(numbers), [[1], [2, 3, 4], [5, 6, 7]]);
    assert.deepEqual(forwards.map(numbers), [[1, 2, 3], [4, 5, 6], [7]]);

    // Concatenated with nothing reversed and nothing merged: each walk is the log exactly once,
    // nothing dropped and nothing repeated.
    assert.deepEqual(
      backwards.flat().map((decision) => decision.statement),
      [...committed],
    );
    assert.deepEqual(backwards.flat(), forwards.flat());

    // And against the log read as one page, which is the third reading and the one that would
    // catch two walks agreeing on a log that is not there.
    assert.deepEqual(backwards.flat(), await log(`?after=0&limit=${committed.length}`));
  });

  it("is the same walk for the agent, whose read is a User's with no Token wanted", async () => {
    // The log is global and neither read is scoped by anything at all, so the agent's answer is
    // a User's byte for byte. Asserted over the same windows the walks use, because a difference
    // between the two surfaces would be a difference in *paging* rather than in content
    // (ADR-0043).
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
    // The by-number route over the whole log rather than over one record: a citation and a page
    // are the same read, so every record a walk found is what its own number answers with.
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
    // The distinction that is easy to lose: nothing is numbered 0, so `after=0` looks like no
    // cursor and means the opposite of it. No cursor is the newest page, which is what a client
    // opening a log wants; `after=0` is the log from its start, which is what a client holding
    // nothing and meaning to walk forwards wants; and `after=1` would skip the first Decision.
    assert.deepEqual(numbers(await log(`?after=0&limit=${page}`)), [1, 2, 3]);
    assert.deepEqual(numbers(await log(`?limit=${page}`)), [5, 6, 7]);
    assert.deepEqual(numbers(await log(`?after=1&limit=${page}`)), [2, 3, 4]);

    // And with no limit at all, the two are the whole log and the newest page of it, which here
    // is the same seven records: the default page is larger than this log.
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
    // The number is the conventions' and not this part's, which is the thing asserted: a route
    // with a cap of its own would be one more number to keep in step with the sentence the
    // description carries.
    assert.equal((await reading(`?limit=${limitSchema.maximum}`)).statusCode, 200);
    assert.equal((await reading(`?limit=${limitSchema.maximum + 1}`)).statusCode, 400);
    for (const window of ["?limit=0", "?limit=none", "?after=-1", "?before=x"]) {
      assert.equal((await reading(window)).statusCode, 400, window);
    }

    // A cursor above the column's `integer` range is refused on both surfaces rather than
    // reaching the database, where it would come back a 500 carrying the text of the query.
    // The 400 names the parameter and carries no query text: that is the whole of the fix.
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
    // A `?statement=ship` answered with the newest fifty reads as though a filter had been
    // applied, so it is refused rather than stripped, and `?user=` above all, since a reader
    // arriving from the Message log will try it.
    for (const window of ["?statement=ship", "?limt=2", "?user=someone", "?before=4&order=desc"]) {
      const refused = await reading(window);
      assert.equal(refused.statusCode, 400, window);
      assert.match(refused.json<{ message: string }>().message, /cannot be searched or filtered/);
    }
  });
});

/**
 * Every page a client gets scrolling up: the newest first, then each page strictly below the
 * oldest number the last one held, until an empty page ends the walk.
 *
 * Returned oldest page first, so the walk reads in the order the log does. The empty page is what
 * ends it, which is why the envelope needs no `hasMore`: a client that asked for `limit` and got
 * fewer already knows, and one that got exactly `limit` asks again.
 */
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

/** Every page a client gets polling forward from the beginning of the log. */
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

/** One `GET /decisions` on the Public server, with the Token this file bought. */
async function log(window: string): Promise<DecisionRecord[]> {
  const answered = await reading(window);
  assert.equal(answered.statusCode, 200, `reading should have answered: ${answered.body}`);
  return answered.json<{ decisions: DecisionRecord[] }>().decisions;
}

/** The same read, unasserted, for the windows that are supposed to be refused. */
function reading(window: string) {
  return publicServer.fastify.inject({
    url: `${prefix}${window}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** And the agent's read of the same window, which takes no credential at all (ADR-0010). */
function asAgent(window: string) {
  return agentServer.fastify.inject({ url: `${prefix}${window}` });
}

/** A page as its numbers, which is what a walk is written in terms of. */
function numbers(decisions: readonly DecisionRecord[]): number[] {
  return decisions.map((decision) => decision.seq);
}
