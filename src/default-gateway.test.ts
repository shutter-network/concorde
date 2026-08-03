/**
 * A whole deployment from one call, and the two things that call exists to settle.
 *
 * `components.test.ts` owns the ordering contract and proves it with mocks: key order out,
 * reverse order back, unwind on a failed start. What it cannot say is that the framework's
 * own six parts *fit* that record, or that the order they go in is the right one. This file
 * is the other half. Every part here is real — real PostgreSQL, two real Fastify instances
 * on real sockets, a real started Signal Worker, the real User Manager and the real HTTP
 * Messenger — and the Runtime is the one thing faked, as everywhere else (ADR-0022).
 *
 * What is different since the record was written by hand is that the order is no longer the
 * Operator's to write:
 *
 *     db -> agentServer -> publicServer -> users -> messenger -> worker -> extend
 *
 * comes out of `createGatewayWithDefaults`, and it comes from one rule. **The Signal
 * Worker's `stop` is the only stop that does work.** Every other one releases something;
 * the worker's waits for the Run in flight and never cancels it (ADR-0017), and that Run
 * reads the Db, calls the Agent server and reaches the Messenger through a Signal Handler's
 * post phase. So the drain goes first, while everything it uses is still up (ADR-0038).
 *
 * That is what the last test asserts, and it is the assertion `src/pi/container.test.ts`
 * says it does not make: a Run is parked in flight, `stop` is called around it, and the Run
 * then reports what it can still reach. Nothing is inspected from the side — the report
 * comes back from inside the Run itself, which is the only vantage point from which "still
 * up during the drain" is a fact rather than a guess. The Operator's own Component is in
 * that report too, and it is the one line that says **stopped**: `extend` appends, so an
 * Operator's Components stop *first*, which is right for a Producer and wrong for a
 * resource the drain uses (ADR-0038).
 *
 * The other thing settled here is the **construction cycle**. The worker takes its Handler
 * map at construction, the Messenger takes the worker, and the Handler's post phase sends a
 * Message through the Messenger. The Handler below is that cycle: it reaches the Messenger,
 * the Db and a Component that `extend` returned, all three of which are constructed after
 * the worker that will dispatch to it.
 *
 * The tests run in order and share one Gateway, because a Gateway is stopped once. The
 * no-op stops are therefore exercised before the last test, by hand and while everything is
 * still running, which is the only way "this stop released nothing" is observable at all.
 *
 * Real sockets and `fetch` throughout, where most suites here use `inject`. That is forced
 * rather than preferred: `inject` answers on a server that has been closed, so a suite whose
 * subject is what is listening and when cannot use it.
 *
 * The last suite is the odd one and is here rather than in a file of its own because this
 * module is what put it at risk: assembling by default is what made the package root import
 * `./users` and `./http-messenger`, and constructing a Runtime would be the obvious next
 * convenience. It reads no database and starts nothing — it walks the import graph from
 * `src/index.ts` and asserts what is *not* in it.
 *
 * **No password is anywhere in this file**, and that is the defaults constructor showing
 * through: it exposes no `scrypt` option, so a login here would derive at OWASP's 32 MiB
 * cost twice over for nothing this file is about. The one User is admitted and handed a
 * Token from trusted code instead, which is the same two calls an OIDC callback makes
 * (ADR-0030), and the four route groups are proven registered by reads that hash nothing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Component, Gateway } from "./components.ts";
import type { Db } from "./db/index.ts";
import { createGatewayWithDefaults, type DefaultComponents } from "./default-gateway.ts";
import { type MessageRecord, messageReceivedKind } from "./http-messenger/index.ts";
import type { Logger } from "./logging.ts";
import type { SignalHandler } from "./signals/index.ts";
import { createTestDatabase, type TestDatabase } from "./test-support/database.ts";
import { fakeRuntime } from "./test-support/fake-runtime.ts";
import { waitUntil } from "./test-support/wait.ts";
import type { UserRecord } from "./users/index.ts";

const hour = 60 * 60 * 1000;

/** A started worker writes many lines, and none of them is this file's subject. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Somewhere nobody is, for the one call that is supposed to be refused. */
const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

/**
 * A Component of the Operator's own, which is the whole of what `extend` is for.
 *
 * It does two jobs here. A Signal Handler writes to it, which is what proves `handlers` can
 * reach something `extend` returned — and therefore that `extend` ran first. And it knows
 * whether it is running, which is what makes its position observable from inside the drain:
 * `extend` appends, so this is the first thing stopped and the Run in flight finds it shut.
 */
type Notebook = Component & {
  readonly lines: string[];
  readonly running: boolean;
};

function notebook(): Notebook {
  let running = false;
  return {
    lines: [],
    get running() {
      return running;
    },
    start: async () => {
      running = true;
    },
    stop: async () => {
      running = false;
    },
  };
}

/** Which callback ran when, since "`extend` before `handlers`" is a claim about order. */
const callbacks: string[] = [];

let database: TestDatabase;
let gateway: Gateway<DefaultComponents & { notes: Notebook }>;
let components: DefaultComponents & { notes: Notebook };

/** The one User in this file, and the Token trusted code handed them. */
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

before(async () => {
  database = await createTestDatabase("default_gateway");

  // The whole assembly, and the whole of what this deployment says about it. There is no
  // construction order here to get wrong and no record to key: the six parts, the pair of
  // servers, the three migration registrations and the position of every stop are the
  // framework's now (ADR-0038).
  gateway = createGatewayWithDefaults({
    databaseUrl: database.url,
    runtime,
    tokenTtl: hour,
    // Port 0 on both, because two suites must be able to run at once and neither address is
    // asserted on. Where they actually landed is read back off the instances after `start`.
    agentListen: { port: 0, host: "127.0.0.1" },
    publicListen: { port: 0, host: "127.0.0.1" },
    extend: (defaults) => {
      callbacks.push("extend");
      // Given the six, and *not* the handlers: a Component that needed a Handler would be a
      // Component that wanted to be a Signal Worker (ADR-0038).
      assert.deepEqual(Object.keys(defaults), [
        "db",
        "agentServer",
        "publicServer",
        "users",
        "messenger",
        "worker",
      ]);
      return { notes: notebook() };
    },
    handlers: (all) => {
      callbacks.push("handlers");
      // Given the six *and* the extension, which is the direction that makes a Handler able
      // to use an Operator's own Component.
      return { [messageReceivedKind]: answering(all) };
    },
    logger: silent,
  });
  components = gateway.components;

  // After construction and before `start`, which is where an Operator puts it: `start`
  // refuses a schema the database is behind and never applies one (ADR-0032). That it
  // succeeds at all is the ADR-0036 construction order holding — the User Manager is
  // constructed before the Messenger inside that one call, so `saf_users.users` exists by
  // the time `messages.user_id` references it.
  await components.db.migrate();

  await gateway.start();
  agentUrl = components.agentServer.fastify.listeningOrigin;
  publicUrl = components.publicServer.fastify.listeningOrigin;

  client = await admitted();
});

after(async () => {
  // Stopped here as well as by the last test, because the Db the record holds is what has to
  // be closed before the database can be dropped: a test that never reached `stop` would
  // otherwise leave a pool open and fail the drop with PostgreSQL's "is being accessed by
  // other users", which is the wrong failure to read. A second `stop` finds nothing to do
  // (ADR-0037).
  await gateway?.stop();
  await database.drop();
});

/**
 * The reference deployment's Handler, shortened to what this file is about: one Prompt per
 * Message, a note in the Operator's own Component, and a failure notice sent from the post
 * phase.
 *
 * A factory taking every Component, because that is what `handlers` is handed. Everything
 * it reaches — the Db, the Messenger, the notebook — is constructed *after* the Signal
 * Worker that will dispatch to it, which is the cycle `createGatewayWithDefaults` exists to
 * break.
 */
function answering(all: DefaultComponents & { notes: Notebook }): SignalHandler<MessageRecord> {
  return {
    handle(signal) {
      all.notes.lines.push(signal.payload.text);
      return [{ session: `user_${signal.payload.userId}`, text: signal.payload.text }];
    },
    async post(signal, outcome) {
      if (!outcome.failed) return;
      duringTheDrain.push(
        await reaching("the HTTP Messenger sent a Message", async () => {
          const sent = await all.db.tx((tx) =>
            all.messenger.send(tx, signal.payload.userId, "Something went wrong."),
          );
          return sent.direction;
        }),
      );
    },
  };
}

describe("a whole deployment from one call", () => {
  it("holds the six defaults, in the order that is the start order, with the extension last", () => {
    // The keys are the start order, and they are the order the drain needs. That they are
    // *acted on* in this order is `components.test.ts`'s claim; that these are what a
    // deployment consists of, and in this order, is this one — and it is the framework's
    // claim now rather than the Operator's (ADR-0038).
    assert.deepEqual(Object.keys(components), [
      "db",
      "agentServer",
      "publicServer",
      "users",
      "messenger",
      "worker",
      // Appended, which is why it stops first. The last test is where that is observed.
      "notes",
    ]);
  });

  it("runs extend before handlers, so a Handler can reach a Component extend returned", () => {
    assert.deepEqual(callbacks, ["extend", "handlers"]);
    // And the Component is started, in its position at the end of the order. Nothing has
    // been written into it: the notebook is a Handler's to fill, and the drain test below is
    // what makes a Handler run at all.
    assert.equal(components.notes.running, true);
    assert.deepEqual(components.notes.lines, []);
  });

  it("wired every part to every other, which is four route groups on two servers", async () => {
    // One read per group, chosen so that nothing here derives a password: the User Manager's
    // two plugins, the Signal Worker's, and the Messenger's pair. A group that was never
    // registered answers 404, and so does one registered on the other server.
    assert.equal((await fetch(`${agentUrl}/users`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/signals`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/messages?user=${client.id}`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/auth/me`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/messages`)).status, 200);
  });

  it("migrated the Messenger's tables after the User Manager's, so the foreign key is live", async () => {
    // `db.migrate()` in `before` proved half of it: registration order is construction
    // order, and the other order fails on the Messenger's first migration with `schema
    // "saf_users" does not exist` (ADR-0036). This is the other half — that the constraint
    // is there and enforced, so a Message addressed to nobody is refused rather than stored.
    // `UnknownUserError` is PostgreSQL's `23503` named: the constraint refusing, surfaced as
    // a throw for trusted code and as the agent's 404 on the route (ADR-0036).
    await assert.rejects(
      () => components.db.tx((tx) => components.messenger.send(tx, nobody, "nobody reads this")),
      { name: "UnknownUserError" },
    );
  });

  it("starts and stops the two parts with nothing to run, and neither call does a thing", async () => {
    // Started once already, by `start` above, and started again here — which is safe for
    // precisely the reason `worker.start` refuses a second call and these do not: there is
    // nothing running to run twice.
    await components.users.start();
    await components.messenger.start();
    await components.users.stop();
    await components.messenger.stop();

    // And the whole deployment is where it was. That is the only form this assertion can
    // take while both bodies are empty, and it is worth having for the day one of them is
    // not: a stop that had done something would have taken a route, a pool or a hook with
    // it, and one `GET /messages` needs the Public server, the Manager's `requireUser`, the
    // Messenger's own plugin and the Db, all four of them (ADR-0032).
    assert.equal((await authenticated(`${publicUrl}/messages`)).status, 200);
    assert.equal((await components.users.get(client.id))?.id, client.id);
    assert.deepEqual(await components.messenger.history(client.id), []);
  });

  it("drains with everything still up, and closes it all once the drain is done", async () => {
    const posted = await postMessage("are you still there?");
    assert.equal(posted.status, 201);

    // The Run is in flight and parked. Nothing else in this repository stops a Gateway from
    // here, which is why the ordering has been reasoning in a comment until now.
    await waitUntil("the Run has started", async () => runtime.recorded.length === 1);

    // The Handler ran, and it reached the Component `extend` returned. That is the cycle
    // closed at runtime: this Handler was built by a callback taking objects the worker
    // holding it was constructed before (ADR-0038).
    assert.deepEqual(components.notes.lines, ["are you still there?"]);

    // Not awaited: `stop` pops the notebook and then the worker, and the worker waits for
    // this Run, so the Run is what has to move next. By the time this call has returned a
    // promise the worker has already set itself stopping and cleared its ticker, so nothing
    // new is claimed.
    const stopped = gateway.stop();
    shuttingDown.resolve();
    await stopped;

    // What the Run reached from inside the drain, and the whole of the order's
    // justification. The Public server is in there deliberately: it goes on accepting
    // submissions throughout, which is the trade ADR-0038 takes — that Message is stored,
    // its Signal stays `pending`, and the next boot picks it up. The Operator's own
    // Component is the one line that says stopped, because `extend` appends and appended
    // Components stop first.
    assert.deepEqual(duringTheDrain, [
      "the User Manager read the Db: 1 User",
      "the Agent server answered: 200",
      "the Public server took a submission: 201",
      "the Operator's own Component: stopped",
      "the HTTP Messenger sent a Message: outbound",
    ]);

    // And afterwards, nothing. Both sockets are closed and the pool is ended, which is the
    // reverse order having run all the way to the end.
    await assert.rejects(() => fetch(`${agentUrl}/signals`));
    await assert.rejects(() => fetch(`${publicUrl}/messages`));
    await assert.rejects(() => components.users.list());
  });
});

describe("the defaults on their own", () => {
  // Constructed and never started, which is free: `openDb` connects lazily and a Fastify
  // instance that never listens holds nothing. What these two are about needs no database.

  it("is the six and nothing else when no extend is passed", () => {
    const bare = createGatewayWithDefaults({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      tokenTtl: hour,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      handlers: () => ({}),
    });

    assert.deepEqual(Object.keys(bare.components), [
      "db",
      "agentServer",
      "publicServer",
      "users",
      "messenger",
      "worker",
    ]);

    // And the record still has its types, which is a claim about the type parameter's
    // **default** rather than about the object. With `extend` omitted there is nothing to
    // infer the extension from, and a type parameter with no inference candidates falls back
    // to its constraint — which carries `db?: never` and would reduce the whole intersection
    // to `never`. This line is what stops compiling if that default is ever dropped.
    const db: Db = bare.components.db;
    assert.equal(typeof db.migrate, "function");
  });

  it("refuses an extend that returns one of the six", () => {
    const substituting = createGatewayWithDefaults({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      tokenTtl: hour,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // A JavaScript spread overwrites the value and keeps the original key's position, so
      // substituting a default in place would start the Operator's Messenger exactly where
      // ours would have gone and nothing anywhere would say so. The refusal is a type error,
      // and this is where it is pinned: `@ts-expect-error` fails the typecheck if the line
      // below ever starts compiling (ADR-0037). An Operator who really wants to substitute
      // one writes `createGateway` by hand, which is the honest way to say it.
      // @ts-expect-error a default key may not be replaced by an extension
      extend: (defaults) => ({ notes: notebook(), messenger: defaults.messenger }),
      handlers: () => ({}),
    });

    // And it is refused *statically only*, which is the reason the type has to carry it: at
    // runtime the spread simply overwrites, and the substituted part keeps the position the
    // framework gave it rather than the one at the end an Operator would have expected.
    assert.deepEqual(Object.keys(substituting.components), [
      "db",
      "agentServer",
      "publicServer",
      "users",
      "messenger",
      "worker",
      "notes",
    ]);
  });
});

describe("the two options a deployment may leave out", () => {
  // A database of this suite's own, because the Gateway above is shared and started and
  // this one constructs another. Neither test can be written without a real server: what a
  // defaulted `databaseUrl` opened is only visible in something connecting, and what a
  // defaulted `tokenTtl` decided is only visible on a Token that was written down.
  let elsewhere: TestDatabase;
  let inherited: string | undefined;

  before(async () => {
    elsewhere = await createTestDatabase("default_gateway_defaults");
    // `src/test-support/database.ts` read this at import time, so moving it now moves it
    // only for the code under test. It is put back regardless in `after`.
    inherited = process.env.DATABASE_URL;
  });

  after(async () => {
    if (inherited === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = inherited;
    await elsewhere.drop();
  });

  it("opens DATABASE_URL, and issues a Token that lives thirty days", async () => {
    process.env.DATABASE_URL = elsewhere.url;

    const gateway = createGatewayWithDefaults({
      runtime,
      agentListen: { port: 0, host: "127.0.0.1" },
      publicListen: { port: 0, host: "127.0.0.1" },
      handlers: () => ({}),
    });
    const { db, users } = gateway.components;

    // Nothing is started: `migrate` is enough, and it is also the proof. It applies three
    // folders against the database the environment named, so it cannot pass unless the URL
    // arrived and named something real.
    await db.migrate();

    const user = await db.tx((tx) => users.create(tx));
    const issued = await db.tx((tx) => users.issueToken(tx, user.id));
    const lifetime = Date.parse(issued.expiresAt) - Date.now();

    // A minute of slack for the round trip, against a value of thirty days: wide enough
    // never to flake, and narrow enough that any other lifetime in the file fails it.
    assert.ok(
      Math.abs(lifetime - 30 * 24 * 60 * 60 * 1000) < 60_000,
      `a defaulted tokenTtl should be thirty days, and this Token lives ${lifetime}ms`,
    );

    await db.stop();
  });

  it("refuses to construct when neither the option nor the environment says where", () => {
    delete process.env.DATABASE_URL;

    // At construction, which is the point: `openDb` is lazy, so a Gateway built with no
    // database would otherwise start, listen, and fail on the first statement of the first
    // Run with whatever `pg` makes of its own defaults.
    assert.throws(
      () =>
        createGatewayWithDefaults({
          runtime,
          agentListen: { port: 0, host: "127.0.0.1" },
          publicListen: { port: 0, host: "127.0.0.1" },
          handlers: () => ({}),
        }),
      /DATABASE_URL/,
    );
  });
});

describe("the package root", () => {
  it("reaches no Agent Implementation, however far the imports go", () => {
    // `createGatewayWithDefaults` is what made the root import `./users` and
    // `./http-messenger`, and the edge worth keeping absent is the next one: the Runtime is
    // an option rather than a spec precisely so that swapping `pi` for another Agent
    // Implementation stays "this import and this function name, and nothing below"
    // (ADR-0033, ADR-0038). A default assembly that constructed one would make that false
    // for everyone on the default path, and it is an easy thing to add by accident.
    const src = fileURLToPath(new URL(".", import.meta.url));
    const reached = reachableFrom(path.join(src, "index.ts"));
    assert.deepEqual(
      [...reached].filter((module) => module.startsWith(path.join(src, "pi/"))),
      [],
    );

    // The check is only worth having if it is looking at something, and this is what says it
    // is: the root does reach the two parts the default assembly constructs.
    assert.ok(reached.has(path.join(src, "users", "users.ts")));
    assert.ok(reached.has(path.join(src, "http-messenger", "http-messenger.ts")));
  });
});

/** Every module reachable from `entry` by relative import, transitively, as absolute paths. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let module = pending.pop(); module !== undefined; module = pending.pop()) {
    if (seen.has(module)) continue;
    seen.add(module);
    // Relative specifiers only, and they carry `.ts` extensions in this tree, so there is
    // nothing to resolve beyond joining them onto the importing module's directory. All
    // three spellings, because the two this file is not looking for are the two an unwanted
    // edge would most plausibly arrive as: `import "./x.ts"` for a side effect, and
    // `await import("./x.ts")` for a lazily loaded one.
    const specifiers = readFileSync(module, "utf8").matchAll(
      /(?:from|import)\s*\(?\s*"(\.[^"]+)"/g,
    );
    for (const [, specifier] of specifiers) {
      if (specifier !== undefined) pending.push(path.resolve(path.dirname(module), specifier));
    }
  }
  return seen;
}

/**
 * Everything the Run in flight is entitled to reach, asked for in the order the parts are
 * keyed and therefore in the order they are about to be closed.
 *
 * Each one is asked through the part that owns it rather than through a connection of the
 * test's: the Db through the User Manager, the two servers over their own sockets. A Run
 * that could not reach one of these would be a Run the shutdown order had broken. The
 * Operator's own Component is the exception, and is asked about for the opposite reason: it
 * is *supposed* to be shut by now.
 */
async function whatIsStillUp(): Promise<string[]> {
  return [
    await reaching("the User Manager read the Db", async () => {
      const found = await components.users.list({ limit: 1 });
      return `${found.length} User`;
    }),
    await reaching("the Agent server answered", async () =>
      String((await fetch(`${agentUrl}/signals`)).status),
    ),
    await reaching("the Public server took a submission", async () =>
      String((await postMessage("and one more, while you were leaving")).status),
    ),
    await reaching("the Operator's own Component", async () =>
      components.notes.running ? "still running" : "stopped",
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

/**
 * A User admitted from trusted code, holding a Token nobody traded a password for.
 *
 * The two calls an OIDC callback makes, and the reason this file needs no password at all:
 * `create` takes none and derives nothing, `issueToken` mints a Token for somebody who
 * presented nothing, and what comes back is indistinguishable from a Token a login bought
 * (ADR-0030). The defaults constructor exposes no `scrypt` option, so the alternative would
 * be two derivations at OWASP's 32 MiB cost for nothing this file asserts.
 */
async function admitted(): Promise<{ id: string; token: string }> {
  const user: UserRecord = await components.db.tx((tx) => components.users.create(tx));
  const issued = await components.db.tx((tx) => components.users.issueToken(tx, user.id));
  return { id: user.id, token: issued.token };
}

/** One `POST /messages` on the Public server, by the User the Token names. */
function postMessage(text: string): Promise<Response> {
  return postJson(`${publicUrl}/messages`, { text }, client.token);
}

/** One GET on the Public server, with the Token the one User holds. */
function authenticated(url: string): Promise<Response> {
  return fetch(url, { headers: { authorization: `Bearer ${client.token}` } });
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
