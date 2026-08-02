/**
 * The HTTP Messenger, as the agent can observe it.
 *
 * The subject is what a caller can see, never how a Message is stored: every assertion here
 * is made over HTTP against two real Fastify instances and real PostgreSQL, and **nothing
 * inserts a row directly**. No assertion names a column, a savepoint or a retry — the
 * numbering is observed as the `seq` on a record, and the foreign key is observed as a 404.
 *
 * A real Signal Worker is constructed, because the part requires one, and it is never
 * started and never emits: the agent's send wakes nobody, and nothing in this file posts.
 * The Public server is constructed for the same reason, and what it answers from here — the
 * Directory's 401 on both of its routes, since this Db's own agent presents no Token — is the
 * last test in this file. What that 401 is made of is `own-messages.test.ts`'s subject, and
 * what a post does when one is presented is `posted-messages.test.ts`'s.
 *
 * Users are admitted over the User Directory's own Agent route, and each test admits its
 * own, so that a numbering assertion is about one User's log and not about what an earlier
 * test left behind.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { type Component, serverComponent } from "../components.ts";
import type { Db } from "../db/index.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import type { UserRecord } from "../users/routes.ts";
import { createUsers } from "../users/users.ts";
import { createHttpMessenger } from "./http-messenger.ts";
import type { MessageRecord } from "./messages.ts";

let database: TestDatabase;
let db: Db;
/** Both servers, as an Operator constructs them: bare Fastify instances in a start order. */
let agentServer: Component & { readonly fastify: FastifyInstance };
let publicServer: Component & { readonly fastify: FastifyInstance };

/**
 * Where the constructor put each plugin. There is no second registration in this file, and
 * there could not be: this part exports no plugin and its prefixes are not configurable,
 * which is its stated departure from ADR-0032 (ADR-0034).
 */
const prefix = "/messages";

/** A well-formed uuid that names no User, which is the only thing the foreign key catches. */
const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

before(async () => {
  database = await createTestDatabase("http_messages");
  db = database.db;

  // The framework constructs no server: two bare Fastify instances, the same calls an
  // Operator's entry point makes. Nothing here starts either — `inject` needs no socket.
  agentServer = serverComponent("agent server", Fastify(), { port: 0, host: "127.0.0.1" });
  publicServer = serverComponent("public server", Fastify(), { port: 0, host: "127.0.0.1" });

  // Required of the construction and never started, because nothing in this ticket's
  // surface emits: the agent's send is not an arrival and wakes nobody.
  const worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {} });
  // Before the Messenger, and that order is load-bearing rather than narrative: the
  // Messenger's first migration references this part's table (ADR-0036).
  const users = createUsers({ db, tokenTtl: 60 * 60 * 1000, agentServer });
  // Nothing is held: every capability this part has so far is a route, and it registered
  // both plugins and its descriptor itself (ADR-0032).
  createHttpMessenger({ db, users, worker, publicServer, agentServer });

  // Three descriptors, applied in construction order.
  await db.migrate();
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

/** A User, admitted over the User Directory's own Agent route. */
async function admitted(): Promise<string> {
  const response = await agentServer.fastify.inject({ method: "POST", url: "/users" });
  assert.equal(response.statusCode, 201, `admitting a User should have answered: ${response.body}`);
  return response.json<UserRecord>().id;
}

/** One `POST /messages` on the Agent server, with whatever body the caller wants sent. */
function post(payload: Record<string, unknown>) {
  return agentServer.fastify.inject({ method: "POST", url: prefix, payload });
}

/** One `GET /messages` on the Agent server, with whatever query the caller wants sent. */
function read(query: string) {
  return agentServer.fastify.inject({ method: "GET", url: `${prefix}${query}` });
}

/** Sends a Message and asserts only that it was accepted. */
async function sent(userId: string, text: string): Promise<MessageRecord> {
  const response = await post({ userId, text });
  assert.equal(response.statusCode, 201, `POST ${prefix} should have answered: ${response.body}`);
  return response.json<MessageRecord>();
}

/** Reads one User's log and asserts only that it was answered. */
async function log(userId: string, window = ""): Promise<MessageRecord[]> {
  const response = await read(`?user=${userId}${window}`);
  assert.equal(response.statusCode, 200, `GET ${prefix} should have answered: ${response.body}`);
  return response.json<{ messages: MessageRecord[] }>().messages;
}

/** The `seq` of each Message in a page, which is what most assertions here are about. */
function numbers(messages: readonly MessageRecord[]): number[] {
  return messages.map((message) => message.seq);
}

describe("sending a Message to a User over the Agent server", () => {
  it("stores it, numbers it from 1, and answers with what the read answers with", async () => {
    const user = await admitted();
    const message = await sent(user, "what happened to the deploy?");

    assert.match(message.id, /^[0-9a-f-]{36}$/);
    assert.equal(message.userId, user);
    // Decided by the server the request arrived on, and there is no field for it.
    assert.equal(message.direction, "outbound");
    assert.equal(message.seq, 1);
    assert.equal(message.text, "what happened to the deploy?");
    assert.equal(new Date(message.createdAt).toISOString(), message.createdAt);

    // The created record is the stored one, which is what makes answering with it a
    // substitute for a read-back rather than a convenience.
    assert.deepEqual(await log(user), [message]);
  });

  it("answers 404 for a well-formed uuid naming no User, and writes nothing", async () => {
    // The foreign key doing the one thing it exists to catch: an agent copying an id wrong
    // (ADR-0036). There is no lookup in front of the write, so this 404 comes from the
    // write that actually failed.
    const refused = await post({ userId: nobody, text: "are you there?" });
    assert.equal(refused.statusCode, 404);
    assert.deepEqual(refused.json(), {
      statusCode: 404,
      error: "Not Found",
      message: `no User ${nobody} exists`,
    });

    // And nothing was stored for them, which is what makes the 404 more than a status: a
    // misaddressed Message nobody will ever read is what the constraint prevents.
    assert.deepEqual(await log(nobody), []);
  });

  it("answers 400 for a malformed uuid, rather than a 500 out of PostgreSQL", async () => {
    // PostgreSQL refuses to cast a malformed uuid, so an unvalidated id would be a 500 from
    // a typo the agent could not tell apart from a Gateway fault.
    assert.equal((await post({ userId: "not-an-id", text: "hello" })).statusCode, 400);
    assert.equal((await read("?user=not-an-id")).statusCode, 400);
  });

  it("refuses an empty text, and honours no direction the caller asks for", async () => {
    const user = await admitted();
    assert.equal((await post({ userId: user, text: "" })).statusCode, 400);

    // `additionalProperties: false` strips rather than refuses, which is what is wanted
    // here: an agent talked into asking for an inbound Message asks through a field that
    // reaches nothing, and cannot put words in a User's mouth (ADR-0034).
    const message = await post({ userId: user, text: "not from you", direction: "inbound" });
    assert.equal(message.statusCode, 201);
    assert.equal(message.json<MessageRecord>().direction, "outbound");
  });
});

describe("numbering a User's Messages", () => {
  it("numbers each User's log independently from 1", async () => {
    // Invariant 2 of the data model: nothing about how busy the agent is for anybody else
    // is legible in a number a User can see.
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
    // Five at once, which is the most a bound of five serves deterministically: each loss
    // means somebody else committed the number this send had computed, and a send's targets
    // strictly increase, so the last of n concurrent writers needs at most n attempts. The
    // race is genuinely lost here — one writer wins each number and the others recompute —
    // and what is observable is only that nobody was renumbered and no number was skipped.
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
  /** A log of four Messages, so a page can be smaller than it. */
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
    // The newest two, still ascending: a client concatenates pages without reversing
    // anything, and the descending selection behind `limit` is invisible from here.
    assert.deepEqual(numbers(await log(user, "&limit=2")), [3, 4]);

    for (const window of ["&limit=0", "&limit=201", "&limit=none", "&after=-1", "&before=x"]) {
      assert.equal((await read(`?user=${user}${window}`)).statusCode, 400, window);
    }
  });

  it("walks backwards with before and forwards with after, and refuses both", async () => {
    const user = await withFour();
    assert.deepEqual(numbers(await log(user, "&before=3")), [1, 2]);
    assert.deepEqual(numbers(await log(user, "&before=3&limit=1")), [2]);
    assert.deepEqual(numbers(await log(user, "&after=2")), [3, 4]);
    assert.deepEqual(numbers(await log(user, "&after=4")), []);
    // `after=0` is the log from its beginning, which no other spelling asks for: no cursor
    // at all is the newest page, and `after=1` would skip the first Message.
    assert.deepEqual(numbers(await log(user, "&after=0")), [1, 2, 3, 4]);

    // Two windows in one request, which is a client bug worth naming rather than one of
    // the two silently winning.
    const both = await read(`?user=${user}&after=1&before=4`);
    assert.equal(both.statusCode, 400);
    assert.match(both.json<{ message: string }>().message, /two different windows/);
  });

  it("requires a User, and refuses an unknown query parameter", async () => {
    const user = await withFour();
    // Required not for confidentiality — the agent may read everything (ADR-0011) — but
    // because `seq` is per User and cannot cursor an interleaved result.
    assert.equal((await read("")).statusCode, 400);
    assert.equal((await read("?limit=2")).statusCode, 400);

    // A `?text=hello` answered with the newest fifty Messages reads as though a filter had
    // been applied, so it is refused with this part's own sentence.
    for (const query of ["&text=hello", "&direction=inbound", "&limt=2"]) {
      const refused = await read(`?user=${user}${query}`);
      assert.equal(refused.statusCode, 400, query);
      assert.match(refused.json<{ message: string }>().message, /read by cursor/);
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
    // Both routes exist and both refuse this Db's own agent, because the Agent server's
    // freedom from authentication is that server's and not the Messenger's: a Public route is
    // behind the Directory's hook wherever the request came from. What that refusal is made
    // of is `own-messages.test.ts`'s subject.
    const read = await publicServer.fastify.inject({ method: "GET", url: prefix });
    assert.equal(read.statusCode, 401, read.body);

    // A body this route would accept from a User, so the 401 is about the credential and not
    // about the request: there is no way to write an inbound Message without being one.
    const posted = await publicServer.fastify.inject({
      method: "POST",
      url: prefix,
      payload: { text: "not from a User at all" },
    });
    assert.equal(posted.statusCode, 401, posted.body);
  });
});
