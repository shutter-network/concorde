/**
 * What trusted code can do that no request can: answer somebody from inside its own
 * transaction, and read a whole Message log without one.
 *
 * A Signal Handler and an Operator's entry point are trusted code (ADR-0009, ADR-0020) and
 * hold the object the constructor returns. These two methods are the whole of that object,
 * and the pair is what makes the **post phase** useful for messaging: a Handler told that a
 * Run failed can tell the person who asked (ADR-0017), which nothing else in the framework
 * can do.
 *
 * The subject is still what a client can observe. There is no second seam for these methods
 * and deliberately no route of their own, so they are reached the way an Operator reaches
 * them, in a transaction of this file's own, and confirmed the way the Users component
 * confirms its trusted surface: over HTTP, on the User's own route and the agent's, against
 * real Fastify instances and real PostgreSQL. **The two methods are the only path to a row
 * anywhere in this file**: nothing here writes SQL of its own, holds a handle, or names a
 * column.
 *
 * Two tests are the reason the file exists:
 *
 *  - `commits with the caller's own write, and a rollback loses both` is what taking the
 *    transaction first buys (ADR-0023). A Handler answering somebody and recording in its own
 *    tables why must commit as one, and the rollback half is the failure the split exists to
 *    prevent: a Message sent about a decision that was never recorded.
 *  - `is not capped at the limit the routes cap` is the one place the two surfaces
 *    deliberately differ. The cap bounds a response body a stranger or the agent reads, and
 *    trusted code asking for two hundred and one Messages is not in that case.
 *
 * The Signal Worker stands in for the Operator's own tables in the transaction tests: a
 * Signal is a write in another part's schema, observable over the worker's own Agent routes,
 * which is a higher seam than any table this file could have created for itself. It is never
 * started, so nothing is drained and nothing dispatched.
 *
 * A database of this file's own, because no two test files may share one, and a deliberately
 * cheap scrypt cost, because every Token here starts with a login.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type Component, serverComponent } from "../gateway/components.ts";
import { createHttpChannel } from "../http-channel/http-channel.ts";
import type { Logger } from "../logging/logging.ts";
import type { SignalRecord } from "../signals/routes.ts";
import * as signalsSchema from "../signals/schema.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import type { UserRecord } from "../users/routes.ts";
import * as usersSchema from "../users/schema.ts";
import type { ScryptParameters } from "../users/secrets.ts";
import { createUsers } from "../users/users.ts";
import type { MessageRecord } from "./messages.ts";
import { createMessenger, type Messenger } from "./messenger.ts";
import * as messengerSchema from "./schema.ts";

let database: TestDatabase;
let db: Db;
/** The object under test, held the way a Signal Handler holds it. */
let messenger: Messenger;
let worker: SignalWorker;
/** Both servers, as an Operator constructs them: bare Fastify instances in a start order. */
let agentServer: Component & { readonly fastify: FastifyInstance };
let publicServer: Component & { readonly fastify: FastifyInstance };

/** Where the two constructors put their plugins, and where the login route of Users is. */
const prefix = "/messages";
const auth = "/auth";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

/** A cost nobody should deploy, so that a file full of logins runs in a moment. */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

/** The one password in this file. Nothing here is about what a good password is. */
const password = "correct horse battery staple";

/** A well-formed id that names nobody, for the send that must refuse one. */
const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

/** Nothing here starts the worker, so nothing should be printed by one. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** A User as their client holds them: the id trusted code addresses, and a Token they bought. */
type Client = {
  readonly id: string;
  readonly token: string;
};

before(async () => {
  database = await createTestDatabase("http_messages_trusted");
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
  // Both servers, so that `POST /users` and the login under `/auth` exist: a Token here is
  // bought with a password at the login route of Users. Both parts take it, so it is
  // constructed first; the foreign key's ordering is the push's to arrange (ADR-0046).
  const users = createUsers({ db, tokenTtl: hour, scrypt: cheap, agentServer, publicServer });
  // And held, which this file is the first to have a reason to do.
  messenger = createMessenger({ db, users, worker, agentServer });
  createHttpChannel({ db, messenger, users, publicServer });

  // The schema of Users alongside the Messenger's, because `messages.user_id` references
  // `saf_users.users.id` and one push has to see both (ADR-0036, ADR-0046).
  await applySchema(db, signalsSchema, usersSchema, messengerSchema);
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await worker.stop();
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

  const issued = await publicServer.fastify.inject({
    method: "POST",
    url: `${auth}/tokens`,
    payload: { user: id, password },
  });
  assert.equal(issued.statusCode, 201, `logging in should have answered: ${issued.body}`);
  return { id, token: issued.json<{ token: string }>().token };
}

/** One Message from a User, posted the way their own client posts one. */
async function posted(client: Client, text: string): Promise<MessageRecord> {
  const response = await publicServer.fastify.inject({
    method: "POST",
    url: prefix,
    headers: { authorization: `Bearer ${client.token}` },
    payload: { text },
  });
  assert.equal(response.statusCode, 201, `posting should have answered: ${response.body}`);
  return response.json<MessageRecord>();
}

/** A User's own log, read the way their client reads it. */
async function own(client: Client, window = ""): Promise<MessageRecord[]> {
  const response = await publicServer.fastify.inject({
    method: "GET",
    url: `${prefix}${window}`,
    headers: { authorization: `Bearer ${client.token}` },
  });
  assert.equal(response.statusCode, 200, `GET ${prefix} should have answered: ${response.body}`);
  return response.json<{ messages: MessageRecord[] }>().messages;
}

/**
 * The same log as the agent reads it, which is the other surface these methods must agree
 * with.
 *
 * The window arrives spelled the way a User's own read spells it, since the two are compared,
 * and the `?` becomes an `&` because this route has the required `user` in front of it.
 */
async function asAgent(userId: string, window = ""): Promise<MessageRecord[]> {
  const response = await agentServer.fastify.inject({
    method: "GET",
    url: `${prefix}?user=${userId}${window.replace("?", "&")}`,
  });
  assert.equal(response.statusCode, 200, `the agent's read should have answered: ${response.body}`);
  return response.json<{ messages: MessageRecord[] }>().messages;
}

/**
 * The Signals of one kind, over the Signal Worker's **own** Agent routes.
 *
 * That seam rather than the `signals` table: what a transaction did or did not commit is
 * observable where a deployment reads it, and this file writes one to stand in for whatever
 * the Operator's own tables would have recorded.
 */
async function signals(kind: string): Promise<SignalRecord[]> {
  const response = await agentServer.fastify.inject({
    method: "GET",
    url: `/signals?kind=${kind}`,
  });
  assert.equal(response.statusCode, 200, `GET /signals should have answered: ${response.body}`);
  return response.json<{ signals: SignalRecord[] }>().signals;
}

/** The `seq` of each Message in a page, which is what most assertions here are about. */
function numbers(messages: readonly MessageRecord[]): number[] {
  return messages.map((message) => message.seq);
}

describe("a Handler sending a Message", () => {
  it("writes it inside its own transaction, and the User reads it back", async () => {
    const client = await admitted();

    // The call as a Handler writes it: the transaction first, then who and what (ADR-0023).
    const answered = await db.tx((tx) => messenger.send(tx, client.id, "the deploy finished"));

    assert.match(answered.id, /^[0-9a-f-]{36}$/);
    assert.equal(answered.userId, client.id);
    // Outbound, with no parameter that could have said otherwise: trusted code has no path
    // that writes an inbound Message (ADR-0034).
    assert.equal(answered.direction, "outbound");
    assert.equal(answered.seq, 1);
    assert.equal(answered.text, "the deploy finished");
    assert.equal(new Date(answered.createdAt).toISOString(), answered.createdAt);

    // Read back on the User's own route, which is the only confirmation that matters: the
    // person the Handler was answering can see the answer.
    assert.deepEqual(await own(client), [answered]);
    // And on the agent's, byte for byte: one shape on every surface (ADR-0034).
    assert.deepEqual(await asAgent(client.id), [answered]);

    // One log across both directions, numbered in the order the writes arrived: a person
    // replying to what a Handler said is the next number, and the Handler's next answer the
    // one after (ADR-0035).
    const replied = await posted(client, "thanks for letting me know");
    const again = await db.tx((tx) => messenger.send(tx, client.id, "and the migration ran"));
    assert.equal(replied.direction, "inbound");
    assert.deepEqual(numbers(await own(client)), [1, 2, 3]);
    assert.deepEqual(await own(client), [answered, replied, again]);
  });

  it("commits with the caller's own write, and a rollback loses both", async () => {
    const client = await admitted();

    // The pattern the post phase uses: tell the person, and record why in the caller's own
    // tables. A Signal stands in for those tables here, because it is a write in another
    // part's schema that is observable over HTTP.
    const told = await db.tx(async (tx) => {
      const message = await messenger.send(tx, client.id, "that run failed, sorry");
      await worker.emit(tx, { kind: "run.reported", payload: { messageId: message.id } });
      return message;
    });

    assert.deepEqual(await own(client), [told]);
    assert.deepEqual(
      (await signals("run.reported")).map((signal) => signal.payload),
      [{ messageId: told.id }],
    );

    // And the half the split exists for. Ambient enlistment is not available: a second
    // handle takes its own connection from the pool and its write would survive this
    // rollback with nothing reported, which is why both calls take the transaction rather
    // than finding one, and neither of them happened.
    let attempted: MessageRecord | undefined;
    await assert.rejects(
      db.tx(async (tx) => {
        attempted = await messenger.send(tx, client.id, "that run failed too");
        await worker.emit(tx, { kind: "run.reported", payload: { messageId: attempted.id } });
        throw new Error("the Handler's own write failed");
      }),
      /the Handler's own write failed/,
    );

    assert.ok(attempted !== undefined, "the Message should have been written before the rollback");
    assert.deepEqual(await own(client), [told], "the Message should not have been sent");
    assert.deepEqual(
      (await signals("run.reported")).map((signal) => signal.payload),
      [{ messageId: told.id }],
      "the Handler's own write should have gone with it",
    );
  });

  it("answers with the record, which is what a caller cannot read back", async () => {
    const client = await admitted();

    // A read takes no transaction, so it is on another connection and cannot see an
    // uncommitted write (ADR-0023). Everything the caller needs is what `send` returned,
    // which is why there is no read-back for this to be a surprise about.
    const inside = await db.tx(async (tx) => {
      const message = await messenger.send(tx, client.id, "written but not committed");
      assert.deepEqual(await messenger.history(client.id), [], "the read is on another connection");
      assert.deepEqual(await own(client), [], "and so is the User's own route");
      return message;
    });

    assert.deepEqual(await messenger.history(client.id), [inside]);
    assert.deepEqual(await own(client), [inside]);
  });

  it("throws when no User has that id, rather than writing a row nobody can read", async () => {
    const client = await admitted();

    // The foreign key refusing, which is the only enforcement: there is no lookup in front of
    // the write, and trusted code gets the refusal as an error because there is no reply to
    // write a 404 into (ADR-0036).
    await assert.rejects(
      db.tx((tx) => messenger.send(tx, nobody, "into the void")),
      new RegExp(`no User ${nobody} exists`),
    );
    assert.deepEqual(await asAgent(nobody), [], "nothing should have been written for nobody");

    // And the caller's transaction survives it, which is what the savepoint inside the insert
    // is for: a refused send would otherwise abort everything the caller was keeping it
    // company with. A Handler that catches may carry on.
    const carried = await db.tx(async (tx) => {
      await assert.rejects(messenger.send(tx, nobody, "into the void again"));
      await worker.emit(tx, { kind: "run.recovered", payload: { of: client.id } });
      return messenger.send(tx, client.id, "sent after a refusal in the same transaction");
    });

    assert.deepEqual(await own(client), [carried]);
    assert.equal((await signals("run.recovered")).length, 1);
  });
});

describe("a Handler reading a Message log", () => {
  /** A User whose log is longer than any page the tests below ask for. */
  async function withSeven(): Promise<Client> {
    const client = await admitted();
    // Written in one transaction, which is the shape trusted code has and a request does
    // not: seven statements, one commit.
    await db.tx(async (tx) => {
      for (const text of ["one", "two", "three", "four", "five", "six", "seven"]) {
        await messenger.send(tx, client.id, text);
      }
    });
    return client;
  }

  it("answers the same records the two routes answer", async () => {
    const client = await withSeven();
    // One inbound among them, so the read being direction-blind is observable here too.
    await posted(client, "eight, from me");

    // The same query reached three ways, by a Token, a query parameter and an argument. The
    // whole point of there being one implementation is that these cannot disagree about what
    // a cursor means (ADR-0035).
    for (const [window, asked] of [
      ["", {}],
      ["?limit=3", { limit: 3 }],
      ["?before=4", { before: 4 }],
      ["?before=4&limit=2", { before: 4, limit: 2 }],
      ["?after=5", { after: 5 }],
      ["?after=0&limit=100", { after: 0, limit: 100 }],
      ["?after=7", { after: 7 }],
      ["?before=1", { before: 1 }],
    ] as const) {
      const answered = await messenger.history(client.id, asked);
      assert.deepEqual(answered, await own(client, window), `the User's own read: ${window}`);
      assert.deepEqual(answered, await asAgent(client.id, window), `the agent's read: ${window}`);
    }

    // Ascending in every case, whatever the window, and both directions in it.
    assert.deepEqual(numbers(await messenger.history(client.id)), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(
      (await messenger.history(client.id, { limit: 2 })).map((message) => message.direction),
      ["outbound", "inbound"],
    );

    // Any User's log, and not only the one a Run is serving (ADR-0011).
    const other = await admitted();
    await db.tx((tx) => messenger.send(tx, other.id, "meant for somebody else"));
    assert.deepEqual(
      (await messenger.history(other.id)).map((message) => message.text),
      ["meant for somebody else"],
    );
  });

  it("is not capped at the limit the routes cap", async () => {
    const client = await admitted();
    // Two hundred and one, one more than the routes' cap, written in one transaction.
    const many = 201;
    await db.tx(async (tx) => {
      for (let each = 1; each <= many; each += 1) {
        await messenger.send(tx, client.id, `number ${each}`);
      }
    });

    // The cap bounds a response body a stranger or the agent reads, and a Handler building a
    // Prompt from a long history is not in that case: it asks for all of them and gets them.
    const whole = await messenger.history(client.id, { limit: many });
    assert.equal(whole.length, many);
    assert.deepEqual(
      numbers(whole),
      Array.from({ length: many }, (_, index) => index + 1),
    );

    // While the same number on either route is a 400 from the shared schema, which is what
    // makes the difference deliberate rather than an oversight in one place or the other.
    const byTheAgent = await agentServer.fastify.inject({
      method: "GET",
      url: `${prefix}?user=${client.id}&limit=${many}`,
    });
    assert.equal(byTheAgent.statusCode, 400, byTheAgent.body);
    const byTheUser = await publicServer.fastify.inject({
      method: "GET",
      url: `${prefix}?limit=${many}`,
      headers: { authorization: `Bearer ${client.token}` },
    });
    assert.equal(byTheUser.statusCode, 400, byTheUser.body);
  });

  it("defaults to the number the routes default to", async () => {
    // The default is shared rather than restated, so a deployment reading a log from trusted
    // code and a client reading it over HTTP see the same page size.
    const client = await admitted();
    await db.tx(async (tx) => {
      for (let each = 1; each <= 55; each += 1) {
        await messenger.send(tx, client.id, `number ${each}`);
      }
    });

    const page = await messenger.history(client.id);
    assert.equal(page.length, 50);
    // The newest page, ascending, which is what no cursor at all means everywhere.
    assert.deepEqual(
      numbers(page),
      Array.from({ length: 50 }, (_, index) => index + 6),
    );
    assert.deepEqual(page, await own(client));
  });
});

describe("the object the constructor answers with", () => {
  it("carries a send and a read, and nothing that writes an inbound Message", async () => {
    // An assertion of **absence**, and the reason it is the object's own keys rather than a
    // list of names to probe: a method added later appears here and fails this. There is no
    // `receive`, no `submit` and no `direction` parameter anywhere on it, because trusted code
    // does not get a path that puts words in a User's mouth (ADR-0034). `register` answers with
    // the inbound write, and a Channel's constructor is what calls it (ADR-0048), which is
    // `channels.test.ts`'s subject.
    //
    // `start` and `stop` are the two that do nothing, and they are here because this part is
    // in the Gateway's record like every other one (ADR-0037). They are the whole of what
    // membership added: two names, and no further capability.
    assert.deepEqual(Object.keys(messenger).sort(), [
      "history",
      "register",
      "send",
      "start",
      "stop",
    ]);

    // Which is what makes the claim checkable from outside as well: every Message trusted code
    // can write is outbound, and the only inbound one in this log arrived on the Public server
    // with a Token behind it.
    const client = await admitted();
    await db.tx((tx) => messenger.send(tx, client.id, "from a Handler"));
    await posted(client, "from the person");
    assert.deepEqual(
      (await messenger.history(client.id)).map((message) => message.direction),
      ["outbound", "inbound"],
    );
  });
});
