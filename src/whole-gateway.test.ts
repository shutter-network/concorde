/**
 * Every part of a deployment in one record, and the one rule the order comes from.
 *
 * `components.test.ts` owns the ordering contract and proves it with mocks: key order out,
 * reverse order back, unwind on a failed start. What it cannot say is that the framework's
 * own six parts *fit* that record, or that the order the reference deployment writes is the
 * right one. This file is the other half. Every part here is real — real PostgreSQL, two
 * real Fastify instances on real sockets, a real started Signal Worker, the real User
 * Manager and the real HTTP Messenger — and the Runtime is the one thing faked, as
 * everywhere else (ADR-0022).
 *
 * The record is the reference deployment's:
 *
 *     db -> agentServer -> publicServer -> users -> messenger -> worker
 *
 * and it comes from one rule. **The Signal Worker's `stop` is the only stop that does
 * work.** Every other one releases something; the worker's waits for the Run in flight and
 * never cancels it (ADR-0017), and that Run reads the Db, calls the Agent server and reaches
 * the Messenger through a Signal Handler's post phase. So the drain goes first, while
 * everything it uses is still up (ADR-0038).
 *
 * That is what the last test asserts, and it is the assertion `src/pi/container.test.ts`
 * says it does not make: a Run is parked in flight, `stop` is called around it, and the Run
 * then reaches every part it is entitled to reach. Nothing is inspected from the side —
 * the report comes back from inside the Run itself, which is the only vantage point from
 * which "still up during the drain" is a fact rather than a guess.
 *
 * The tests run in order and share one Gateway, because a Gateway is stopped once. The
 * middle one therefore comes before the last: the two no-op Components are stopped by hand
 * while everything is still running, which is the only way "this stop released nothing" is
 * observable at all.
 *
 * Real sockets and `fetch` throughout, where most suites here use `inject`. That is forced
 * rather than preferred: `inject` answers on a server that has been closed, so a suite whose
 * subject is what is listening and when cannot use it.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { type Component, createGateway, type Gateway, serverComponent } from "./components.ts";
import { type Db, openDb } from "./db/index.ts";
import {
  createHttpMessenger,
  type HttpMessenger,
  messageReceivedKind,
} from "./http-messenger/http-messenger.ts";
import type { MessageRecord } from "./http-messenger/messages.ts";
import type { Logger } from "./logging.ts";
import type { SignalHandler } from "./signals/handlers.ts";
import { createSignalWorker, type SignalWorker } from "./signals/worker.ts";
import { createTestDatabase, type TestDatabase } from "./test-support/database.ts";
import { fakeRuntime } from "./test-support/fake-runtime.ts";
import { waitUntil } from "./test-support/wait.ts";
import type { UserRecord } from "./users/routes.ts";
import type { ScryptParameters } from "./users/secrets.ts";
import { createUsers, type Users } from "./users/users.ts";

/** A Fastify instance with a place in a start order, which is what `serverComponent` makes. */
type ServerComponent = Component & { readonly fastify: FastifyInstance };

/** The six, named as the reference deployment names them, in the order it writes them. */
type Deployment = {
  db: Db;
  agentServer: ServerComponent;
  publicServer: ServerComponent;
  users: Users;
  messenger: HttpMessenger;
  worker: SignalWorker;
};

const hour = 60 * 60 * 1000;

/** A cost nobody should deploy, so that the one login in this file runs in a moment. */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

const password = "correct horse battery staple";

/** Close enough that the Signal is never waited on for long, and never asserted about. */
const sweepIntervalMs = 25;

/** A started worker writes many lines, and none of them is this file's subject. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let database: TestDatabase;
/**
 * The Gateway's own Db, on the test database rather than the test's own handle on it.
 *
 * The Gateway stops what it started, and `pg` refuses a pool ended twice — so the Db the
 * record holds cannot be the one `database.drop()` will stop afterwards.
 */
let db: Db;
let deployment: Deployment;
let gateway: Gateway<Deployment>;

/** The one User in this file, and the Token they logged in for. */
let client: { readonly id: string; readonly token: string };

/**
 * Where each server landed, since both were asked for port 0.
 *
 * Read once, at `start`, and kept: a Fastify instance that has been closed no longer knows
 * its own address, and the last thing this file does is knock on both of them afterwards.
 */
let agentUrl: string;
let publicUrl: string;

/**
 * Resolved by the test that asks the Gateway to stop, and awaited by the Run in flight.
 *
 * This is how a Run is made to still be running when `stop` is called, which is the
 * situation the whole order exists for and the one no other suite puts a Gateway in.
 */
const shuttingDown = Promise.withResolvers<void>();

/** What the Run in flight could still reach, in the order it reached it. */
const duringTheDrain: string[] = [];

/**
 * A Run that parks until the shutdown starts, then reports what is still up, then fails.
 *
 * It fails on purpose: a failed Run is what makes the Handler's post phase send a Message,
 * which is the last thing the drain does and the one that reaches the Messenger
 * (ADR-0017).
 */
const runtime = fakeRuntime(async () => {
  await shuttingDown.promise;
  duringTheDrain.push(...(await whatIsStillUp()));
  return { ok: false, error: "this Run exists to be in flight while the Gateway shuts down" };
});

/**
 * The reference deployment's Handler, shortened to what this file is about: one Prompt per
 * Message, and a failure notice sent from the post phase.
 */
const answering: SignalHandler<MessageRecord> = {
  handle: (signal) => [{ session: `user_${signal.payload.userId}`, text: signal.payload.text }],
  async post(signal, outcome) {
    if (!outcome.failed) return;
    duringTheDrain.push(
      await reaching("the HTTP Messenger sent a Message", async () => {
        const sent = await db.tx((tx) =>
          deployment.messenger.send(tx, signal.payload.userId, "Something went wrong."),
        );
        return sent.direction;
      }),
    );
  },
};

before(async () => {
  database = await createTestDatabase("whole_gateway");
  db = openDb(database.url);

  // Constructed the way an Operator's entry point constructs them, which is also what
  // registers the three migration descriptors: the User Manager before the HTTP Messenger,
  // because registration order is construction order and `messages.user_id` is a foreign key
  // onto `saf_users.users.id` (ADR-0036).
  //
  // Port 0 on both, because two suites must be able to run at once and neither address is
  // asserted on. Where they actually landed is read back off the instance after `start`.
  const agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  const publicServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  const users = createUsers({ db, tokenTtl: hour, scrypt: cheap, agentServer, publicServer });
  const worker = createSignalWorker({
    db,
    runtime,
    handlers: { [messageReceivedKind]: answering },
    agentServer,
    logger: silent,
    sweepIntervalMs,
  });
  const messenger = createHttpMessenger({ db, users, worker, publicServer, agentServer });
  deployment = { db, agentServer, publicServer, users, messenger, worker };

  // After construction and before `start`, which is where an Operator puts it: `start`
  // refuses a schema the database is behind and never applies one (ADR-0032).
  await db.migrate();

  gateway = createGateway(deployment);
  await gateway.start();
  agentUrl = agentServer.fastify.listeningOrigin;
  publicUrl = publicServer.fastify.listeningOrigin;

  client = await admitted();
});

after(async () => {
  // Stopped here as well as by the last test, because the Db the record holds is the one
  // that has to be closed before the database can be dropped: a test that never reached
  // `stop` would otherwise leave a pool open and fail the drop with PostgreSQL's "is being
  // accessed by other users", which is the wrong failure to read. A second `stop` finds
  // nothing to do (ADR-0037).
  await gateway?.stop();
  await database.drop();
});

describe("a whole deployment in one record", () => {
  it("holds all six parts, under the keys the deployment filed them under", () => {
    // The keys are the start order, and they are the order the drain needs. That they are
    // *acted on* in this order is `components.test.ts`'s claim; that these six are what a
    // deployment consists of is this one.
    assert.deepEqual(Object.keys(gateway.components), [
      "db",
      "agentServer",
      "publicServer",
      "users",
      "messenger",
      "worker",
    ]);

    // The same objects, not copies: the record is the Gateway's directory of its own parts,
    // so the two that used to be left out of it are reachable through it now (ADR-0037).
    assert.equal(gateway.components.users, deployment.users);
    assert.equal(gateway.components.messenger, deployment.messenger);
  });

  it("starts and stops the two parts with nothing to run, and neither call does a thing", async () => {
    // Started once already, by `start` above, and started again here — which is safe for
    // precisely the reason `worker.start` refuses a second call and these do not: there is
    // nothing running to run twice.
    await deployment.users.start();
    await deployment.messenger.start();
    await deployment.users.stop();
    await deployment.messenger.stop();

    // And the whole deployment is where it was. That is the only form this assertion can
    // take while both bodies are empty, and it is worth having for the day one of them is
    // not: a stop that had done something would have taken a route, a pool or a hook with
    // it, and one `GET /messages` needs the Public server, the Manager's `requireUser`, the
    // Messenger's own plugin and the Db, all four of them (ADR-0032).
    assert.equal((await ownMessages()).status, 200);
    assert.equal((await deployment.users.get(client.id))?.id, client.id);
    assert.deepEqual(await deployment.messenger.history(client.id), []);
  });

  it("drains with everything still up, and closes it all once the drain is done", async () => {
    const posted = await postMessage("are you still there?");
    assert.equal(posted.status, 201);

    // The Run is in flight and parked. Nothing else in this repository stops a Gateway from
    // here, which is why the ordering has been reasoning in a comment until now.
    await waitUntil("the Run has started", async () => runtime.recorded.length === 1);

    // Not awaited: `stop` pops the worker first and the worker waits for this Run, so the
    // Run is what has to move next. By the time this call has returned a promise the worker
    // has already set itself stopping and cleared its ticker, so nothing new is claimed.
    const stopped = gateway.stop();
    shuttingDown.resolve();
    await stopped;

    // What the Run reached from inside the drain, and the whole of the order's justification.
    // The Public server is in there deliberately: it goes on accepting submissions
    // throughout, which is the trade ADR-0038 takes — that Message is stored, its Signal
    // stays `pending`, and the next boot picks it up.
    assert.deepEqual(duringTheDrain, [
      "the User Manager read the Db: 1 User",
      "the Agent server answered: 200",
      "the Public server took a submission: 201",
      "the HTTP Messenger sent a Message: outbound",
    ]);

    // And afterwards, nothing. Both sockets are closed and the pool is ended, which is the
    // reverse order having run all the way to the end.
    await assert.rejects(() => fetch(`${agentUrl}/signals`));
    await assert.rejects(() => fetch(`${publicUrl}/messages`));
    await assert.rejects(() => deployment.users.list());
  });
});

/**
 * Everything the Run in flight is entitled to reach, asked for in the order the parts are
 * keyed and therefore in the order they are about to be closed.
 *
 * Each one is asked through the part that owns it rather than through a connection of the
 * test's: the Db through the User Manager, the two servers over their own sockets. A Run
 * that could not reach one of these would be a Run the shutdown order had broken.
 */
async function whatIsStillUp(): Promise<string[]> {
  return [
    await reaching("the User Manager read the Db", async () => {
      const found = await deployment.users.list({ limit: 1 });
      return `${found.length} User`;
    }),
    await reaching("the Agent server answered", async () =>
      String((await fetch(`${agentUrl}/signals`)).status),
    ),
    await reaching("the Public server took a submission", async () =>
      String((await postMessage("and one more, while you were leaving")).status),
    ),
  ];
}

/**
 * One thing the Run tries, reported as a line of the log whether it worked or not.
 *
 * A failure comes back **as a line** rather than as a throw, and that is the point of this
 * function: a throw from inside a Run is caught by the worker and recorded as a failed Run
 * (ADR-0017), so the reason the drain broke would never reach the assertion outside. What
 * each line carries is a fact from the part it names — a count, a status — so a line cannot
 * be right for the wrong reason either.
 */
async function reaching(what: string, act: () => Promise<string>): Promise<string> {
  try {
    return `${what}: ${await act()}`;
  } catch (error) {
    return `${what}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A User admitted over the Agent server, holding a Token they traded a password for. */
async function admitted(): Promise<{ id: string; token: string }> {
  const created = await postJson(`${agentUrl}/users`, { password });
  assert.equal(created.status, 201, `admitting a User answered ${created.status}`);
  const { id } = (await created.json()) as UserRecord;

  const issued = await postJson(`${publicUrl}/auth/tokens`, { user: id, password });
  assert.equal(issued.status, 201, `logging in answered ${issued.status}`);
  const { token } = (await issued.json()) as { token: string };
  return { id, token };
}

/** One `POST /messages` on the Public server, by the User the Token names. */
function postMessage(text: string): Promise<Response> {
  return postJson(`${publicUrl}/messages`, { text }, client.token);
}

/** One `GET /messages` on the Public server: a read that emits no Signal. */
function ownMessages(): Promise<Response> {
  return fetch(`${publicUrl}/messages`, {
    headers: { authorization: `Bearer ${client.token}` },
  });
}

/** One JSON POST, with a Token when the route behind it wants one. */
function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}
