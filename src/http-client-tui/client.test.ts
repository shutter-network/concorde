/**
 * The client against the routes it is a client of: a real Users component, a real Messenger and a
 * real HTTP Channel on a Fastify instance **listening on a real socket**, driven with the real
 * `fetch` the shipped binary uses. Nothing is injected in place of the network here, because the
 * question this file answers is whether the two agree about a wire format, and a stub would answer
 * whatever it was written to answer.
 *
 * The one part not driven this way is the retry, which needs a Gateway that answers nothing. It has
 * a test of its own beside `retry.ts`, and what is checked here is only that a refused connection
 * arrives as the error the retry is written against.
 *
 * The agent's half of a conversation is written through the Messenger's programmatic API rather
 * than over the Agent server. It is the same insert, and this file's subject is the Public routes.
 *
 * A User of its own per test, because a cursor is per User: two tests sharing one would each read
 * what the other said.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { serverComponent } from "../gateway/components.ts";
import { createHttpChannel } from "../http-channel/http-channel.ts";
import type { Logger } from "../logging/logging.ts";
import { createMessenger, type Messenger } from "../messenger/messenger.ts";
import * as messengerSchema from "../messenger/schema/index.ts";
import { createPasswordAuth, type PasswordAuth } from "../password-auth/password-auth.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import type { ScryptParameters } from "../password-auth/secrets.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import { type Client, createClient, RefusedError, UnreachableError, urlFor } from "./client.ts";

let database: TestDatabase;
let db: Db;
let users: Users;
let passwordAuth: PasswordAuth;
let messenger: Messenger;
let publicServer: FastifyInstance;

/** Where the Public server ended up listening, which is what the client is pointed at. */
let baseUrl: string;

const hour = 60 * 60 * 1000;

/** A cost nobody should deploy, so that a file full of logins runs in a moment. */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

const password = "correct horse battery staple";

/** Nothing here starts a worker, and the lines one writes are not this file's subject. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * A port nothing can be listening on: binding it needs privileges no test run has, so a connection
 * to it is refused rather than answered by whatever else the developer is running.
 */
const nothingListensHere = "http://127.0.0.1:1";

before(async () => {
  database = await createTestDatabase("http_client_tui");
  db = database.db;
  await applySchema(db, signalsSchema, usersSchema, passwordAuthSchema, messengerSchema);

  const agentServer = { fastify: Fastify() };
  const server = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  publicServer = server.fastify;
  // Unstarted: a submitted Message writes a Signal row that nothing has to pick up, the Run being
  // no part of what a client sees.
  const worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {}, logger: silent });
  users = createUsers({ db, agentServer, publicServer: server });
  // The scheme this client logs in with: `POST /auth/tokens` is Password Auth's route now, and
  // registering it with the server is what makes the Channel's two routes authenticate anybody
  // (ADR-0052).
  passwordAuth = createPasswordAuth({
    db,
    users,
    publicServer: server,
    tokenTtl: hour,
    scrypt: cheap,
  });
  messenger = createMessenger({ db, users, worker, agentServer });
  createHttpChannel({ db, messenger, publicServer: server });

  baseUrl = await publicServer.listen({ port: 0, host: "127.0.0.1" });
});

after(async () => {
  await publicServer.close();
  await database.drop();
});

/** A User who can log in: admitted and given the one password in this file, in one transaction. */
function admitted(): Promise<string> {
  return db.tx(async (tx) => {
    const created = await users.create(tx);
    await passwordAuth.setPassword(tx, created.id, password);
    return created.id;
  });
}

/** A User with a password, and a client logged in as them. */
async function loggedIn(): Promise<{ readonly id: string; readonly client: Client }> {
  const id = await admitted();
  const client = createClient({ baseUrl });
  await client.logIn({ user: id, password });
  return { id, client };
}

/** The agent's half, written the way a Signal Handler writes it. */
function agentSays(userId: string, text: string) {
  return db.tx((tx) => messenger.send(tx, userId, text));
}

describe("joining a URL onto a base", () => {
  it("keeps a path the base carries, so a Gateway behind a prefix is reachable", () => {
    assert.equal(urlFor("http://host:8080/saf", "messages"), "http://host:8080/saf/messages");
    assert.equal(
      urlFor("http://host:8080/saf/", "auth/tokens"),
      "http://host:8080/saf/auth/tokens",
    );
  });

  it("writes the window as query parameters", () => {
    assert.equal(
      urlFor("http://host:8080", "messages", { after: "7", limit: "200" }),
      "http://host:8080/messages?after=7&limit=200",
    );
  });
});

describe("logging in", () => {
  it("trades the password for a Token and answers with the User it belongs to", async () => {
    const id = await admitted();
    const issued = await createClient({ baseUrl }).logIn({ user: id, password });
    assert.equal(issued.user.id, id);
    assert.ok(issued.token.length > 0);
    assert.ok(Date.parse(issued.expiresAt) > Date.now());
  });

  it("is refused with the Gateway's own sentence when the password is wrong", async () => {
    const id = await admitted();
    await assert.rejects(
      createClient({ baseUrl }).logIn({ user: id, password: "nope" }),
      (error: unknown) => {
        assert.ok(error instanceof RefusedError, `expected a refusal, and got ${String(error)}`);
        assert.equal(error.status, 401);
        assert.match(error.message, /authentication failed/);
        return true;
      },
    );
  });

  it("presents the Token on everything after it", async () => {
    const id = await admitted();
    const client = createClient({ baseUrl });
    await assert.rejects(client.open(), (error: unknown) => {
      assert.ok(error instanceof RefusedError);
      assert.equal(error.status, 401);
      return true;
    });
    await client.logIn({ user: id, password });
    assert.deepEqual(await client.open(), []);
  });
});

describe("a refused connection", () => {
  it("arrives as the one error the retry is written against", async () => {
    const client = createClient({ baseUrl: nothingListensHere });
    await assert.rejects(client.logIn({ user: "whoever", password }), (error: unknown) => {
      assert.ok(error instanceof UnreachableError, `expected no answer, and got ${String(error)}`);
      assert.match(error.message, /no answer from http:\/\/127\.0\.0\.1:1\//);
      return true;
    });
  });
});

describe("opening a log", () => {
  it("answers the newest page oldest first, and starts the cursor past it", async () => {
    const { id, client } = await loggedIn();
    await agentSays(id, "one");
    await agentSays(id, "two");

    const opened = await client.open();
    assert.deepEqual(
      opened.map((record) => [record.seq, record.direction, record.text]),
      [
        [1, "outbound", "one"],
        [2, "outbound", "two"],
      ],
    );
    // The cursor is past what was printed, so the same Messages do not arrive again.
    assert.deepEqual(await client.poll(), []);
  });

  it("answers nothing for a User who has said nothing", async () => {
    const { client } = await loggedIn();
    assert.deepEqual(await client.open(), []);
    assert.deepEqual(await client.poll(), []);
  });
});

describe("polling", () => {
  it("walks forwards, so each Message arrives once", async () => {
    const { id, client } = await loggedIn();
    await client.open();

    await agentSays(id, "the deploy finished");
    assert.deepEqual(
      (await client.poll()).map((record) => record.text),
      ["the deploy finished"],
    );
    assert.deepEqual(await client.poll(), []);

    await agentSays(id, "and the tests passed");
    assert.deepEqual(
      (await client.poll()).map((record) => record.text),
      ["and the tests passed"],
    );
  });

  it("reads a log from its beginning when it was opened empty", async () => {
    const { id, client } = await loggedIn();
    await client.open();
    await agentSays(id, "the first thing ever said");
    assert.deepEqual(
      (await client.poll()).map((record) => record.seq),
      [1],
    );
  });

  it("reads only the presented User's own log", async () => {
    const mine = await loggedIn();
    const theirs = await loggedIn();
    await agentSays(theirs.id, "not for you");
    await agentSays(mine.id, "for you");

    assert.deepEqual(
      (await mine.client.poll()).map((record) => record.text),
      ["for you"],
    );
  });
});

describe("saying something", () => {
  it("submits an inbound Message and answers with the stored record", async () => {
    const { id, client } = await loggedIn();
    const said = await client.say("what happened?");
    assert.equal(said.direction, "inbound");
    assert.equal(said.userId, id);
    assert.equal(said.text, "what happened?");
    assert.equal(said.seq, 1);
  });

  it("does not read its own submission back, the typist having seen it once", async () => {
    const { id, client } = await loggedIn();
    await client.open();
    await client.say("what happened?");
    await agentSays(id, "the deploy finished");

    assert.deepEqual(
      (await client.poll()).map((record) => record.text),
      ["the deploy finished"],
    );
  });

  it("advances the cursor past its own submission all the same", async () => {
    const { client } = await loggedIn();
    await client.open();
    await client.say("one");
    await client.say("two");
    assert.deepEqual(await client.poll(), []);
    assert.deepEqual(await client.poll(), []);
  });

  it("is refused with the Gateway's own sentence when there is nothing to send", async () => {
    const { client } = await loggedIn();
    await assert.rejects(client.say(""), (error: unknown) => {
      assert.ok(error instanceof RefusedError, `expected a refusal, and got ${String(error)}`);
      assert.equal(error.status, 400);
      return true;
    });
  });
});
