/**
 * A User reading their own Message log, as their own client can observe it.
 *
 * The subject is what a client sees, never how a Message is stored: every assertion here is
 * made over HTTP against two real Fastify instances and real PostgreSQL, and **nothing
 * inserts a row directly**. Every Token is bought with a real password at the User
 * Manager's own login route, because a Token minted any other way would be testing a
 * shortcut this surface does not have.
 *
 * Both directions are here, each written the way it arrives: the agent's send on the Agent
 * server, and the User's own post on the Public one. That is what makes the read's
 * direction-blindness observable rather than merely stated — one log, numbered across both,
 * with no `direction` parameter to filter by and a refusal for anyone who asks for one
 * (ADR-0035). The Signal Worker constructed below is never started, so the Signal a post
 * emits sits `pending` and nothing downstream of it happens: what a submission wakes is
 * `posted-messages.test.ts`'s subject, and this file's is the read.
 *
 * The paging tests are the ones that matter. A log longer than one page is walked backwards
 * to its start and then forwards to its end, and the two walks — which do not share a
 * single page boundary — must reconstruct the same log exactly once, with nothing dropped
 * and nothing repeated.
 *
 * A database of this file's own, because no two test files may share one, and a
 * deliberately cheap scrypt cost, because every Token here starts with a login.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { type Component, serverComponent } from "../components.ts";
import type { Db } from "../db/index.ts";
import * as signalsSchema from "../signals/schema.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import type { UserRecord } from "../users/routes.ts";
import * as usersSchema from "../users/schema.ts";
import type { ScryptParameters } from "../users/secrets.ts";
import { createUsers } from "../users/users.ts";
import { createHttpMessenger } from "./http-messenger.ts";
import type { MessageRecord } from "./messages.ts";
import * as httpMessagesSchema from "./schema.ts";

let database: TestDatabase;
let db: Db;
/** Both servers, as an Operator constructs them: bare Fastify instances in a start order. */
let agentServer: Component & { readonly fastify: FastifyInstance };
let publicServer: Component & { readonly fastify: FastifyInstance };

/** Where the constructor put the Messenger's plugins, and the User Manager's login. */
const prefix = "/messages";
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

/** A User as their client holds them: the id the agent addresses, and a Token they logged in for. */
type Client = {
  readonly id: string;
  readonly token: string;
};

before(async () => {
  database = await createTestDatabase("http_messages_own");
  db = database.db;

  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);

  // Required of the construction and never started: a post emits a Signal, and with nobody
  // draining the queue it stays `pending` and wakes nothing — which is exactly what a read
  // test wants, since the row is what it reads and the Run is not its subject.
  const worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {} });
  // Both servers, so that `POST /users` and the login under `/auth` exist: a Token here is
  // bought with a password at the Manager's own route. The Messenger takes it, so it is
  // constructed first; the foreign key's ordering is the push's to arrange (ADR-0046).
  const users = createUsers({ db, tokenTtl: hour, scrypt: cheap, agentServer, publicServer });
  // Nothing is held: the read under test is a route, and the constructor registered it
  // itself, behind the Manager's own hook (ADR-0032).
  createHttpMessenger({ db, users, worker, publicServer, agentServer });

  // The Manager's schema alongside the Messenger's, because `messages.user_id` references
  // `saf_users.users.id` and one push has to see both (ADR-0036, ADR-0046).
  await applySchema(db, signalsSchema, usersSchema, httpMessagesSchema);
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

/** A User with a password, admitted over the Agent server, holding a Token they logged in for. */
async function admitted(): Promise<Client> {
  const created = await agentServer.fastify.inject({
    method: "POST",
    url: "/users",
    payload: { password },
  });
  assert.equal(created.statusCode, 201, `admitting a User should have answered: ${created.body}`);
  const id = created.json<UserRecord>().id;
  return { id, token: await tokenFor(id) };
}

/** One real login, at the Manager's own route, on whichever Public server carries it. */
async function tokenFor(id: string, server = () => publicServer.fastify): Promise<string> {
  const issued = await server().inject({
    method: "POST",
    url: `${auth}/tokens`,
    payload: { user: id, password },
  });
  assert.equal(issued.statusCode, 201, `logging in should have answered: ${issued.body}`);
  return issued.json<{ token: string }>().token;
}

/** One Message to a User, sent the way the agent sends one. */
async function sent(userId: string, text: string): Promise<MessageRecord> {
  const response = await agentServer.fastify.inject({
    method: "POST",
    url: prefix,
    payload: { userId, text },
  });
  assert.equal(response.statusCode, 201, `sending should have answered: ${response.body}`);
  return response.json<MessageRecord>();
}

/** One Message from a User, posted the way their own client posts one. */
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

/**
 * One `GET /messages` on the Public server, with whatever a client presents and whatever
 * window it asks for.
 *
 * The credential comes first in all three of these, so that the reads below say what they
 * present before they say what they ask for.
 */
function presenting(authorization: string | undefined, window = "") {
  return publicServer.fastify.inject({
    method: "GET",
    url: `${prefix}${window}`,
    headers: authorization === undefined ? {} : { authorization },
  });
}

/** One read by a User holding a Token, presented in the one scheme this framework mints. */
function bearing(token: string, window = "") {
  return presenting(`Bearer ${token}`, window);
}

/** Reads a User's own log and asserts only that it was answered. */
async function log(token: string, window = ""): Promise<MessageRecord[]> {
  const response = await bearing(token, window);
  assert.equal(response.statusCode, 200, `GET ${prefix} should have answered: ${response.body}`);
  return response.json<{ messages: MessageRecord[] }>().messages;
}

/** The `seq` of each Message in a page, which is what most assertions here are about. */
function numbers(messages: readonly MessageRecord[]): number[] {
  return messages.map((message) => message.seq);
}

/** What the agent said, in the order it said it, to a User whose log the tests below page. */
const said = ["one", "two", "three", "four", "five", "six", "seven"];

/** A User whose log is longer than any page the tests below ask for. */
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

    // The record is the one the agent's send answered with, byte for byte: one shape on
    // every surface, not a projection per reader (ADR-0034).
    assert.deepEqual(await log(client.token), [first]);
    assert.equal(first.userId, client.id);
    // Outbound, because the agent wrote it, and answered to the User all the same: a
    // Message log is one log in both directions, and this read filters neither (ADR-0035).
    assert.equal(first.direction, "outbound");

    // And the other direction, written by the User themselves at the route beside this one.
    // One log, numbered across both, in the order the two arrived: this is the read being
    // direction-blind rather than only having no parameter to filter with.
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
    // The newest two, still ascending: the descending selection behind a `limit` is
    // invisible from here, so a client concatenates pages without reversing anything.
    assert.deepEqual(numbers(await log(client.token, "?limit=2")), [3, 4]);

    // A cursor above the column's `integer` range is refused rather than reaching the
    // database, where it would come back a 500 carrying the text of the query.
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
    // `after=0` is the log from its beginning, which no other spelling asks for: no cursor
    // at all is the newest page, and `after=1` would skip the first Message.
    assert.deepEqual(numbers(await log(client.token, "?after=0")), [1, 2, 3, 4, 5, 6, 7]);

    // Two windows in one request, which is a client bug worth naming rather than one of the
    // two silently winning.
    const both = await bearing(client.token, "?after=1&before=7");
    assert.equal(both.statusCode, 400);
    assert.match(both.json<{ message: string }>().message, /two different windows/);
  });

  it("reconstructs a log longer than one page, walked backwards then forwards", async () => {
    const client = await withSeven();

    const backwards = await walkBackwards(client, 3);
    const forwards = await walkForwards(client, 3);

    // The two walks share not one page boundary — backwards lands on the end of the log and
    // pages down from it, forwards starts at the beginning — which is what makes the
    // agreement below a claim about the cursor rather than about arithmetic.
    assert.deepEqual(backwards.map(numbers), [[1], [2, 3, 4], [5, 6, 7]]);
    assert.deepEqual(forwards.map(numbers), [[1, 2, 3], [4, 5, 6], [7]]);

    // Concatenated with nothing reversed and nothing merged: each walk is the log exactly
    // once, nothing dropped and nothing repeated.
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

    // There is no parameter anywhere naming a User, so one cannot be read by any spelling
    // of the request: the id comes from the Token and from nowhere a client can write.
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

    // A `?text=hello` answered with the newest fifty Messages reads as though a filter had
    // been applied, so it is refused rather than stripped.
    for (const window of ["?text=hello", "?limt=2", "?before=4&order=desc"]) {
      const refused = await bearing(client.token, window);
      assert.equal(refused.statusCode, 400, window);
      assert.match(refused.json<{ message: string }>().message, /cannot be searched or filtered/);
    }
  });
});

describe("an unauthenticated read", () => {
  it("is the User Manager's single 401, however the Token is missing or refused", async () => {
    const client = await admitted();
    await sent(client.id, "not for a stranger");

    // A Token from a Manager whose Tokens last a millisecond, over the same Db: the row
    // is there and only its `expires_at` is in the past, so an expired Token is reachable
    // without a test waiting for anything.
    const briefly = serverComponent(Fastify(), nowhere);
    createUsers({ db, tokenTtl: 1, scrypt: cheap, publicServer: briefly });
    let expired: string;
    try {
      expired = await tokenFor(client.id, () => briefly.fastify);
    } finally {
      await briefly.stop();
    }

    const refusals = [
      // No header at all.
      await presenting(undefined),
      // A header in another scheme, and the Token with no scheme at all.
      await presenting(`Basic ${Buffer.from(`${client.id}:${password}`).toString("base64")}`),
      await presenting(client.token),
      // A well-formed Token that was never issued, and one issued to this very User that
      // has expired.
      await presenting(`Bearer saf_${"A".repeat(43)}`),
      await presenting(`Bearer ${expired}`),
      // And with a window on it, so the refusal is not a route that only answers bare.
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

    // Byte for byte, not merely equivalent: the Messenger authenticates nobody, so this is
    // the Manager's one refusal reaching a route in another part unchanged (ADR-0030).
    const [first, ...rest] = refusals;
    assert.ok(first !== undefined);
    for (const refused of rest) {
      assert.equal(refused.body, first.body);
    }

    // And the Token that works still works, so every refusal above is about the credential
    // presented rather than about the route being broken.
    assert.equal((await bearing(client.token)).statusCode, 200);
  });

  it("answers a malformed request before it looks at a Token, as GET /auth/me does", async () => {
    // The documented consequence of the query refusal being a `preValidation` hook and the
    // Manager's being a `preHandler`: a stranger asking for something this route does not
    // have is told so, and never gets as far as the 401. Pinned rather than guarded, because
    // a refusal names a parameter of the route and never a User.
    assert.equal((await presenting(undefined, "?text=hello")).statusCode, 400);
    assert.equal((await presenting(undefined, "?limit=201")).statusCode, 400);
  });
});

/**
 * Every page a client gets scrolling up: the newest first, then each page strictly below
 * the oldest number the last one held, until an empty page ends the walk.
 *
 * Returned oldest page first, so the walk reads in the order the log does. The empty page
 * is what ends it, which is why the envelope needs no `hasMore`: a client that asked for
 * `limit` and got fewer already knows, and one that got exactly `limit` asks again.
 */
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

/** Every page a client gets polling forward from the beginning of the log. */
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
