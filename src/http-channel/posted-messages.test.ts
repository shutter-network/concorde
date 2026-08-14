/**
 * A User posts a sentence and a Run happens: the loop the whole framework exists to run,
 * closed.
 *
 * The subject is what a Signal Handler sees, never how a Message or a Signal is stored.
 * Every assertion here is made over HTTP against two real Fastify instances, a **real
 * started Signal Worker** and real PostgreSQL, and nothing inserts or reads a row directly:
 * a Handler registered for `message.received` is what observes the payload, and the
 * worker's own Agent routes are what say how a Signal ended. Both are higher seams than
 * the `signals` table, and the table is deliberately not looked at.
 *
 * The load-bearing test is the attribution one. A submitted Message is the only thing in
 * the framework that says a *person* said something, and the id in its Signal payload is
 * the one the **Token** named — so a client that posts a `userId` of its own must not have
 * it honoured, and the Handler is where that is observable.
 *
 * A whole Gateway per test, because the Handler map is a construction option and each test
 * brings its own: two started workers on one database would break the serial guarantee,
 * so each is constructed, started, and stopped again before the next. The
 * schemas are pushed once up front, the way an Operator applies theirs — every part's
 * together, the tables of Users among them because the foreign key needs it.
 *
 *
 * The Runtime is the one thing faked: what it records is that a Run happened,
 * with the Prompt the Handler wrote.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import type { MessageRecord } from "../messenger/messages.ts";
import { createMessenger, messageReceivedKind } from "../messenger/messenger.ts";
import * as messengerSchema from "../messenger/schema/index.ts";
import { createPasswordAuth, type PasswordAuth } from "../password-auth/password-auth.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import type { ScryptParameters } from "../password-auth/secrets.ts";
import type { Signal, SignalHandlers } from "../signals/handlers.ts";
import type { SignalRecord } from "../signals/routes.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { type FakeRuntime, fakeRuntime } from "../test-support/fake-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createHttpChannel } from "./http-channel.ts";

let database: TestDatabase;
let db: Db;

/** Where the two constructors put their plugins, and where the login route of Password Auth is. */
const prefix = "/messages";
const auth = "/auth";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

/** A cost nobody should deploy, so that a file full of logins runs in a moment. */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

/** The one password in this file. Nothing here is about what a good password is. */
const password = "correct horse battery staple";

/**
 * Close enough that a test never waits long for a Signal, far enough that the notification
 * is what usually finds it. Neither number is asserted on: what a test waits for is the
 * Handler having run, however the worker came to hear about it.
 */
const sweepIntervalMs = 25;

/** The worker's own lines are not this file's subject, and a started worker writes many. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** A User as their client holds them: the id the agent addresses, and a Token they logged in for. */
type Client = {
  readonly id: string;
  readonly token: string;
};

/** One whole Gateway, as a test drives it. */
type Gateway = {
  /** Where a User posts and reads, behind the Public server's own composed hook. */
  readonly publicServer: FastifyInstance;
  /** Where the agent sends and prior Signals are read. */
  readonly agentServer: FastifyInstance;
  /** Every Prompt a Run was started for, in order. */
  readonly runtime: FakeRuntime;
  /** The two parts a User with a password comes from, held so a test can admit one. */
  readonly users: Users;
  readonly passwordAuth: PasswordAuth;
};

before(async () => {
  database = await createTestDatabase("http_messages_posted");
  db = database.db;
  // Pushed here rather than beside a construction, because the parts below are constructed
  // once per test and the tables are created once: this is the Operator's own apply, and
  // one call is the whole of it — a second push into this database would fail on `CREATE
  // SCHEMA`.
  await applySchema(db, signalsSchema, usersSchema, passwordAuthSchema, messengerSchema);
});

after(() => database.drop());

/**
 * A whole Gateway with these Handlers: two servers, a started Signal Worker, a Users
 * component, Password Auth, a Messenger and an HTTP Channel, stopped again afterwards.
 *
 * Everything is constructed in the order an Operator constructs it, and the Messenger after
 * Users — which here is narrative rather than load-bearing, since the migrations are
 * already applied, and is written that way anyway so this file is not the one place the
 * order looks optional.
 */
async function withGateway(
  handlers: SignalHandlers,
  body: (gateway: Gateway) => Promise<void>,
): Promise<void> {
  const agentServer = serverComponent(Fastify(), nowhere);
  const publicServer = serverComponent(Fastify(), nowhere);
  const runtime = fakeRuntime();
  const worker = createSignalWorker({
    db,
    runtime,
    handlers,
    agentServer,
    logger: silent,
    sweepIntervalMs,
  });
  const users = createUsers({ db, agentServer, publicServer });
  // The scheme this file logs in with. It registers itself with the Public server, which is
  // what makes the Channel's two routes able to authenticate anybody.
  const passwordAuth = createPasswordAuth({
    db,
    users,
    publicServer,
    tokenTtl: hour,
    scrypt: cheap,
  });
  // The Channel is not held: every capability under test is a route a constructor registered
  // itself, and no route plugin is exported. The Messenger is built inline
  // because the Channel registers with it and this file reaches the log only over HTTP.
  createHttpChannel({
    db,
    messenger: createMessenger({ db, users, worker, agentServer }),
    publicServer,
  });

  await worker.start();
  try {
    await body({
      publicServer: publicServer.fastify,
      agentServer: agentServer.fastify,
      runtime,
      users,
      passwordAuth,
    });
  } finally {
    await worker.stop();
    await agentServer.stop();
    await publicServer.stop();
  }
}

/**
 * A User with a password, admitted from trusted code, holding a Token they logged in for.
 *
 * Two writes in one transaction, which is the only way a User who can log in exists: no route
 * anywhere creates one.
 */
async function admitted(gateway: Gateway): Promise<Client> {
  const { id } = await db.tx(async (tx) => {
    const user = await gateway.users.create(tx);
    await gateway.passwordAuth.setPassword(tx, user.id, password);
    return user;
  });

  const issued = await gateway.publicServer.inject({
    method: "POST",
    url: `${auth}/tokens`,
    payload: { user: id, password },
  });
  assert.equal(issued.statusCode, 201, `logging in should have answered: ${issued.body}`);
  return { id, token: issued.json<{ token: string }>().token };
}

/** One `POST /messages` on the Public server, with whatever a client presents and sends. */
function posting(
  gateway: Gateway,
  authorization: string | undefined,
  payload: Record<string, unknown>,
) {
  return gateway.publicServer.inject({
    method: "POST",
    url: prefix,
    headers: authorization === undefined ? {} : { authorization },
    payload,
  });
}

/** One post by a User holding a Token, presented in the one scheme this framework mints. */
function bearing(gateway: Gateway, client: Client, payload: Record<string, unknown>) {
  return posting(gateway, `Bearer ${client.token}`, payload);
}

/** Posts a sentence and asserts only that it was accepted. */
async function posted(
  gateway: Gateway,
  client: Client,
  payload: Record<string, unknown>,
): Promise<MessageRecord> {
  const response = await bearing(gateway, client, payload);
  assert.equal(response.statusCode, 201, `POST ${prefix} should have answered: ${response.body}`);
  return response.json<MessageRecord>();
}

/** A User's own log, read the way their client reads it (`own-messages.test.ts`'s subject). */
async function own(gateway: Gateway, client: Client): Promise<MessageRecord[]> {
  const response = await gateway.publicServer.inject({
    method: "GET",
    url: prefix,
    headers: { authorization: `Bearer ${client.token}` },
  });
  assert.equal(response.statusCode, 200, `GET ${prefix} should have answered: ${response.body}`);
  return response.json<{ messages: MessageRecord[] }>().messages;
}

/**
 * The Signals one User's posts emitted, newest first, over the Signal Worker's **own** Agent
 * routes.
 *
 * That seam rather than the `signals` table, because whether a Signal ended `done` or
 * `failed` is the worker's record of its own work and this is where a deployment reads it.
 * Filtered by the User the payload names, because the surface is deliberately unscoped —
 * every Signal, whoever caused it — and every test in this file drives its own
 * Gateway over this file's one database, so the Signals of the tests before it are still
 * there. The filter reads the payload the way a Handler does.
 */
async function emitted(gateway: Gateway, client: Client): Promise<SignalRecord[]> {
  const response = await gateway.agentServer.inject({ method: "GET", url: "/signals" });
  assert.equal(response.statusCode, 200, `GET /signals should have answered: ${response.body}`);
  const signals = response.json<{ signals: SignalRecord[] }>().signals;
  return signals.filter((signal) => payloadUser(signal) === client.id);
}

/** The User a Signal's payload names, if it names one at all. */
function payloadUser(signal: SignalRecord): string | undefined {
  const payload = signal.payload;
  if (typeof payload !== "object" || payload === null || !("userId" in payload)) return undefined;
  return typeof payload.userId === "string" ? payload.userId : undefined;
}

/** A Handler that records what it was given, and asks for one Run per Message. */
function recording(seen: Signal<MessageRecord>[], prompts: readonly string[] = []): SignalHandlers {
  return {
    [messageReceivedKind]: {
      handle(signal: Signal<MessageRecord>) {
        seen.push(signal);
        return prompts.map((text) => ({ session: `user_${signal.payload.userId}`, text }));
      },
    },
  };
}

describe("a User posting a Message", () => {
  it("wakes a Handler with the whole record, and the Run happens", async () => {
    const seen: Signal<MessageRecord>[] = [];
    // One Prompt, in the Session named after the User, which is what an Operator's own
    // Handler does with the payload it was handed.
    await withGateway(recording(seen, ["what happened to the deploy?"]), async (gateway) => {
      const client = await admitted(gateway);
      const message = await posted(gateway, client, {
        text: "what happened to the deploy?",
      });

      assert.match(message.id, /^[0-9a-f-]{36}$/);
      assert.equal(message.userId, client.id);
      // Inbound, decided by the server the request arrived on, and numbered in the same
      // sequence the agent's answers are.
      assert.equal(message.direction, "inbound");
      assert.equal(message.seq, 1);
      assert.equal(message.text, "what happened to the deploy?");
      assert.equal(new Date(message.createdAt).toISOString(), message.createdAt);

      // The 201 is not a promise about later: the record is stored and the User can read it
      // back before anything downstream has happened at all.
      assert.deepEqual(await own(gateway, client), [message]);

      await waitUntil("the Handler for message.received has run", async () => seen.length === 1);
      const signal = seen[0];
      assert.ok(signal !== undefined);
      assert.equal(signal.kind, messageReceivedKind);
      // The payload **is** the record, flat and whole — text, User id, time, id, direction
      // and `seq` — rather than a projection kept parallel by hand.
      assert.deepEqual(signal.payload, message);

      await waitUntil("the Run has finished", async () => gateway.runtime.texts().length === 1);
      assert.deepEqual(gateway.runtime.texts(), ["what happened to the deploy?"]);
      assert.equal(gateway.runtime.recorded[0]?.session, `user_${client.id}`);
      assert.equal(gateway.runtime.overlapped, false);

      // And the Signal ends `done`, which is the worker's own record of the arrival: the
      // whole loop, from a sentence typed by a person to a Run that finished.
      await waitUntil("the Signal has finished", async () => {
        const [only] = await emitted(gateway, client);
        return only?.state === "done";
      });
      const [only] = await emitted(gateway, client);
      assert.equal(only?.error, null);
      assert.deepEqual(only?.payload, message);
    });
  });

  it("attributes it to the User the Token named, whatever the client wrote", async () => {
    const seen: Signal<MessageRecord>[] = [];
    // No Prompt: this test is about who the Message came from, and a Run would only be
    // another thing to wait for.
    await withGateway(recording(seen), async (gateway) => {
      const client = await admitted(gateway);
      const other = await admitted(gateway);

      // Everything a client could try to decide for itself, in one body: whose Message it
      // is, which way it went, where it sits in the log, and when. `additionalProperties:
      // false` drops each of them, so an attribution the Handler is about to trust cannot
      // be written by whoever is typing.
      const message = await posted(gateway, client, {
        text: "it was me, honestly",
        userId: other.id,
        user: other.id,
        direction: "outbound",
        seq: 99,
        id: "3c1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21",
        createdAt: new Date(0).toISOString(),
      });

      assert.equal(message.userId, client.id);
      assert.equal(message.direction, "inbound");
      assert.equal(message.seq, 1);
      assert.notEqual(message.id, "3c1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21");
      assert.ok(Date.parse(message.createdAt) > 0);

      await waitUntil("the Handler for message.received has run", async () => seen.length === 1);
      // The load-bearing assertion of this file: the id a Handler acts on is the one the
      // Users component authenticated, read off the request and never out of the body.
      assert.equal(seen[0]?.payload.userId, client.id);
      assert.deepEqual(seen[0]?.payload, message);

      // And the other User's log is untouched, which is the same claim from their side.
      assert.deepEqual(await own(gateway, other), []);
      assert.deepEqual(await own(gateway, client), [message]);
    });
  });

  it("numbers posts arriving at once distinctly and without gaps, and wakes for each", async () => {
    const seen: Signal<MessageRecord>[] = [];
    await withGateway(recording(seen), async (gateway) => {
      const client = await admitted(gateway);

      // Five at once, which is the most a bound of five serves deterministically: each loss
      // means somebody else committed the number this post had computed, and a post's target
      // strictly increases. Inbound is the direction that made the retry necessary — a
      // person's client can post twice before either write lands, where the agent's sends
      // are the serial worker's — and it is the path the **savepoint** exists for: the
      // insert shares a transaction with the emit, so a constraint violation without one
      // would abort the whole thing and take the Signal with it.
      const at = ["one", "two", "three", "four", "five"];
      const posts = await Promise.all(
        at.map((which) => posted(gateway, client, { text: `all at once: ${which}` })),
      );

      assert.deepEqual(
        posts.map((message) => message.seq).sort((a, b) => a - b),
        [1, 2, 3, 4, 5],
      );
      const stored = await own(gateway, client);
      assert.deepEqual(
        stored.map((message) => message.seq),
        [1, 2, 3, 4, 5],
      );
      assert.deepEqual(
        stored.map((message) => message.text).sort(),
        at.map((which) => `all at once: ${which}`).sort(),
      );

      // And each of them is an arrival of its own: five Messages, five Signals, five
      // Handler runs. A burst is one notification and the worker drains, so a lost Signal
      // here would be a Message the agent never hears about.
      await waitUntil("every post has reached the Handler", async () => seen.length === 5);
      assert.deepEqual(
        seen.map((signal) => signal.payload.seq).sort((a, b) => a - b),
        [1, 2, 3, 4, 5],
      );
    });
  });

  it("refuses a body with nothing in it to say, and stores nothing", async () => {
    await withGateway({}, async (gateway) => {
      const client = await admitted(gateway);

      // An empty `text` is a 400 rather than a blank bubble, and a stray keypress does not
      // start a Run. There is no `maxLength` to test: the server's `bodyLimit` is the bound
      // and it is the Operator's. A JSON *number* is absent from this list on
      // purpose: Fastify's own ajv coerces one to its digits, which is that server's
      // configuration rather than this route's, and a Message reading `42` breaks nothing.
      for (const body of [{ text: "" }, {}, { text: ["one", "two"] }, { text: null }]) {
        assert.equal((await bearing(gateway, client, body)).statusCode, 400, JSON.stringify(body));
      }

      // A query parameter on a route that takes none is refused with this part's own
      // sentence, as it is on the reads.
      const queried = await gateway.publicServer.inject({
        method: "POST",
        url: `${prefix}?user=${client.id}`,
        headers: { authorization: `Bearer ${client.token}` },
        payload: { text: "hello" },
      });
      assert.equal(queried.statusCode, 400, queried.body);
      assert.match(queried.json<{ message: string }>().message, /read by cursor/);

      assert.deepEqual(await own(gateway, client), []);
      assert.deepEqual(await emitted(gateway, client), []);
    });
  });

  it("is the single 401 of Users when nobody is behind it", async () => {
    await withGateway({}, async (gateway) => {
      const client = await admitted(gateway);
      const said = { text: "let me in" };

      const refusals = [
        // No header at all, a header in another scheme, the Token with no scheme, and a
        // well-formed Token that was never issued.
        await posting(gateway, undefined, said),
        await posting(
          gateway,
          `Basic ${Buffer.from(`${client.id}:${password}`).toString("base64")}`,
          said,
        ),
        await posting(gateway, client.token, said),
        await posting(gateway, `Bearer concorde_${"A".repeat(43)}`, said),
      ];

      for (const refused of refusals) {
        assert.equal(refused.statusCode, 401, refused.body);
        assert.deepEqual(refused.json(), {
          statusCode: 401,
          error: "Unauthorized",
          message: "authentication failed",
        });
      }

      // Byte for byte, not merely equivalent: this part authenticates nobody, so every
      // refusal is the one 401 of Users reaching a route in another part.
      const [first, ...rest] = refusals;
      assert.ok(first !== undefined);
      for (const refused of rest) assert.equal(refused.body, first.body);

      // The documented consequence of the hook running at `preHandler`: a body this route
      // could not accept from anybody is refused before a Token is looked at, which is the
      // order `GET /auth/me` and the read already answer in. Pinned, not guarded — a
      // refusal names a field of the route and never a User.
      assert.equal((await posting(gateway, undefined, { text: "" })).statusCode, 400);

      // Nothing was stored for anyone, and nothing woke the worker.
      assert.deepEqual(await own(gateway, client), []);
      assert.deepEqual(await emitted(gateway, client), []);
      assert.deepEqual(gateway.runtime.texts(), []);
    });
  });

  it("stores the Message and fails the Signal when no Handler is registered", async () => {
    // A 201 followed by a permanently failed Signal: the Message is durable regardless of
    // what happens downstream, and the failure is visible only on the Signal row. Pinned
    // rather than guarded — the Messenger inspecting the Handler map would reach into the
    // Worker for something a Handler is meant to answer itself.
    await withGateway({}, async (gateway) => {
      const client = await admitted(gateway);
      const message = await posted(gateway, client, { text: "is anybody there?" });

      await waitUntil("the Signal has failed", async () => {
        const [only] = await emitted(gateway, client);
        return only?.state === "failed";
      });
      const [only] = await emitted(gateway, client);
      assert.equal(only?.kind, messageReceivedKind);
      assert.match(
        only?.error ?? "",
        /no Signal Handler is registered for kind "message\.received"/,
      );

      // Stored and readable all the same, and the agent never saw it.
      assert.deepEqual(await own(gateway, client), [message]);
      assert.deepEqual(gateway.runtime.texts(), []);
    });
  });
});
