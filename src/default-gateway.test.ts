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
 * A third claim shares the first suite without being about the assembly at all, and it is
 * here because there is nowhere cheaper: **what a part recorded and what the wire carries
 * are the same record**. A response schema is a serializer, so a field the schema does not
 * declare is dropped from the answer without a word
 * ([ADR-0040](../docs/adr/0040-the-gateway-describes-its-own-http-api.md)), and catching
 * that needs a record produced in this process and read back over a socket. Every other
 * body comparison in this repository compares one HTTP response against another, where a
 * uniformly stripped field is stripped on both sides and passes.
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
 * **One password is in this file, and one only.** The defaults constructor exposes no
 * `scrypt` option, so every derivation here is at OWASP's 32 MiB cost, and the User this
 * suite is otherwise built around is admitted and handed a Token from trusted code
 * instead, which is the same two calls an OIDC callback makes (ADR-0030), so that four
 * route groups are proven registered by reads that hash nothing. The exception is the round
 * trip on an issued Token: `POST /auth/tokens` is the only route in the framework that
 * answers one, and a login is the only way to reach it, so that assertion buys its
 * derivations rather than being written somewhere cheaper.
 */

import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, type JsonWebKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Component, Gateway } from "./components.ts";
import type { Db } from "./db/index.ts";
import type { DecisionRecord } from "./decisions/index.ts";
import {
  createGatewayWithDefaults,
  type DefaultComponents,
  describedVersion,
} from "./default-gateway.ts";
import { type MessageRecord, messageReceivedKind } from "./http-messenger/index.ts";
import type { Logger } from "./logging.ts";
import type { RunRecord, SignalHandler, SignalRecord } from "./signals/index.ts";
import { createTestDatabase, type TestDatabase } from "./test-support/database.ts";
import { fakeRuntime } from "./test-support/fake-runtime.ts";
import { waitUntil } from "./test-support/wait.ts";
import type { IssuedToken, UserRecord } from "./users/index.ts";

const hour = 60 * 60 * 1000;

/** A started worker writes many lines, and none of them is this file's subject. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Somewhere nobody is, for the one call that is supposed to be refused. */
const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

/**
 * The Shared Agent's identity for the duration of this file, generated here because this is
 * where a keypair may be generated: the framework generates none, and `signingKey` is required
 * of every deployment including one that publishes nothing
 * ([ADR-0041](../docs/adr/0041-the-shared-agent-has-a-signing-identity.md)).
 */
const { privateKey: signingKey } = generateKeyPairSync("ed25519");

/**
 * What a deployment consists of, in the order it starts and the reverse of the order it stops,
 * written once because three tests are about exactly this list.
 *
 * Signatures and Decisions were **inserted** rather than appended, and the two constraints
 * they had to satisfy are what this array is for: no existing pair moved relative position, so
 * every claim the six made about their own order still holds, and both sit ahead of the Signal
 * Worker so that they outlive the drain — which is when a Signal Handler's post phase may still
 * publish (ADR-0038, ADR-0043).
 */
const theEight = [
  "db",
  "agentServer",
  "publicServer",
  "users",
  "signatures",
  "decisions",
  "messenger",
  "worker",
];

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

/**
 * The awkward JSON both round trips carry, and the reason either of them nests anything.
 *
 * A Signal's `payload` and a User's `attributes` are both declared with an **empty
 * schema**, precisely so that arbitrary JSON survives serialization byte intact
 * ([ADR-0040](../docs/adr/0040-the-gateway-describes-its-own-http-api.md)), and a flat
 * object of strings would not have shown it: a list of mixed types, a null inside it and
 * an object below that are what a schema with an opinion would flatten or drop.
 */
const awkwardJson = { list: [1, "two", null, { deep: true }], nothing: null };

/**
 * The Signal the round-trip assertions are about: a `kind` of its own, a Handler of its
 * own, and that payload.
 *
 * A `kind` of its own so that reading it back proves nothing about the reference
 * deployment's convention, which is the Operator's and not the framework's, and so that
 * the Handler driving the drain below is left saying what it says.
 */
const roundTripKind = "the.round.trip";
const roundTripSession = "the round trip";
const roundTripPayload = { text: "say this back to me", nested: awkwardJson };

/**
 * The one password in this file, and the Attributes of the User that holds it.
 *
 * Attributes are also the field a *password hash* would have to be smuggled out beside,
 * which is the other thing the round trip below reads them for.
 */
const theOnePassword = "the only password in this file";
const roundTripAttributes = { groups: ["reviewers"], nested: awkwardJson };

/**
 * The one Message in this file that a *User* wrote, and the reason the notebook below ends
 * up with two lines rather than one.
 *
 * There is no trusted-code method that writes an inbound Message and that is deliberate
 * (ADR-0034), so the Public submission route is the only way a log has both directions in
 * it, and that is what makes the numbering worth reading back at all.
 */
const roundTripSubmission = "and one from me, while everything is still up";

/** A Handler whose only job is to produce one Run for the round trip to read. */
const roundTripping: SignalHandler<{ readonly text: string }> = {
  handle: (signal) => [{ session: roundTripSession, text: signal.payload.text }],
};

/**
 * The text of the Prompt whose Run is in flight when the Gateway is asked to stop.
 *
 * Named rather than written three times, because the fake Runtime tells that Run apart
 * from every other one by it: this is the only Run that parks, and the round-trip Run
 * above has to be able to start, finish and be read back while everything is still up.
 */
const inFlightAtShutdown = "are you still there?";

/**
 * What the post phase commits to on the way out, and the reason Decisions is keyed ahead of
 * the Signal Worker.
 *
 * A Decision reached by a failing Run is still a Decision, and the phase that reaches it runs
 * inside the drain (ADR-0038, ADR-0043).
 */
const decidedOnTheWayOut = "the March rollout is off, decided while the Gateway was stopping";

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
 *
 * One Prompt parks and every other Run is ordinary, which is what lets the round-trip
 * assertions have a finished Run to read: the worker is serial globally (ADR-0012), so a
 * Run parked before them would be a Gateway that never got to them at all.
 */
const runtime = fakeRuntime(async (prompt) => {
  if (prompt.text !== inFlightAtShutdown) return { ok: true };
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
    signingKey,
    tokenTtl: hour,
    // Port 0 on both, because two suites must be able to run at once and neither address is
    // asserted on. Where they actually landed is read back off the instances after `start`.
    agentListen: { port: 0, host: "127.0.0.1" },
    publicListen: { port: 0, host: "127.0.0.1" },
    extend: (defaults) => {
      callbacks.push("extend");
      // Given the eight, and *not* the handlers: a Component that needed a Handler would be a
      // Component that wanted to be a Signal Worker (ADR-0038).
      assert.deepEqual(Object.keys(defaults), theEight);
      return { notes: notebook() };
    },
    handlers: (all) => {
      callbacks.push("handlers");
      // Given the eight *and* the extension, which is the direction that makes a Handler able
      // to use an Operator's own Component.
      return { [messageReceivedKind]: answering(all), [roundTripKind]: roundTripping };
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
 * Message, a note in the Operator's own Component, a failure notice sent from the post phase,
 * and the Decision that failure was reached about published from the same phase.
 *
 * A factory taking every Component, because that is what `handlers` is handed. Everything
 * it reaches (the Db, the Messenger, Decisions, the notebook) is constructed *after* the
 * Signal Worker that will dispatch to it, which is the cycle `createGatewayWithDefaults`
 * exists to break.
 *
 * The publish is why Decisions is keyed **ahead of** the Signal Worker: a post phase runs after
 * the Runs arising from a Signal have finished, which during shutdown is inside the drain, and
 * a Decision reached by a failing Run should still be recorded (ADR-0038, ADR-0043).
 *
 * What makes it *work* today is narrower than that, and worth saying rather than letting a
 * reader infer the stronger claim: the insert goes through the Db's handle, and the Db is keyed
 * first and therefore stopped last. Decisions' own `stop` does nothing, so moving its key
 * behind the worker's would leave this line passing and only the pinned order in `theEight`
 * would report it. The position is the HTTP Messenger's anticipatory one, held for the day
 * either part's `stop` starts releasing something.
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
      duringTheDrain.push(
        await reaching("Decisions published a Decision", async () => {
          // In a transaction of the Handler's own, which is the shape the trusted method
          // exists for (ADR-0023), and read straight back through the other one, which is the
          // fact this line carries: the row committed while the Gateway was closing, and the
          // artifact that came back is the artifact the log holds. No number in the line, so
          // that a Decision published anywhere else in this file does not rewrite a shutdown
          // assertion.
          const published = await all.db.tx((tx) => all.decisions.publish(tx, decidedOnTheWayOut));
          const [found] = await all.decisions.history({ after: published.seq - 1 });
          if (found === undefined) return "committed to nothing";
          return found.jws === published.jws ? "the same artifact" : "another artifact";
        }),
      );
    },
  };
}

describe("a whole deployment from one call", () => {
  it("holds the eight defaults, in the order that is the start order, with the extension last", () => {
    // The keys are the start order, and they are the order the drain needs. That they are
    // *acted on* in this order is `components.test.ts`'s claim; that these are what a
    // deployment consists of, and in this order, is this one — and it is the framework's
    // claim now rather than the Operator's (ADR-0038).
    assert.deepEqual(Object.keys(components), [
      ...theEight,
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

  it("wired every part to every other, which is eight route groups on two servers", async () => {
    // One read per group, chosen so that nothing here derives a password: the User Manager's
    // two plugins, the Signal Worker's, the Messenger's pair, Decisions' pair and Signatures'
    // pair. A group that was never registered answers 404, and so does one registered on the
    // other server.
    assert.equal((await fetch(`${agentUrl}/users`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/signals`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/messages?user=${client.id}`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/decisions`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/auth/me`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/messages`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/decisions`)).status, 200);
    // And Signatures' two, whose one read is the only route on the Public server that takes no
    // Token besides the login: a public key is public (ADR-0042). The other two are POSTs and
    // are exercised in full further down; here they are one 400 each, which is a group that
    // registered rather than the 404 of one that did not.
    assert.equal((await fetch(`${publicUrl}/jwks.json`)).status, 200);
    assert.equal((await postJson(`${agentUrl}/sign`, {})).status, 400);
    assert.equal((await postJson(`${publicUrl}/verify`, {}, client.token)).status, 400);
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

  it("starts and stops the four parts with nothing to run, and no call does a thing", async () => {
    // Started once already, by `start` above, and started again here — which is safe for
    // precisely the reason `worker.start` refuses a second call and these do not: there is
    // nothing running to run twice.
    for (const idle of [
      components.users,
      components.signatures,
      components.decisions,
      components.messenger,
    ]) {
      await idle.start();
      await idle.stop();
    }

    // And the whole deployment is where it was. That is the only form this assertion can
    // take while every body is empty, and it is worth having for the day one of them is
    // not: a stop that had done something would have taken a route, a pool or a hook with
    // it, and one `GET /messages` needs the Public server, the Manager's `requireUser`, the
    // Messenger's own plugin and the Db, all four of them (ADR-0032). Decisions' Public read
    // needs the same four and Signatures' key set needs neither the Db nor the hook, so the
    // three together cover both halves of what a stop could have released.
    assert.equal((await authenticated(`${publicUrl}/messages`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/decisions`)).status, 200);
    assert.equal((await fetch(`${publicUrl}/jwks.json`)).status, 200);
    assert.equal((await components.users.get(client.id))?.id, client.id);
    assert.deepEqual(await components.messenger.history(client.id), []);
  });

  it("answers a Signal and its Run as the Signal Worker recorded them, and drops nothing", async () => {
    // A response schema is a **serializer**: Fastify compiles it with
    // `fast-json-stringify`, which strips every field the schema does not declare and
    // warns about none of it (ADR-0040). So a field added to `SignalRecord` and forgotten
    // in the Signal Worker's schema simply stops reaching the agent, and every comparison
    // of one HTTP response against another passes, because both sides lost it.
    //
    // This is the assertion that cannot: the record is produced through the part's own
    // method, in this process, and the whole body is compared against a literal the type
    // checker holds to the record type. Add a field to `SignalRecord` and this file stops
    // compiling; declare it nowhere and the comparison below fails. Either way somebody
    // finds out here rather than from an agent that read a field and saw nothing.
    const signalId = await components.db.tx((tx) =>
      components.worker.emit(tx, { kind: roundTripKind, payload: roundTripPayload }),
    );
    await waitUntil("the emitted Signal has been handled and its Run has finished", async () => {
      const signal = await agentJson<SignalRecord>(`/signals/${signalId}`);
      return signal.state === "done";
    });

    const signal = await agentJson<SignalRecord>(`/signals/${signalId}`);
    assert.deepEqual(signal, {
      id: signalId,
      kind: roundTripKind,
      // Byte intact, nesting and nulls and all, which is what the empty schema on
      // `payload` is for: the Signal Worker never interpreted this and the wire does not
      // start.
      payload: roundTripPayload,
      // The one field with nothing in process to compare against, so it is checked rather
      // than copied, and the check is what closes the hole in copying it, since a
      // dropped `emittedAt` is `undefined` on both sides of a `deepEqual` and passes.
      emittedAt: signal.emittedAt,
      state: "done",
      error: null,
    } satisfies SignalRecord);
    assert.equal(new Date(signal.emittedAt).toISOString(), signal.emittedAt);

    // And the same Signal through the list route, which is a second response schema
    // written separately: a field declared in one and forgotten in the other differs here.
    const listed = await agentJson<{ signals: SignalRecord[] }>(`/signals?kind=${roundTripKind}`);
    assert.deepEqual(listed.signals, [signal]);

    // The Run the Handler asked for, produced by the worker rather than by this test: its
    // Session is the one the Prompt named and its Prompt text came out of the payload.
    const runs = await agentJson<{ runs: RunRecord[] }>(`/runs?signalId=${signalId}`);
    assert.equal(runs.runs.length, 1, "the round-trip Handler returned exactly one Prompt");
    const [run] = runs.runs;
    assert.ok(run !== undefined);
    assert.deepEqual(run, {
      id: run.id,
      signalId,
      session: roundTripSession,
      prompt: roundTripPayload.text,
      state: "done",
      error: null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    } satisfies RunRecord);
    // The two timings, checked rather than copied for the reason `emittedAt` was. The
    // `String` is what makes a dropped one fail here instead of failing to compile: the
    // field is `string | null` on a finished Run only because a row written before it
    // started still holds `null`.
    assert.equal(new Date(String(run.startedAt)).toISOString(), run.startedAt);
    assert.equal(new Date(String(run.endedAt)).toISOString(), run.endedAt);

    // The id copied above is a real one, and the other Run route says the same thing about
    // this Run as the list route did: a 404 here is a dropped `id`, and a difference is two
    // schemas that have come apart.
    assert.deepEqual(await agentJson<RunRecord>(`/runs/${run.id}`), run);
  });

  it("answers a User and an issued Token as the User Manager recorded them, and drops nothing", async () => {
    // The same hazard the Signal round trip above is about, on the one record where it
    // cuts both ways. A field dropped from a `UserRecord` is an answer quietly missing
    // something; a field *added* to the schema is the password hash on a wire ADR-0030
    // says it never reaches. So the shape is asserted whole in both directions: against a
    // record this process holds, and against the bytes that came back.
    const created = await components.db.tx(async (tx) => {
      const user = await components.users.create(tx);
      await components.users.setAttributes(tx, user.id, roundTripAttributes);
      await components.users.setPassword(tx, user.id, theOnePassword);
      return user;
    });
    // Read back through the part's own method rather than reusing what `create` answered,
    // since the Attributes and the password were written after it: this is the record the
    // Manager holds, and it is what the wire is compared against.
    const recorded = await components.users.get(created.id);
    assert.ok(recorded !== undefined, "the User this test just created should be readable");

    const read = await agentJson<UserRecord>(`/users/${created.id}`);
    assert.deepEqual(read, {
      id: created.id,
      // Byte intact, nesting and nulls and all, which is what the empty schema on
      // `attributes` is for: the Gateway never interpreted these and the wire does not
      // start (ADR-0014).
      attributes: roundTripAttributes,
      // Compared against the in-process record rather than against itself, which is what
      // a dropped field would survive: `undefined` on both sides of a `deepEqual` passes.
      createdAt: recorded.createdAt,
    } satisfies UserRecord);

    // And the list route, which is a second response schema written separately: a field
    // declared in one of the two and forgotten in the other differs here. `limit` is 2
    // because `admitted()` made a User before this one. The create route's own schema is
    // exercised where the create route is, in `src/users/routes.test.ts`.
    const listed = await agentJson<{ users: UserRecord[] }>("/users?limit=2");
    assert.deepEqual(listed.users, [read, await agentJson<UserRecord>(`/users/${client.id}`)]);

    // The Token, which is the one record in the framework that **only a login answers
    // with**, and that is what buys the two derivations this file otherwise refuses to pay.
    // The in-process half is `issueToken`, the method an Operator's own OIDC route calls,
    // and it builds the shape the login builds: a field added to `IssuedToken` and
    // forgotten in the schema is a key on one side and not the other.
    const minted = await components.db.tx((tx) => components.users.issueToken(tx, created.id));
    const login = await postJson(`${publicUrl}/auth/tokens`, {
      user: created.id,
      password: theOnePassword,
    });
    const issuedBody = await login.text();
    assert.equal(login.status, 201, issuedBody);
    const issued: IssuedToken = JSON.parse(issuedBody);
    assert.deepEqual(Object.keys(issued).sort(), Object.keys(minted).sort());
    assert.deepEqual(issued, {
      // Two Tokens for one User, and different ones: the plaintext is minted per issue and
      // exists only in the response that carries it. Its length is checked against the
      // in-process Token's below, which is what a truncating schema would fail.
      token: issued.token,
      expiresAt: issued.expiresAt,
      // The whole User, embedded, and byte for byte what the Agent server answered, so a
      // field declared in one of those two schemas and forgotten in the other differs here.
      user: read,
    } satisfies IssuedToken);
    assert.equal(issued.token.length, minted.token.length);
    assert.notEqual(issued.token, minted.token);
    assert.equal(new Date(issued.expiresAt).toISOString(), issued.expiresAt);

    // The presented User, over the Token just traded for, which is the fourth schema
    // answering a `UserRecord` and the last one.
    const presented = await fetch(`${publicUrl}/auth/me`, {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    const presentedBody = await presented.text();
    assert.equal(presented.status, 200, presentedBody);
    assert.deepEqual(JSON.parse(presentedBody), read);

    // And nothing that could be a credential is on any of the four wires that carry a
    // User. `asUserRecord` says "the password hash is not on this wire, ever" and the
    // response schema is the second, independent enforcement of it; this is what notices
    // if both are undone at once, and it reads the bytes rather than a parsed object,
    // since a hash nested inside `attributes` would parse into a field that is supposed
    // to be there.
    for (const [what, body] of [
      ["GET /users/:id", JSON.stringify(read)],
      ["GET /users", JSON.stringify(listed)],
      ["POST /auth/tokens", issuedBody],
      ["GET /auth/me", presentedBody],
    ] as const) {
      assert.equal(/password|scrypt/i.test(body), false, `${what} carried a credential: ${body}`);
    }

    // And the three routes that answer nothing still answer nothing. A response schema is
    // a serializer, so a 204 declared as a body is a route that answers 500 at
    // serialization time; `type: "null"` is what keeps these empty and what keeps the
    // document from promising a body nobody sends (ADR-0040). Ordered so that each has a
    // Token that still works: the password change first, then the presented Token revoked,
    // then every Token of that User revoked over the one `issueToken` minted.
    const changing = { currentPassword: theOnePassword, newPassword: "and its replacement" };
    for (const [method, path, token, body] of [
      ["PUT", "/auth/password", issued.token, changing],
      ["DELETE", "/auth/tokens/current", issued.token, undefined],
      ["DELETE", "/auth/tokens", minted.token, undefined],
    ] as const) {
      const answered = await fetch(`${publicUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const answeredBody = await answered.text();
      assert.equal(answered.status, 204, `${method} ${path}: ${answeredBody}`);
      assert.equal(answeredBody, "");
      // No content type either, which is Fastify not serializing rather than serializing
      // nothing: a declared body would have put one back.
      assert.equal(answered.headers.get("content-type"), null);
    }
  });

  it("answers a Message log as the HTTP Messenger recorded it, and pages it three ways", async () => {
    // A User of this test's own, because `seq` is per User and every number below is an
    // assertion: the User the rest of the file shares has a Message posted into their log by
    // the drain test underneath this one.
    const reader = await admitted();

    // Four Messages in one log and in both directions, written the only two ways a Message
    // can be. `send` is the part's own method, which is what a Signal Handler calls and what
    // the agent's route reaches; the Public submission is the only way an inbound Message
    // exists at all, since there is deliberately no method that writes one (ADR-0034).
    const first = await sending(reader.id, "the first thing the agent said");
    const submitted = await postJson(
      `${publicUrl}/messages`,
      { text: roundTripSubmission },
      reader.token,
    );
    const submittedBody = await submitted.text();
    assert.equal(submitted.status, 201, submittedBody);
    const second: MessageRecord = JSON.parse(submittedBody);
    const third = await sending(reader.id, "and the answer to it");
    const fourth = await sending(reader.id, "and one more, unasked");

    // The log as the part holds it: in this process, never serialized, and therefore the one
    // side of every comparison below that a response schema cannot have taken anything out
    // of (ADR-0040). One numbered sequence across both directions is the whole of ADR-0035,
    // and it is what makes a single cursor able to serve a poll and a render alike.
    const recorded = await components.messenger.history(reader.id);
    assert.deepEqual(
      recorded.map((message) => message.seq),
      [1, 2, 3, 4],
    );
    const [, held] = recorded;
    assert.ok(held !== undefined);

    // The whole body of the submitted Message against a literal the type checker holds to
    // the record type, with its id and its timestamp taken from the record the part holds
    // rather than from itself: add a field to `MessageRecord` and this file stops compiling,
    // leave it out of the response schema and this comparison fails.
    assert.deepEqual(second, {
      id: held.id,
      // From the Token and from nowhere a client can write: the body was `{ text }`.
      userId: reader.id,
      // Inbound because it arrived on the Public server, which is the only thing that
      // decides a direction, and there is no field for one on either route.
      direction: "inbound",
      // Numbered after the outbound Message before it, which is what "one log" means.
      seq: 2,
      text: roundTripSubmission,
      createdAt: held.createdAt,
    } satisfies MessageRecord);
    assert.equal(new Date(second.createdAt).toISOString(), second.createdAt);

    // And the Signal that submission emits in the same transaction, which is this part's
    // other contract and carries the same record: the Handler wrote its text into the
    // Operator's own Component, so waiting on that is waiting for the whole path.
    await waitUntil("the submitted Message has woken its Handler", async () =>
      components.notes.lines.includes(roundTripSubmission),
    );

    // The agent's read, which names the User in a query parameter, and the User's own, which
    // has no parameter for one at all. Two surfaces, one query, and the same four records
    // out of both, compared against what the part holds rather than against each other,
    // which is what a field stripped from both sides would survive.
    const agentRead = await agentJson<{ messages: MessageRecord[] }>(`/messages?user=${reader.id}`);
    assert.deepEqual(agentRead.messages, recorded);
    assert.deepEqual((await ownLog(reader.token, "")).messages, recorded);

    // The three cursor cases, on the surface a person writes a client against, and all three
    // ascending (ADR-0035). No cursor is the **newest** page and not the oldest, which is the
    // case a client has no way to guess and the description is now what tells it.
    assert.deepEqual(await ownTexts(reader.token, "?limit=2"), [third.text, fourth.text]);
    assert.deepEqual(await ownTexts(reader.token, "?before=3&limit=2"), [first.text, second.text]);
    assert.deepEqual(await ownTexts(reader.token, "?after=2"), [third.text, fourth.text]);
    // And `after=0`, which is the only spelling of "from the beginning": no cursor means the
    // newest page instead, and nothing is numbered 0.
    assert.deepEqual(
      await ownTexts(reader.token, "?after=0"),
      recorded.map((message) => message.text),
    );

    // Both cursors at once describes two windows, so it is refused rather than one of them
    // quietly winning. The body is read whole because a 400 is serialized through the shared
    // error schema now: a route declaring it drops any field that schema does not have, and
    // the useful part of this refusal is the sentence naming what to pass instead.
    const bothCursors = await bearing(`${publicUrl}/messages?after=1&before=4`, reader.token);
    const refusal: { statusCode: number; error: string; message: string } = JSON.parse(
      await bothCursors.text(),
    );
    assert.equal(bothCursors.status, 400);
    assert.deepEqual(Object.keys(refusal).sort(), ["error", "message", "statusCode"]);
    assert.match(refusal.message, /after and before describe two different windows/);
  });

  it("answers a Decision as Decisions published it, and a key set with nothing private in it", async () => {
    // The same serializer hazard as the two round trips above, on the record where a dropped
    // field would be worst: the artifact **is** the Decision, so a `jws` the schema forgot to
    // declare is a log of Decisions nobody can verify, answered with a 200 (ADR-0040).
    //
    // The independent side of this comparison is not the part's own `history`, which would be
    // one of ours agreeing with another of ours, but something better: the payload inside the
    // artifact, which this part serialized itself and which no response schema has been
    // anywhere near. So a field stripped on the wire disagrees with the bytes that were signed.
    const published = await postJson(`${agentUrl}/decisions`, {
      statement: "we will keep the Gateway trusted and say so out loud",
    });
    const publishedBody = await published.text();
    assert.equal(published.status, 201, publishedBody);
    const decision: DecisionRecord = JSON.parse(publishedBody);

    // Read back over the *other* server, by a User with a Token, which is the whole path a
    // Party takes: one global log, no scoping, the same record from both surfaces.
    const read = await bearing(`${publicUrl}/decisions?after=${decision.seq - 1}`, client.token);
    const readBody = await read.text();
    assert.equal(read.status, 200, readBody);
    const { decisions }: { decisions: DecisionRecord[] } = JSON.parse(readBody);
    assert.deepEqual(decisions, [
      {
        seq: decision.seq,
        statement: "we will keep the Gateway trusted and say so out loud",
        jws: decision.jws,
        createdAt: decision.createdAt,
      } satisfies DecisionRecord,
    ]);

    // And the artifact agreeing with all four fields of it, which is what makes the
    // comparison above more than two HTTP responses agreeing with each other.
    const [header, payload, signature] = decision.jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined);
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), {
      seq: decision.seq,
      createdAt: decision.createdAt,
      statement: decision.statement,
    });

    // The key set, over the Public server and with no Token, and **without a private member
    // in it**: the worst failure available anywhere in this feature is the private scalar
    // being served from an unauthenticated route, and this is the assembled Gateway's own
    // check of it (ADR-0042).
    const keys = await fetch(`${publicUrl}/jwks.json`);
    const keysBody = await keys.text();
    assert.equal(keys.status, 200, keysBody);
    const [key]: JsonWebKey[] = JSON.parse(keysBody).keys;
    assert.ok(key !== undefined, keysBody);
    assert.equal(Object.hasOwn(key, "d"), false, keysBody);
    assert.equal(keysBody.includes(String(signingKey.export({ format: "jwk" }).d)), false);

    // And the whole point of the two of them together: a verifier holding the key off one
    // route and the artifact off the other checks it with the built-in, having asked this
    // Gateway for no opinion at all.
    assert.equal(
      verify(
        null,
        Buffer.from(`${header}.${payload}`, "utf8"),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
  });

  it("signs whatever the agent asks for, and checks one back for a User", async () => {
    // **The Decision label, asked for on the generic route**, which is the thing a reviewer
    // will want refused and which is deliberately allowed: publishing a Decision is an
    // authority the agent already holds, so a decision-typed artifact minted here is that same
    // authority exercised without a log row rather than a forgery (ADR-0042). It is asserted
    // against the assembled Gateway rather than against Signatures alone because "nothing is
    // reserved" only means something where the real Decisions is sitting next door.
    const claimed = "a receipt for the March invoice, which is not a Decision";
    const signed = await postJson(`${agentUrl}/sign`, {
      statement: claimed,
      typ: "saf-decision+jws",
    });
    const signedBody = await signed.text();
    // 200 and not 201: nothing was created, and there is nowhere this could be fetched from
    // again.
    assert.equal(signed.status, 200, signedBody);
    const { jws }: { jws: string } = JSON.parse(signedBody);

    // Checked the way the third party checks it, which is the only check worth anything: the
    // key off the unauthenticated route, `node:crypto` rather than the library that signed it,
    // and the signing input reconstructed by splitting the emitted string.
    const [header, payload, signature] = jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined);
    const keys = await fetch(`${publicUrl}/jwks.json`);
    const [key]: JsonWebKey[] = JSON.parse(await keys.text()).keys;
    assert.ok(key !== undefined);
    assert.equal(
      verify(
        null,
        Buffer.from(`${header}.${payload}`, "utf8"),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
    // The label that was asked for, in the protected header and therefore covered by the
    // signature, and a payload carrying the Statement and **nothing else**: no `seq` and no
    // `createdAt`, both of which are a Decision's and neither of which this route invents.
    assert.deepEqual(decoded(header), { alg: "EdDSA", typ: "saf-decision+jws" });
    assert.deepEqual(decoded(payload), { statement: claimed });

    // And the log does not have it, which is the sentence the freedom above costs: `typ` is
    // the agent's signed claim about its own artifact and not a promise that a row exists, so
    // only an artifact fetched from here is guaranteed to be one of these (ADR-0042).
    const { decisions } = await agentJson<{ decisions: DecisionRecord[] }>("/decisions?after=0");
    assert.equal(
      decisions.some((published) => published.jws === jws),
      false,
      "signing must not have published anything",
    );

    // The lazy check, and the first half of what it costs: a Token, and the User Manager's
    // single 401 without one. Compared body for body against another Public route's refusal,
    // because "the same 401" is the claim and this part authenticates nobody (ADR-0030).
    const refused = await fetch(`${publicUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jws }),
    });
    assert.equal(refused.status, 401);
    const elsewhere = await fetch(`${publicUrl}/auth/me`);
    assert.equal(elsewhere.status, 401);
    assert.deepEqual(JSON.parse(await refused.text()), JSON.parse(await elsewhere.text()));

    // And with one, the verdict and what the artifact said. The independent side of this
    // comparison is the bytes above, which no response schema has been near, so a `header` or
    // a `payload` the serializer flattened disagrees with what was signed (ADR-0040).
    const checked = await postJson(`${publicUrl}/verify`, { jws }, client.token);
    const checkedBody = await checked.text();
    assert.equal(checked.status, 200, checkedBody);
    assert.deepEqual(JSON.parse(checkedBody), {
      verified: true,
      header: decoded(header),
      payload: decoded(payload),
    });

    // A string that is nothing of the kind is a `false` and a 200: it arrived from a caller,
    // so it is an answer rather than an error.
    const nonsense = await postJson(
      `${publicUrl}/verify`,
      { jws: "not an artifact" },
      client.token,
    );
    const nonsenseBody = await nonsense.text();
    assert.equal(nonsense.status, 200, nonsenseBody);
    assert.deepEqual(JSON.parse(nonsenseBody), { verified: false });
  });

  it("drains with everything still up, and closes it all once the drain is done", async () => {
    const posted = await postMessage(inFlightAtShutdown);
    assert.equal(posted.status, 201);

    // The Run is in flight and parked. Nothing else in this repository stops a Gateway from
    // here, which is why the ordering has been reasoning in a comment until now. By text
    // rather than by count, since the round-trip Run above it has been and gone.
    await waitUntil("the Run of the submitted Message has started", async () =>
      runtime.texts().includes(inFlightAtShutdown),
    );

    // The Handler ran, and it reached the Component `extend` returned. That is the cycle
    // closed at runtime: this Handler was built by a callback taking objects the worker
    // holding it was constructed before (ADR-0038). Two lines and not one, because the round
    // trip above submitted a Message too, and both went through this Handler.
    assert.deepEqual(components.notes.lines, [roundTripSubmission, inFlightAtShutdown]);

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
    //
    // The last line is what a Decision reached by a failing Run costs and buys: a post phase
    // that commits to something on the way out gets a row and an artifact, because the insert
    // goes through the Db and the Db stops last (ADR-0043). Which part of the order that
    // depends on is on `answering` above, and it is the Db's key rather than Decisions' own.
    assert.deepEqual(duringTheDrain, [
      "the User Manager read the Db: 1 User",
      "the Agent server answered: 200",
      "the Public server took a submission: 201",
      "the Operator's own Component: stopped",
      "the HTTP Messenger sent a Message: outbound",
      "Decisions published a Decision: the same artifact",
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

  it("is the eight and nothing else when no extend is passed", () => {
    const bare = createGatewayWithDefaults({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      signingKey,
      tokenTtl: hour,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      handlers: () => ({}),
    });

    assert.deepEqual(Object.keys(bare.components), theEight);

    // And the record still has its types, which is a claim about the type parameter's
    // **default** rather than about the object. With `extend` omitted there is nothing to
    // infer the extension from, and a type parameter with no inference candidates falls back
    // to its constraint — which carries `db?: never` and would reduce the whole intersection
    // to `never`. This line is what stops compiling if that default is ever dropped.
    const db: Db = bare.components.db;
    assert.equal(typeof db.migrate, "function");
  });

  it("forwards signingAlg, which is the only way an RSA key reaches this assembly at all", async () => {
    // Six algorithms are valid for one RSA key and nothing in the key says which was meant,
    // so Signatures refuses one that arrives without an answer (ADR-0042). What this option
    // is for is that the refusal be *answerable* here: without it an Operator holding an RSA
    // key would have to leave the assembly for `createGateway` to say PS256, and the
    // assembly is how nearly every deployment builds a Gateway.
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const withRsa = {
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      signingKey: rsa,
      tokenTtl: hour,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      handlers: () => ({}),
    } as const;

    // The refusal is this constructor's own, in the sense that it happens as it runs: nothing
    // has listened, migrated or connected by the time an Operator reads it.
    assert.throws(() => createGatewayWithDefaults(withRsa), /signingAlg/);

    const answered = createGatewayWithDefaults({ ...withRsa, signingAlg: "PS256" });
    const jws = await answered.components.signatures.sign("saf-decision+jws", {
      statement: "we will ship on Friday",
    });
    const [header] = jws.split(".");

    assert.deepEqual(decoded(String(header)), { alg: "PS256", typ: "saf-decision+jws" });
  });

  it("refuses an extend that returns one of the eight", () => {
    const substituting = createGatewayWithDefaults({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      signingKey,
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
    assert.deepEqual(Object.keys(substituting.components), [...theEight, "notes"]);
  });

  it("refuses an extend that returns either of the two newest keys", () => {
    // The two keys added last, pinned separately, because the refusal comes from a mapped
    // type over `keyof DefaultComponents` and a key added to the record without being added
    // there would be silently substitutable. A substituted Signatures is the sharpest case in
    // the record: it holds the private key, so an Operator's own under this key would start
    // where ours would have, sign with whatever it liked, and nothing anywhere would say so.
    createGatewayWithDefaults({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      signingKey,
      tokenTtl: hour,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // @ts-expect-error signatures is a default key and may not be replaced by an extension
      extend: (defaults) => ({ signatures: defaults.signatures }),
      handlers: () => ({}),
    });
    createGatewayWithDefaults({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      signingKey,
      tokenTtl: hour,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // @ts-expect-error decisions is a default key and may not be replaced by an extension
      extend: (defaults) => ({ decisions: defaults.decisions }),
      handlers: () => ({}),
    });
  });
});

/**
 * Both servers describing themselves, which is a claim no part can make on its own: a part
 * knows its own routes and nothing about which surface it shares them with, and the plugin
 * that discovers them is registered by this constructor before any part exists at all
 * ([ADR-0040](../docs/adr/0040-the-gateway-describes-its-own-http-api.md)).
 *
 * Nothing here reaches PostgreSQL. The Gateways are constructed against the database URL
 * that resolves to nothing, the same one the two tests above it use, and never started:
 * `openDb` connects lazily, `ready()` boots the plugins without listening, and `inject`
 * answers without a socket. `inject` is right here for the reason real sockets are right
 * further up: that suite's subject is what is listening and when, and `inject` answers on
 * a server that has been closed. This one never starts or stops a Gateway.
 *
 * **All twenty-two routes declare what they answer with**, one part at a time: the Signal
 * Worker's four, the User Manager's eight, the HTTP Messenger's four, Decisions' three and
 * Signatures' three. What no test here can do is catch a *dropped* field, since a document and
 * the wire it describes are the same schema read twice. That is the round-trip assertions in
 * the first suite, which need records real parts recorded and therefore a real database.
 */
describe("the description both servers serve", () => {
  /** Somewhere nothing resolves, since none of this connects. */
  const nowhere = "postgres://nobody@example.invalid/none";

  /**
   * What each surface serves, sorted, and the whole of it.
   *
   * Written out rather than counted, because the two facts worth pinning are which routes
   * a deployment assembled the default way ends up with and, more sharply, that neither
   * list contains a single entry of the other's: one plugin instance per server is what
   * makes an Agent server route unable to leak into the Public server's description
   * (ADR-0040).
   *
   * A path ending in a slash is a route registered at `""` under a prefix, which is how
   * `POST /users` and both Message routes are written. Cosmetic, carried by a generated
   * client, and not worth changing a route over.
   */
  const agentPaths = [
    "/decisions/",
    "/messages/",
    "/runs",
    "/runs/{id}",
    "/sign",
    "/signals",
    "/signals/{id}",
    "/users/",
    "/users/{id}",
  ];
  const publicPaths = [
    "/auth/me",
    "/auth/password",
    "/auth/tokens",
    "/auth/tokens/current",
    "/decisions/",
    "/jwks.json",
    "/messages/",
    "/verify",
  ];

  /** As much of an OpenAPI document as anything here reads. */
  type Property = {
    readonly type?: string;
    readonly description?: string;
    readonly enum?: readonly string[];
    /** Present on an array, which the one envelope read below is. */
    readonly items?: Schema;
  };
  type Schema = {
    readonly properties?: Readonly<Record<string, Property>>;
    readonly required?: readonly string[];
  };
  /** One query parameter, which is where a `querystring` schema's properties end up. */
  type Parameter = {
    readonly name: string;
    readonly required?: boolean;
    readonly description?: string;
  };
  /** Absent on a response that carries no body, which is the whole point of a 204. */
  type Answered = {
    readonly description: string;
    readonly content?: Readonly<Record<string, { readonly schema: Schema }>>;
  };
  type Operation = {
    readonly tags?: readonly string[];
    readonly summary?: string;
    readonly description?: string;
    readonly parameters?: readonly Parameter[];
    readonly requestBody?: {
      readonly content: Readonly<Record<string, { readonly schema: Schema }>>;
    };
    readonly responses: Readonly<Record<string, Answered>>;
  };
  type Method = "get" | "post" | "put" | "delete";
  type Description = {
    readonly openapi: string;
    readonly info: {
      readonly title: string;
      readonly description: string;
      readonly version: string;
    };
    readonly paths: Readonly<Record<string, Partial<Record<Method, Operation>>>>;
  };

  let described: Gateway<DefaultComponents>;

  before(async () => {
    described = unstarted();
    // `ready` and not `start`: booting is what runs the queued plugins, and it is the
    // whole of what a document needs. Nothing binds a port.
    await described.components.agentServer.fastify.ready();
    await described.components.publicServer.fastify.ready();
  });

  after(async () => {
    // Never started, so this is not the Gateway's `stop`. It is the two instances let go
    // of, which is what keeps `@fastify/swagger-ui`'s static handler from outliving the
    // file.
    await described.components.agentServer.fastify.close();
    await described.components.publicServer.fastify.close();
  });

  it("describes the Agent server, and nothing the Public server serves", async () => {
    const document = await documentOf(described.components.agentServer.fastify);

    assert.equal(document.openapi, "3.0.3");
    assert.equal(document.info.title, "Shared Agent Gateway: Agent server");
    assert.equal(document.info.version, describedVersion);
    // The one sentence about this surface that is true of every route on it, and the one
    // an Agent Implementation would otherwise be told by hand: there is no credential here
    // (ADR-0010, ADR-0025).
    assert.match(document.info.description, /no authentication of any kind/);

    assert.deepEqual(Object.keys(document.paths).sort(), agentPaths);
    // And the separation stated the other way round, so that a route group moving between
    // surfaces fails this rather than passing on a path set that happens to be a superset.
    assert.deepEqual(
      Object.keys(document.paths).filter((path) => path.startsWith("/auth/")),
      [],
    );

    // Neither the document nor the page it is browsed in appears in the document. That is
    // the `onRoute` hook again: `/openapi.json` is declared straight onto the instance, so
    // the queued plugin has not added its hook yet, and the UI's own routes are a plugin's.
    // Correct rather than a bug, and asserted so that a later change that made them appear
    // is a decision rather than a surprise.
    assert.equal(Object.hasOwn(document.paths, "/openapi.json"), false);
    assert.equal(Object.hasOwn(document.paths, "/docs"), false);
  });

  it("describes the Public server, and nothing only the Agent server serves", async () => {
    const document = await documentOf(described.components.publicServer.fastify);

    assert.equal(document.openapi, "3.0.3");
    assert.equal(document.info.title, "Shared Agent Gateway: Public server");
    assert.equal(document.info.version, describedVersion);
    assert.match(document.info.description, /bearer Token/);

    assert.deepEqual(Object.keys(document.paths).sort(), publicPaths);
    // The reverse of the assertion above, and the one that matters most: `/signals`,
    // `/runs` and `/users` are the unauthenticated Agent server's, and a description
    // promising them to whoever can reach the Public server would be advertising a surface
    // that is not there.
    for (const agentOnly of ["/signals", "/runs", "/users/", "/users/{id}"]) {
      assert.equal(Object.hasOwn(document.paths, agentOnly), false, `${agentOnly} is the agent's`);
    }
  });

  it("says what the Signal Worker's four routes answer with, and how they behave", async () => {
    // The sentences an Operator used to transcribe into the agent's instructions, in the
    // document instead, and the statuses, which were never written down anywhere: an
    // agent that cannot tell a 404 for an unknown Signal from a 400 for a mistyped one
    // has to guess (ADR-0025, ADR-0040). Read out of the served document rather than off
    // the schema objects, because the document is the only part of this a consumer sees.
    const document = await documentOf(described.components.agentServer.fastify);
    const answers: Readonly<Record<string, readonly string[]>> = {
      "/signals": ["200", "400"],
      "/signals/{id}": ["200", "400", "404"],
      "/runs": ["200", "400"],
      "/runs/{id}": ["200", "400", "404"],
    };

    for (const [path, statuses] of Object.entries(answers)) {
      const route = document.paths[path]?.get;
      assert.ok(route !== undefined, `${path} should be described`);
      assert.deepEqual(Object.keys(route.responses), statuses, path);
      for (const [status, response] of Object.entries(route.responses)) {
        // "Default Response" is what an undeclared response reads as, so this is the
        // line that tells a described status from a status the plugin invented a
        // sentence for.
        assert.notEqual(response.description, "Default Response", `${path} ${status}`);
      }

      // Tagged, so the browsable page groups them rather than listing sixteen routes
      // flat, and summarised, so the list is readable before anything is expanded.
      assert.ok(route.tags !== undefined && route.tags.length > 0, `${path} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, path);

      // The two behaviours every route on this surface has and no reader would assume.
      const description = String(route.description);
      assert.match(description, /not scoped by Session or by User/, path);
      assert.match(description, /unknown query parameter is a \*\*400\*\*/, path);
    }

    // And the third, which only the two list routes have: a `limit` past the cap is
    // refused, so a caller that pages by asking for more finds out rather than reading a
    // short answer as the end of the queue.
    for (const path of ["/signals", "/runs"]) {
      assert.match(
        String(document.paths[path]?.get?.description),
        /\*\*refused with a 400\*\* rather than quietly reduced/,
        path,
      );
    }
  });

  it("says what the User Manager's eight routes answer with, across both surfaces", async () => {
    // Eight routes and two documents, which is the one part that spans both surfaces and
    // therefore the one where "an Agent server route can never leak into the Public
    // server's description" is a claim about a part rather than about a server (ADR-0040).
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    // A path ending in a slash is a route registered at `""` under a prefix, which is how
    // `POST /users` and `GET /users` are written.
    const answers: readonly {
      readonly surface: keyof typeof documents;
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { surface: "agent", path: "/users/", method: "post", statuses: ["201", "400"] },
      { surface: "agent", path: "/users/", method: "get", statuses: ["200", "400"] },
      { surface: "agent", path: "/users/{id}", method: "get", statuses: ["200", "400", "404"] },
      { surface: "public", path: "/auth/tokens", method: "post", statuses: ["201", "400", "401"] },
      { surface: "public", path: "/auth/me", method: "get", statuses: ["200", "400", "401"] },
      {
        surface: "public",
        path: "/auth/tokens/current",
        method: "delete",
        statuses: ["204", "400", "401"],
      },
      {
        surface: "public",
        path: "/auth/tokens",
        method: "delete",
        statuses: ["204", "400", "401"],
      },
      { surface: "public", path: "/auth/password", method: "put", statuses: ["204", "400", "401"] },
    ];

    for (const { surface, path, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${path}`;
      const route = documents[surface].paths[path]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        // "Default Response" is what an undeclared response reads as, so this is the line
        // that tells a described status from a status the plugin invented a sentence for.
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        // A 204 carries **no `content` at all**, which is what stops the document from
        // promising a body nobody sends. That the route still answers 204 is the first
        // suite's, since it needs a request that reaches a handler.
        assert.equal(Object.hasOwn(answered, "content"), status !== "204", `${where} ${status}`);
      }

      assert.ok(route.tags !== undefined && route.tags.length > 0, `${where} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    // Tagged so that the two surfaces group separately rather than arriving as one list of
    // eight: the routes an agent may call are Users, the routes a person's client calls are
    // Authentication, and neither name appears in the other document.
    assert.deepEqual(tagsOf(documents.agent, "/users/", "post"), ["Users"]);
    assert.deepEqual(tagsOf(documents.public, "/auth/me", "get"), ["Authentication"]);
    assert.equal(JSON.stringify(documents.agent.paths).includes("Authentication"), false);
    assert.equal(JSON.stringify(documents.public.paths).includes('"Users"'), false);

    // The sentence an Operator used to transcribe into the agent's instructions, and the
    // one this route's whole security boundary is: there is no parameter, so there is
    // nothing to bypass (ADR-0029).
    const creating = String(documents.agent.paths["/users/"]?.post?.description);
    assert.match(creating, /accepts no Attributes, and there is no parameter for them/);

    // Which routes want a Token, said per route, because the useful thing to know is which
    // one is the exception rather than that most of them do.
    for (const [path, method] of [
      ["/auth/me", "get"],
      ["/auth/tokens/current", "delete"],
      ["/auth/tokens", "delete"],
      ["/auth/password", "put"],
    ] as const) {
      const route = documents.public.paths[path]?.[method];
      assert.match(String(route?.description), /\*\*Requires a bearer Token\*\*/, path);
    }
    const trading = String(documents.public.paths["/auth/tokens"]?.post?.description);
    assert.match(trading, /the one Public route that requires no Token/);

    // The User as it is answered: exactly three fields, named rather than counted, because
    // the schema being a **positive list** is what keeps a column added to `saf_users.users`
    // off the wire. A hash reaching one is the first suite's assertion; that the document
    // does not even describe one is this.
    const user = schemaOf(documents.agent, "/users/{id}", "get", "200");
    assert.deepEqual(Object.keys(user.properties ?? {}).sort(), ["attributes", "createdAt", "id"]);
    assert.deepEqual([...(user.required ?? [])].sort(), ["attributes", "createdAt", "id"]);
    for (const document of Object.values(documents)) {
      assert.equal(JSON.stringify(document).includes("passwordHash"), false);
      assert.equal(JSON.stringify(document).includes("password_hash"), false);
    }

    // `attributes` is declared with an **empty schema**, which is what passes arbitrary
    // JSON through byte intact and renders in the page as "any". A `type` here would be
    // the Gateway having an opinion about Attributes, and the round trip in the first
    // suite is what proves the passthrough rather than this line.
    assert.equal(user.properties?.attributes?.type, undefined);

    // Property descriptions on the two fields whose name is not the whole story, and on
    // neither of the two whose name is.
    assert.match(String(user.properties?.attributes?.description), /where grouping/);
    assert.equal(user.properties?.id?.description, undefined);
    assert.equal(user.properties?.createdAt?.description, undefined);
    const token = schemaOf(documents.public, "/auth/tokens", "post", "201");
    assert.deepEqual(Object.keys(token.properties ?? {}).sort(), ["expiresAt", "token", "user"]);
    assert.match(String(token.properties?.expiresAt?.description), /When the Token stops working/);
    assert.equal(token.properties?.token?.description, undefined);
  });

  it("says what the HTTP Messenger's four routes answer with, and how a log is paged", async () => {
    // The other part that spans both surfaces, and the one whose two surfaces are likeliest
    // to be conflated: submitting and reading are the same pair of routes on each, differing
    // in exactly one thing, which is where the User comes from (ADR-0035, ADR-0040).
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    // One path on both, ending in a slash because both plugins register at `""` under the
    // prefix the constructor supplies.
    const messages = "/messages/";

    // The 404 is the agent's alone, and its absence from the Public submission is the
    // document following the code: nothing removes a User (ADR-0029), so the id on that
    // route is the one the Manager's hook just read a User by and the status is unreachable.
    // The 503 is on both submissions, since a busy log is busy from either direction.
    const answers: readonly {
      readonly surface: keyof typeof documents;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { surface: "agent", method: "post", statuses: ["201", "400", "404", "503"] },
      { surface: "agent", method: "get", statuses: ["200", "400"] },
      { surface: "public", method: "post", statuses: ["201", "400", "401", "503"] },
      { surface: "public", method: "get", statuses: ["200", "400", "401"] },
    ];

    for (const { surface, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${messages} on the ${surface} server`;
      const route = documents[surface].paths[messages]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        // "Default Response" is what an undeclared response reads as, so this is the line
        // that tells a described status from a status the plugin invented a sentence for.
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        // Every one of these carries a body, unlike the User Manager's three 204s.
        assert.ok(Object.hasOwn(answered, "content"), `${where} ${status}`);
      }

      assert.ok(route.tags !== undefined && route.tags.length > 0, `${where} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    // Tagged so that the Messenger's routes are a group of their own on each page rather
    // than mixed into the Signal Worker's four or the login routes. The word is the same on
    // both surfaces and does not need to differ: these are two documents, so which surface a
    // reader is on is the one they fetched rather than a label inside it.
    assert.deepEqual(tagsOf(documents.agent, messages, "post"), ["Messages"]);
    assert.deepEqual(tagsOf(documents.public, messages, "get"), ["Messages"]);
    assert.equal(tagsOf(documents.agent, "/signals", "get").includes("Messages"), false);
    assert.equal(tagsOf(documents.public, "/auth/me", "get").includes("Messages"), false);

    // **The cursor semantics, which no schema conveys any part of**: `after` and `before` are
    // two optional integers, and nothing about that shape says which of them is the newest
    // page or that all three cases answer the same way up (ADR-0035). Asserted on both reads
    // and in the same words, because the two are one query asked about a User named in a
    // different place and a client written against either pages identically.
    for (const surface of ["agent", "public"] as const) {
      const reading = String(documents[surface].paths[messages]?.get?.description);
      assert.match(reading, /\*\*Three cursor cases, one order\.\*\*/, surface);
      assert.match(reading, /No cursor answers the newest page/, surface);
      assert.match(reading, /`before=N` answers the newest page strictly below `N`/, surface);
      assert.match(reading, /`after=N` walks forwards from `N`/, surface);
      assert.match(reading, /All three answer \*\*ascending by `seq`\*\*/, surface);
      assert.match(reading, /Passing `after` and `before` together is a \*\*400\*\*/, surface);
      // And the flag the envelope deliberately does not carry, with what to do instead.
      assert.match(reading, /no more-results flag/, surface);
      assert.match(reading, /`messages\.length === limit`/, surface);
      // The cap, which is the one list in the framework a caller can page past.
      assert.match(reading, /\*\*refused with a 400\*\* rather than quietly reduced/, surface);
    }

    // **The two surfaces differing rather than blurring**, on the submission: the agent names
    // the User in a required field, and the Public route has no such field and nowhere for
    // one to arrive, which is what makes the attribution in the Signal payload trustworthy.
    const agentSend = bodyOf(documents.agent, messages, "post");
    assert.deepEqual(Object.keys(agentSend.properties ?? {}).sort(), ["text", "userId"]);
    assert.deepEqual([...(agentSend.required ?? [])].sort(), ["text", "userId"]);
    const submission = bodyOf(documents.public, messages, "post");
    assert.deepEqual(Object.keys(submission.properties ?? {}), ["text"]);
    assert.deepEqual(submission.required, ["text"]);
    assert.match(
      String(documents.public.paths[messages]?.post?.description),
      /no field for the submitting User and nowhere for one to arrive/,
    );

    // And the same difference on the reads, where it is a parameter rather than a field: one
    // required `user` on the agent's, and no parameter naming a User on the other at all.
    const agentWindow = parametersOf(documents.agent, messages, "get");
    assert.deepEqual(
      agentWindow.filter((parameter) => parameter.required).map((parameter) => parameter.name),
      ["user"],
    );
    assert.deepEqual(
      parametersOf(documents.public, messages, "get")
        .map((parameter) => parameter.name)
        .sort(),
      ["after", "before", "limit"],
    );

    // The Message as it is answered, one shape on all four routes, and the two property
    // descriptions this record needs: `seq` is the cursor and its name does not say so, and
    // `direction` is a field a caller would expect to be able to set and cannot.
    const fields = ["createdAt", "direction", "id", "seq", "text", "userId"];
    const message = schemaOf(documents.agent, messages, "post", "201");
    assert.deepEqual(Object.keys(message.properties ?? {}).sort(), fields);
    assert.deepEqual([...(message.required ?? [])].sort(), fields);
    assert.match(String(message.properties?.seq?.description), /It is the cursor/);
    assert.deepEqual(message.properties?.direction?.enum, ["inbound", "outbound"]);
    assert.match(
      String(message.properties?.direction?.description),
      /Decided by the server the request arrived on/,
    );
    // And none on the three whose name is their whole story.
    assert.equal(message.properties?.id?.description, undefined);
    assert.equal(message.properties?.userId?.description, undefined);
    assert.equal(message.properties?.createdAt?.description, undefined);

    // The same shape under the envelope on a read, which is where a client meets it most:
    // one `messages` array and no `hasMore` beside it.
    const page = schemaOf(documents.public, messages, "get", "200");
    assert.deepEqual(Object.keys(page.properties ?? {}), ["messages"]);
    assert.deepEqual(
      Object.keys(page.properties?.messages?.items?.properties ?? {}).sort(),
      fields,
    );

    // The two failures that are this part's own, and the reason each is worth a sentence: a
    // 404 that came from the write rather than from a lookup in front of it, and a 5xx whose
    // correct handling is to send the same thing again.
    assert.match(
      String(documents.agent.paths[messages]?.post?.responses["404"]?.description),
      /foreign key onto the User Manager's table/,
    );
    for (const surface of ["agent", "public"] as const) {
      assert.match(
        String(documents[surface].paths[messages]?.post?.responses["503"]?.description),
        /\*\*was not recorded\*\*, and sending it again is the right thing to do/,
        surface,
      );
    }

    // Which Public routes want a Token, in the User Manager's own words: this part holds no
    // scheme of its own, so restating them would be two descriptions of one hook.
    for (const method of ["post", "get"] as const) {
      const route = documents.public.paths[messages]?.[method];
      assert.match(String(route?.description), /\*\*Requires a bearer Token\*\*/, method);
      assert.match(String(route?.responses["401"]?.description), /Authentication failed/, method);
    }
  });

  it("says what Decisions' three routes answer with, and what the artifact in them is", async () => {
    // The third part that spans both surfaces, and the one whose two surfaces are the same
    // read twice: the log is global, so the agent's read and a User's differ in nothing but
    // whether a Token is wanted, which is a thing a client author should be told rather than
    // left to infer from a missing parameter (ADR-0043).
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const log = "/decisions/";

    const answers: readonly {
      readonly surface: keyof typeof documents;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { surface: "agent", method: "post", statuses: ["201", "400"] },
      { surface: "agent", method: "get", statuses: ["200", "400"] },
      // No 404 anywhere on this part, and its absence is the document following the code:
      // with no `user_id` there is no foreign key, so ADR-0036's "the agent's 404 is
      // PostgreSQL's 23503 caught" has no analogue here. No 503 either: `nextval` is atomic,
      // so there is no race to lose and no bounded retry to run out of.
      { surface: "public", method: "get", statuses: ["200", "400", "401"] },
    ];

    for (const { surface, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${log} on the ${surface} server`;
      const route = documents[surface].paths[log]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        // "Default Response" is what an undeclared response reads as, so this is the line
        // that tells a described status from a status the plugin invented a sentence for.
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        assert.ok(Object.hasOwn(answered, "content"), `${where} ${status}`);
      }
      assert.ok(route.tags !== undefined && route.tags.length > 0, `${where} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    // Tagged as their own group on each page, and there is no publish route on the Public
    // server for a reader to look for: a User with a Token is not the Shared Agent.
    assert.deepEqual(tagsOf(documents.agent, log, "post"), ["Decisions"]);
    assert.deepEqual(tagsOf(documents.public, log, "get"), ["Decisions"]);
    assert.equal(documents.public.paths[log]?.post, undefined);

    // Neither read has a parameter naming a User, on either surface, which is the whole
    // difference from the Message log's pair and the sentence saying so.
    for (const surface of ["agent", "public"] as const) {
      assert.deepEqual(
        parametersOf(documents[surface], log, "get")
          .map((parameter) => parameter.name)
          .sort(),
        ["after", "before", "limit"],
        surface,
      );
      const reading = String(documents[surface].paths[log]?.get?.description);
      assert.match(reading, /\*\*One global log, the same for every reader\.\*\*/, surface);
      // The cursor rules, in the shared words, because a client written against one of these
      // two reads pages the other identically (ADR-0035).
      assert.match(reading, /\*\*Three cursor cases, one order\.\*\*/, surface);
      assert.match(reading, /All three answer \*\*ascending by `seq`\*\*/, surface);
    }

    // The record, and the two sentences on it that a document is the only place to put: what
    // `jws` is and how to check it without us, and that a gap in `seq` means nothing.
    const fields = ["createdAt", "jws", "seq", "statement"];
    const record = schemaOf(documents.agent, log, "post", "201");
    assert.deepEqual(Object.keys(record.properties ?? {}).sort(), fields);
    assert.deepEqual([...(record.required ?? [])].sort(), fields);
    assert.match(String(record.properties?.jws?.description), /compact JWS/);
    assert.match(String(record.properties?.seq?.description), /Gaps are expected/);
    assert.equal(record.properties?.statement?.description, undefined);

    // And the sentence the whole feature turns on, on the read a Party actually meets: the
    // offline path named first, and what a signature does not prove said outright, because a
    // reader who over-reads it has been misled by us (ADR-0041).
    const takingItAway = String(documents.public.paths[log]?.get?.description);
    assert.match(takingItAway, /verifiable by any off-the-shelf JOSE library/);
    assert.match(takingItAway, /nothing whatever about how the agent behaved/);
  });

  it("says what Signatures' three routes answer with, and what each of them is worth", async () => {
    // The fourth part across both surfaces, and the one whose three routes are three different
    // relationships with the same key: only the agent may sign, anybody with a Token may ask,
    // and anybody at all may take the key and stop asking (ADR-0042).
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const answers: readonly {
      readonly surface: keyof typeof documents;
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      // No 401 on the signing, the Agent server having no authentication at all, and no 401
      // on the key set, a public key being public. The one route between them has one.
      { surface: "agent", path: "/sign", method: "post", statuses: ["200", "400"] },
      { surface: "public", path: "/verify", method: "post", statuses: ["200", "400", "401"] },
      { surface: "public", path: "/jwks.json", method: "get", statuses: ["200", "400"] },
    ];

    for (const { surface, path, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${path} on the ${surface} server`;
      const route = documents[surface].paths[path]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        // "Default Response" is what an undeclared response reads as, so this is the line
        // that tells a described status from a status the plugin invented a sentence for.
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        assert.ok(Object.hasOwn(answered, "content"), `${where} ${status}`);
      }
      assert.deepEqual(route.tags, ["Signatures"], where);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    // Neither server describes the other's, which on this part is the sharpest version of that
    // separation anywhere: a `POST /sign` in the Public server's document would be advertising
    // the Shared Agent's key to whoever can reach the port.
    assert.equal(documents.public.paths["/sign"], undefined);
    assert.equal(documents.agent.paths["/verify"], undefined);
    assert.equal(documents.agent.paths["/jwks.json"], undefined);

    // **`typ` described as what it is**, which is the one thing about this part a reader can
    // get wrong in the direction that matters: the freedom said outright on the request, and
    // the consequence of that freedom said outright on the answer (ADR-0042).
    const signing = bodyOf(documents.agent, "/sign", "post");
    assert.deepEqual(Object.keys(signing.properties ?? {}).sort(), ["statement", "typ"]);
    assert.deepEqual(signing.required, ["statement"]);
    assert.match(String(signing.properties?.typ?.description), /Any label, `saf-decision\+jws`/);
    assert.match(String(documents.agent.paths["/sign"]?.post?.description), /nothing is reserved/);
    const verdict = schemaOf(documents.public, "/verify", "post", "200");
    assert.deepEqual(Object.keys(verdict.properties ?? {}).sort(), [
      "header",
      "payload",
      "verified",
    ]);
    // Only the verdict is promised, because only the verdict is answered when it is `false`.
    assert.deepEqual(verdict.required, ["verified"]);
    assert.match(
      String(verdict.properties?.header?.description),
      /not a guarantee of this framework's/,
    );
    // `header` and `payload` are **empty schemas**, which is what passes the artifact's own
    // JSON through byte intact: a `type` here would be this route having an opinion about what
    // the agent signs, which it does not have anywhere else.
    assert.equal(verdict.properties?.header?.type, undefined);
    assert.equal(verdict.properties?.payload?.type, undefined);

    // And what the check is worth, said where somebody about to rely on it will read it: it
    // proves less than it looks like it proves, and the offline path is named beside it.
    const check = String(documents.public.paths["/verify"]?.post?.description);
    assert.match(check, /\*\*it proves less than it looks like it proves\*\*/);
    assert.match(check, /\*\*Real verification is offline\.\*\*/);
    assert.match(check, /\*\*Requires a bearer Token\*\*/);
    // The 401 in the User Manager's own words with where the hook came from added, which is
    // how Decisions describes the same refusal: this part holds no scheme of its own, and a
    // client should not have to discover that to know the answer is identical there.
    const unauthenticated = String(
      documents.public.paths["/verify"]?.post?.responses["401"]?.description,
    );
    assert.match(unauthenticated, /Authentication failed/);
    assert.match(unauthenticated, /the same 401 the routes under `\/auth` answer/);

    const route = documents.public.paths["/jwks.json"]?.get;
    assert.ok(route !== undefined, "the key set should be described");
    assert.match(String(route.description), /No Token is required/);
    assert.match(String(route.description), /without trusting this Gateway/);

    // The JWK as it is described, which is a **positive list of public members**: the schema
    // is the second of the two things standing between a wrong key argument and the private
    // scalar reaching an unauthenticated route, and a `d` here would undo it silently.
    const keySet = schemaOf(documents.public, "/jwks.json", "get", "200");
    const key = keySet.properties?.keys?.items;
    assert.ok(key !== undefined, "the key set should describe what a key looks like");
    assert.deepEqual(Object.keys(key.properties ?? {}).sort(), ["crv", "e", "kty", "n", "x", "y"]);
    assert.deepEqual(key.required, ["kty"]);
    // Neither in the schema nor anywhere else in either document, since a member named at all
    // is a member the serializer would let through.
    for (const [surface, served] of Object.entries(documents)) {
      assert.equal(JSON.stringify(served).includes('"d"'), false, surface);
    }
  });

  it("serves a browsable page on both, at a path neither can be moved off", async () => {
    for (const server of [described.components.agentServer, described.components.publicServer]) {
      const page = await server.fastify.inject({ method: "GET", url: "/docs" });
      assert.equal(page.statusCode, 200);
      assert.match(String(page.headers["content-type"]), /text\/html/);
    }
  });

  it("puts a route registered after the constructor returned into that server's document", async () => {
    // The single most breakable thing in the change, and the reason this test exists: the
    // description plugin is registered ahead of every part, so an Operator's own routes are
    // discovered along with the framework's. Register it after the parts and this fails
    // with an empty document, which is the only symptom there is (ADR-0040).
    const { agentServer, publicServer } = unstarted().components;

    // Both spellings, in the stretch an Operator writes them in: nothing is awaited between
    // the constructor and these two lines, which is what makes the difference between them
    // observable at all.
    //
    // Through `register`, which is the door ADR-0032 already points at and the one the
    // quickstart names first. The plugin's body runs at boot, by which time the description
    // plugin has added its `onRoute` hook, so this route is discovered.
    publicServer.fastify.register(async (fastify) => {
      fastify.get("/ask", async () => ({ ok: true }));
    });

    // And straight onto the instance, which is the other spelling and is **not**. Fastify
    // fires `onRoute` synchronously as a route is declared, and here that is before
    // anything has booted, so the hook this route would have been seen by does not exist
    // yet. Pinned rather than left to be discovered: it is a Fastify fact and not a choice
    // of ours, the failure it produces is a route missing from a document with no error
    // anywhere, and the day it stops being true this line is where somebody finds out.
    publicServer.fastify.get("/quietly", async () => ({ ok: true }));

    await agentServer.fastify.ready();
    await publicServer.fastify.ready();
    try {
      const theirs = await documentOf(publicServer.fastify);
      assert.deepEqual(Object.keys(theirs.paths).sort(), [...publicPaths, "/ask"].sort());
      // Served all the same, which is what makes its absence above worth a line: the route
      // works and only the description is missing it.
      assert.equal((await publicServer.fastify.inject("/quietly")).statusCode, 200);

      // On that server and not the other, since the two documents are two plugin instances.
      assert.deepEqual(
        Object.keys((await documentOf(agentServer.fastify)).paths).sort(),
        agentPaths,
      );
    } finally {
      await agentServer.fastify.close();
      await publicServer.fastify.close();
    }
  });

  it("declares the version the package is at", () => {
    // A hand-maintained constant with no reader is the thing that drifts, and this is its
    // reader. Reading the manifest here rather than in the constructor is the whole of the
    // trade ADR-0040 makes: the cost of the constant is paid by a test rather than by a
    // file read inside a constructor documented as doing no I/O.
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.equal(describedVersion, (manifest as { version?: string }).version);
  });

  /**
   * A whole assembly, constructed and left alone: no pool opened, no port bound and no
   * Handler that could do anything if one were.
   *
   * Called twice: once for the pair every test below reads, and once by the test that
   * needs a Gateway of its own, since a route has to be registered before the instance
   * boots and the shared pair booted in `before`.
   */
  function unstarted(): Gateway<DefaultComponents> {
    return createGatewayWithDefaults({
      databaseUrl: nowhere,
      runtime,
      signingKey,
      tokenTtl: hour,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      handlers: () => ({}),
    });
  }

  /** One server's document, fetched the way a consumer fetches it. */
  async function documentOf(fastify: FastifyInstance): Promise<Description> {
    const answered = await fastify.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(answered.statusCode, 200);
    return answered.json<Description>();
  }

  /** One operation's tags, asserted on rather than reached through an optional chain. */
  function tagsOf(document: Description, path: string, method: Method): readonly string[] {
    const tags = document.paths[path]?.[method]?.tags;
    assert.ok(tags !== undefined, `${method} ${path} should be tagged`);
    return tags;
  }

  /**
   * The JSON schema one status of one operation is described by.
   *
   * Read out of the served document rather than off the schema object the route was
   * declared with, because the document is the only part of this a consumer ever sees:
   * anything the plugin drops on the way out is dropped from the answer here too.
   */
  function schemaOf(document: Description, path: string, method: Method, status: string): Schema {
    const schema =
      document.paths[path]?.[method]?.responses[status]?.content?.["application/json"]?.schema;
    assert.ok(schema !== undefined, `${method} ${path} should describe a ${status} body`);
    return schema;
  }

  /** The JSON schema of one operation's request body, read the same way and for the same reason. */
  function bodyOf(document: Description, path: string, method: Method): Schema {
    const schema =
      document.paths[path]?.[method]?.requestBody?.content?.["application/json"]?.schema;
    assert.ok(schema !== undefined, `${method} ${path} should describe a body`);
    return schema;
  }

  /**
   * One operation's query parameters, which is where a `querystring` schema's properties
   * end up: a parameter absent from this list is one a client has no way to know exists.
   */
  function parametersOf(document: Description, path: string, method: Method): readonly Parameter[] {
    const parameters = document.paths[path]?.[method]?.parameters;
    assert.ok(parameters !== undefined, `${method} ${path} should describe its parameters`);
    return parameters;
  }
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
      signingKey,
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
          signingKey,
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
 * The two calls an OIDC callback makes, and the reason every test here but one needs no
 * password: `create` takes none and derives nothing, `issueToken` mints a Token for
 * somebody who presented nothing, and what comes back is indistinguishable from a Token a
 * login bought (ADR-0030). The defaults constructor exposes no `scrypt` option, so the
 * alternative would be two derivations at OWASP's 32 MiB cost for nothing most of this
 * file asserts. The one test that does assert something about them buys its own.
 */
async function admitted(): Promise<{ id: string; token: string }> {
  const user: UserRecord = await components.db.tx((tx) => components.users.create(tx));
  const issued = await components.db.tx((tx) => components.users.issueToken(tx, user.id));
  return { id: user.id, token: issued.token };
}

/**
 * One read of the Agent server, over its own socket and with nothing to authenticate
 * with, which is the whole of what reaching that port takes (ADR-0010).
 */
async function agentJson<T>(path: string): Promise<T> {
  const response = await fetch(`${agentUrl}${path}`);
  // The body is read once and parsed here, so a failure names what came back: a response
  // consumed by the assertion's own message would leave nothing to parse.
  const body = await response.text();
  assert.equal(response.status, 200, `${path} should have answered: ${body}`);
  return JSON.parse(body);
}

/** One segment of a compact JWS as the JSON it is, decoded from the string that was emitted. */
function decoded(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/** One `POST /messages` on the Public server, by the User the Token names. */
function postMessage(text: string): Promise<Response> {
  return postJson(`${publicUrl}/messages`, { text }, client.token);
}

/**
 * One outbound Message written through the part's own method, which is what a Signal
 * Handler calls and the half of a round trip that never touches a wire.
 */
function sending(userId: string, text: string): Promise<MessageRecord> {
  return components.db.tx((tx) => components.messenger.send(tx, userId, text));
}

/**
 * One User's own Message log over the Public server, by their Token and with no parameter
 * naming them: the whole difference from the agent's read of the same query.
 */
async function ownLog(token: string, window: string): Promise<{ messages: MessageRecord[] }> {
  const response = await bearing(`${publicUrl}/messages${window}`, token);
  const body = await response.text();
  assert.equal(response.status, 200, `GET /messages${window} should have answered: ${body}`);
  return JSON.parse(body);
}

/** One page of that log as its texts, which is how the three cursor cases are read. */
async function ownTexts(token: string, window: string): Promise<string[]> {
  const page = await ownLog(token, window);
  return page.messages.map((message) => message.text);
}

/** One GET on the Public server, with the Token the one User holds. */
function authenticated(url: string): Promise<Response> {
  return bearing(url, client.token);
}

/** One GET with a Token presented, which is how anything reaches a Public route at all. */
function bearing(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
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
