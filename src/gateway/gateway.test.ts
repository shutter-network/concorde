/**
 * A whole deployment from one call, and the two things that call exists to settle.
 *
 * `components.test.ts` owns the ordering contract and proves it with mocks: key order out,
 * reverse order back, unwind on a failed start. What it cannot say is that the real parts *fit*
 * that record, or that the order they go in is the right one. This file is the other half. Every
 * part here is real — real PostgreSQL, two real Fastify instances on real sockets, a real started
 * Signal Worker, the real Users component and the real HTTP Channel — and the Runtime is the
 * one thing faked, as everywhere else.
 *
 * The infrastructure comes from `createGateway`; the four opinionated parts are built by hand in
 * `extend`, exactly as an example's `main.ts` builds them, so the fixture is a mirror of a real
 * deployment. What the framework still settles is the key order:
 *
 *     db -> agentServer -> publicServer -> <extend's parts> -> worker
 *
 * comes from one rule. **The Signal Worker's `stop` is the only stop that does work.** Every other
 * one releases something; the worker's waits for the Run in flight and never cancels it,
 * and that Run reads the Db, calls the Agent server and reaches the Messenger through
 * a Signal Handler's post phase. So the drain goes first, while everything it uses is still up —
 * which is why the Worker is keyed **last** even though it is constructed early.
 *
 * That is what the last test asserts, and it is the assertion `src/pi/container.test.ts`
 * says it does not make: a Run is parked in flight, `stop` is called around it, and the Run
 * then reports what it can still reach. Nothing is inspected from the side — the report
 * comes back from inside the Run itself, which is the only vantage point from which "still
 * up during the drain" is a fact rather than a guess. The Operator's own Component is in
 * that report too, and it says **still running**: whatever `extend` returns is keyed ahead of
 * the Worker now, so it stops *after* the drain rather than before it.
 *
 * The other thing settled here is the **construction cycle**. The worker takes its Handler
 * map at construction, the Messenger takes the worker, and the Handler's post phase sends a
 * Message through the Messenger. The Handler below is that cycle: it reaches the Messenger,
 * the Db and a Component that `extend` returned, all three of which are constructed after
 * the worker that will dispatch to it.
 *
 * A third claim shares the first suite without being about the assembly at all, and it is here
 * because there is nowhere cheaper: **what a part recorded and what the wire carries are the same
 * record**. A response schema is a serializer, so a field the schema does not declare is dropped
 * from the answer without a word, and catching that needs a record produced in this process and
 * read back over a socket. Every other body comparison in this repository compares one HTTP
 * response against another, where a uniformly stripped field is stripped on both sides and passes.
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
 * module is what put it at risk: `createGateway` reaches the Db, the servers and the Signal
 * Worker, and constructing a Runtime would be the obvious next convenience. It reads no database
 * and starts nothing — it walks the import graph from `src/index.ts` and asserts the one edge
 * worth keeping absent, an Agent Implementation, is *not* in it, and that the four parts are not
 * either now that they are the Operator's.
 *
 * **One password is in this file, and one only.** This fixture builds Users with no
 * `scrypt` option, so every derivation here is at OWASP's 32 MiB cost, and the User this
 * suite is otherwise built around is admitted and handed a Token from trusted code
 * instead, which is the same two calls an OIDC callback makes, so that four
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
import type { Db } from "../db/index.ts";
import { createDecisions, type DecisionRecord, type Decisions } from "../decisions/index.ts";
import * as decisionsSchema from "../decisions/schema/index.ts";
import { createHttpChannel, type HttpChannel } from "../http-channel/index.ts";
import type { Logger } from "../logging/logging.ts";
import {
  createMessenger,
  type MessageRecord,
  type Messenger,
  messageReceivedKind,
} from "../messenger/index.ts";
import * as messengerSchema from "../messenger/schema/index.ts";
import { createPasswordAuth, type IssuedToken, type PasswordAuth } from "../password-auth/index.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import {
  createScheduler,
  type ScheduleFiredRecord,
  type ScheduleRecord,
  type Scheduler,
  scheduleFiredKind,
} from "../scheduler/index.ts";
import * as schedulerSchema from "../scheduler/schema/index.ts";
import type { RunRecord, SignalHandler, SignalRecord } from "../signals/index.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignatures, type Signatures } from "../signatures/index.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";
import { createUsers, type UserRecord, type Users } from "../users/index.ts";
import * as usersSchema from "../users/schema/index.ts";
import type { Component, Gateway } from "./components.ts";
import { createGateway, describedVersion, type InfraComponents } from "./gateway.ts";

const hour = 60 * 60 * 1000;

/** A started worker writes many lines, and none of them is this file's subject. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Somewhere nobody is, for the one call that is supposed to be refused. */
const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

/**
 * The shared agent's identity for the duration of this file, generated here because this is
 * where a keypair may be generated: the framework generates none, and `signingKey` is required
 * of every deployment including one that publishes nothing.
 */
const { privateKey: signingKey } = generateKeyPairSync("ed25519");

/**
 * What `createGateway` builds and hands `extend`: the infrastructure every deployment has, in
 * the order it keys it. **The Worker is in this record but keyed last in the returned Gateway**,
 * so this is what `extend` receives rather than the start order.
 */
const theInfra = ["db", "agentServer", "publicServer", "worker"];

/**
 * What this deployment's Gateway consists of, in the order it starts and the reverse of the order
 * it stops, written once because more than one test is about exactly this list.
 *
 * The parts are `extend`'s now, so they are keyed between the servers and the Worker — the Worker
 * keyed **last** so the drain runs while they are all still live. Users is
 * before the HTTP Channel, a foreign-key ordering the Operator owns and can get wrong loudly;
 * Signatures and Decisions sit between them and the Messenger, ahead of the Worker, so
 * a post phase that publishes on the way out reaches them inside the drain. The
 * **Scheduler** is keyed ahead of the Worker too, exactly like the HTTP Channel and every other
 * `extend` part: it is the second Producer, but a Producer built in `extend` stops *after* the
 * drain, so its `stop` cancels the firing timer once the Worker has already drained, and a fire
 * that lands during the drain is a pending Signal the next boot handles — the residual accepted
 * rather than leaving `extend` for `createBareGateway` to stop it first. `notes` is the
 * Operator's own Component, keyed last of the extension.
 */
const theRecord = [
  "db",
  "agentServer",
  "publicServer",
  "users",
  "passwordAuth",
  "signatures",
  "decisions",
  "messenger",
  "httpChannel",
  "scheduler",
  "notes",
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

/**
 * The parts an Operator builds in `extend`, which is the full stack: the four opinionated ones and
 * the Scheduler, the second Producer, opted in and wired the same way.
 */
type Stack = {
  readonly users: Users;
  readonly passwordAuth: PasswordAuth;
  readonly signatures: Signatures;
  readonly decisions: Decisions;
  readonly messenger: Messenger;
  readonly httpChannel: HttpChannel;
  readonly scheduler: Scheduler;
};

/**
 * The four parts, built by hand from the infrastructure `createGateway` hands `extend`, exactly
 * as an example's `main.ts` does it — which is what makes this fixture a mirror of a real
 * deployment. Users is constructed **before** the HTTP Channel, which
 * takes it; Signatures before Decisions, which holds it and signs through it in process.
 * Neither order is a migration order any more: `messages.user_id`'s foreign key
 * onto `concorde_users.users.id` is generated from one push that sees both schemas, and the
 * statements inside it are ordered by `drizzle-kit`. The order the framework used
 * to hide is on display here, which is the whole point of the parts being the Operator's now.
 */
function fullStack({ db, agentServer, publicServer, worker }: InfraComponents): Stack {
  const users = createUsers({ db, agentServer, publicServer });
  // The one scheme this deployment accepts. It registers itself with the Public server inside
  // its own constructor, which is what makes `publicServer.requireUser` able to authenticate
  // anybody: every other part here takes that hook and holds no credential.
  const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl: hour });
  const signatures = createSignatures({ signingKey, agentServer, publicServer, logger: silent });
  const decisions = createDecisions({ db, signatures, agentServer, publicServer });
  const messenger = createMessenger({ db, users, worker, agentServer });
  const httpChannel = createHttpChannel({ db, messenger, publicServer });
  // The Scheduler, given the Agent server so its routes register and are discovered by the
  // description plugin the constructor put on ahead of `extend` — the seam this file's document
  // suite reads them out of. It imposes no construction-order constraint of
  // its own: a Schedule references nobody.
  const scheduler = createScheduler({ db, worker, agentServer, logger: silent });
  return { users, passwordAuth, signatures, decisions, messenger, httpChannel, scheduler };
}

/** Which callback ran when, since "`extend` before `handlers`" is a claim about order. */
const callbacks: string[] = [];

/**
 * The awkward JSON both round trips carry, and the reason either of them nests anything.
 *
 * A Signal's `payload` and a User's `attributes` are both declared with an **empty schema**,
 * precisely so that arbitrary JSON survives serialization byte intact, and a flat object of strings
 * would not have shown it: a list of mixed types, a null inside it and an object below that are
 * what a schema with an opinion would flatten or drop.
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
 * There is no trusted-code method that writes an inbound Message and that is deliberate,
 * so the Public submission route is the only way a log has both directions in
 * it, and that is what makes the numbering worth reading back at all.
 */
const roundTripSubmission = "and one from me, while everything is still up";

/** A Handler whose only job is to produce one Run for the round trip to read. */
const roundTripping: SignalHandler<{ readonly text: string }> = {
  handle: (signal) => [{ session: roundTripSession, text: signal.payload.text }],
};

/**
 * A Handler for the Scheduler's fixed `kind`, written `SignalHandler<ScheduleFiredRecord>` the way
 * an Operator writes it — the reason the record type is exported.
 *
 * Nothing in this file makes a Schedule mature: the round trip below arms a `once` far in the
 * future so the read model is what is under test, not a fire. It is registered anyway because the
 * Scheduler is a Producer in this fixture, and registering no Handler for its `kind` would leave a
 * matured Schedule a permanently failed Signal.
 */
const scheduleFiring: SignalHandler<ScheduleFiredRecord> = {
  handle: (signal) => [{ session: `schedule_${signal.payload.scheduleName}`, text: "fired" }],
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
 * inside the drain.
 */
const decidedOnTheWayOut = "the March rollout is off, decided while the Gateway was stopping";

/** The whole record this file's shared Gateway holds: the infrastructure, the four parts, and
 * the Operator's own notebook. */
type Full = InfraComponents & Stack & { notes: Notebook };

let database: TestDatabase;
let gateway: Gateway<Full>;
let components: Full;

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
 * which is the last thing the drain does and the one that reaches the Messenger.
 *
 * One Prompt parks and every other Run is ordinary, which is what lets the round-trip
 * assertions have a finished Run to read: the worker is serial globally, so a
 * Run parked before them would be a Gateway that never got to them at all.
 */
const runtime = fakeRuntime(async (prompt) => {
  if (prompt.text !== inFlightAtShutdown) return { ok: true };
  await shuttingDown.promise;
  duringTheDrain.push(...(await whatIsStillUp()));
  return { ok: false, error: "this Run exists to be in flight while the Gateway shuts down" };
});

before(async () => {
  database = await createTestDatabase("gateway");

  // The infrastructure from one call, and the four parts built by hand in `extend` — the whole
  // stack, and the construction order and wiring the Operator now owns and can see.
  // Only the Worker's key position and the description-before-`extend` registration are the
  // framework's, and neither is expressible wrongly on this path.
  gateway = createGateway({
    databaseUrl: database.url,
    runtime,
    // Port 0 on both, because two suites must be able to run at once and neither address is
    // asserted on. Where they actually landed is read back off the instances after `start`.
    agentListen: { port: 0, host: "127.0.0.1" },
    publicListen: { port: 0, host: "127.0.0.1" },
    extend: (infra) => {
      callbacks.push("extend");
      // Given the four infrastructure Components, and *not* the handlers: a Component that needed
      // a Handler would be a Component that wanted to be a Signal Worker.
      assert.deepEqual(Object.keys(infra), theInfra);
      // The four parts, plus the Operator's own notebook keyed last of them: this is a mirror of
      // an example's `main.ts` with one Component added, which is what proves `extend` reaches the
      // infrastructure and returns Components of its own.
      return { ...fullStack(infra), notes: notebook() };
    },
    handlers: (all) => {
      callbacks.push("handlers");
      // Given the four *and* the extension, which is the direction that makes a Handler able
      // to use an Operator's own Component.
      return {
        [messageReceivedKind]: answering(all),
        [roundTripKind]: roundTripping,
        [scheduleFiredKind]: scheduleFiring,
      };
    },
    logger: silent,
  });
  components = gateway.components;

  // Every schema this deployment runs, pushed as one graph, which is exactly the list an
  // Operator writes and points their own `drizzle-kit` at. The framework applies
  // nothing itself, so this is the whole of how the tables get here, and `messages.user_id`
  // is a live foreign key onto `concorde_users.users.id` because both schemas are in the same
  // push rather than because two folders were ordered.
  await applySchema(
    components.db,
    signalsSchema,
    usersSchema,
    passwordAuthSchema,
    decisionsSchema,
    messengerSchema,
    schedulerSchema,
  );

  await gateway.start();
  agentUrl = components.agentServer.fastify.listeningOrigin;
  publicUrl = components.publicServer.fastify.listeningOrigin;

  client = await admitted();
});

after(async () => {
  // Stopped here as well as by the last test, because the Db the record holds is what has to
  // be closed before the database can be dropped: a test that never reached `stop` would
  // otherwise leave a pool open and fail the drop with PostgreSQL's "is being accessed by
  // other users", which is the wrong failure to read. A second `stop` finds nothing to do.
  await gateway?.stop();
  await database.drop();
});

/**
 * An example deployment's Handler, shortened to what this file is about: one Prompt per
 * Message, a note in the Operator's own Component, a failure notice sent from the post phase,
 * and the Decision that failure was reached about published from the same phase.
 *
 * A factory taking every Component, because that is what `handlers` is handed. Everything
 * it reaches (the Db, the Messenger, Decisions, the notebook) is constructed *after* the
 * Signal Worker that will dispatch to it, which is the cycle `createGateway` exists to break —
 * even though the Messenger and Decisions are now the Operator's, built in `extend`, the worker
 * is still constructed with an empty map and the map filled by `handlers` afterwards.
 *
 * The publish is why Decisions is keyed **ahead of** the Signal Worker: a post phase runs after
 * the Runs arising from a Signal have finished, which during shutdown is inside the drain, and
 * a Decision reached by a failing Run should still be recorded.
 *
 * What makes it *work* today is narrower than that, and worth saying rather than letting a
 * reader infer the stronger claim: the insert goes through the Db's handle, and the Db is keyed
 * first and therefore stopped last. Decisions' own `stop` does nothing, so moving its key
 * behind the worker's would leave this line passing and only the pinned order in `theRecord`
 * would report it. The position is the HTTP Channel's anticipatory one, held for the day
 * either part's `stop` starts releasing something.
 */
function answering(all: Full): SignalHandler<MessageRecord> {
  return {
    handle(signal) {
      all.notes.lines.push(signal.payload.text);
      return [{ session: `user_${signal.payload.userId}`, text: signal.payload.text }];
    },
    async post(signal, outcome) {
      if (!outcome.failed) return;
      duringTheDrain.push(
        await reaching("the HTTP Channel sent a Message", async () => {
          const sent = await all.db.tx((tx) =>
            all.messenger.send(tx, signal.payload.userId, "Something went wrong."),
          );
          return sent.direction;
        }),
      );
      duringTheDrain.push(
        await reaching("Decisions published a Decision", async () => {
          // In a transaction of the Handler's own, which is the shape the trusted method
          // exists for, and read straight back through the other one, which is the
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
  it("holds the infrastructure and the extension, in the start order, with the Worker keyed last", () => {
    // The keys are the start order, and they are the order the drain needs. That they are
    // *acted on* in this order is `components.test.ts`'s claim; that these are what this
    // deployment consists of, and in this order, is this one — the infrastructure the framework
    // keyed and the four parts `extend` built, with the Worker keyed **last** so it stops first.
    assert.deepEqual(Object.keys(components), theRecord);
  });

  it("runs extend before handlers, so a Handler can reach a Component extend returned", () => {
    assert.deepEqual(callbacks, ["extend", "handlers"]);
    // And the Component is started, in its position ahead of the Worker. Nothing has been written
    // into it: the notebook is a Handler's to fill, and the drain test below is what makes a
    // Handler run at all.
    assert.equal(components.notes.running, true);
    assert.deepEqual(components.notes.lines, []);
  });

  it("wired every part to every other, which is nine route groups on two servers", async () => {
    // One read per group, chosen so that nothing here derives a password: the two plugins of
    // Users, Password Auth's, the Signal Worker's, the Messenger's pair, Decisions' pair and
    // Signatures' pair. A group that was never registered answers 404, and so does one
    // registered on the other server.
    assert.equal((await fetch(`${agentUrl}/users`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/signals`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/messages?user=${client.id}`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/decisions`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/users/me`)).status, 200);
    // Password Auth's group, read by presenting a password nobody holds: a 401 is the login
    // route answering, where a group nobody registered would be a 404. Nothing is admitted and
    // no Token is dropped, so the counts the round trips below assert on do not move.
    assert.equal(
      (await postJson(`${publicUrl}/auth/tokens`, { user: nobody, password: "not anybody's" }))
        .status,
      401,
    );
    assert.equal((await authenticated(`${publicUrl}/messages`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/decisions`)).status, 200);
    // And Signatures' two, whose one read is the only route on the Public server that takes no
    // Token besides the login: a public key is public. The other two are POSTs and
    // are exercised in full further down; here they are one 400 each, which is a group that
    // registered rather than the 404 of one that did not.
    assert.equal((await fetch(`${publicUrl}/jwks.json`)).status, 200);
    assert.equal((await postJson(`${agentUrl}/sign`, {})).status, 400);
    assert.equal((await postJson(`${publicUrl}/verify`, {}, client.token)).status, 400);
  });

  it("has the Messenger's foreign key onto the Users table, and it is enforced", async () => {
    // The constraint is declared in `messenger/schema.ts` and generated by the push in
    // `before`, so nothing hand-wrote it and nothing scanned a folder for it.
    // What is asserted is that it is *there and enforced*: a Message addressed to a
    // well-formed uuid naming no User is refused rather than stored. `UnknownUserError` is
    // PostgreSQL's `23503` named — the constraint refusing, surfaced as a throw for trusted
    // code and as the agent's 404 on the route.
    //
    // Without the foreign key this row inserts happily and the call resolves, so the
    // rejection is the constraint and could be nothing else.
    await assert.rejects(
      () => components.db.tx((tx) => components.messenger.send(tx, nobody, "nobody reads this")),
      { name: "UnknownUserError" },
    );
  });

  it("starts and stops the idle parts with nothing to run, and no call does a thing", async () => {
    // Started once already, by `start` above, and started again here — which is safe for
    // precisely the reason `worker.start` refuses a second call and these do not: there is
    // nothing running to run twice.
    for (const idle of [
      components.users,
      components.passwordAuth,
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
    // it, and one `GET /messages` needs the Public server, `requireUser`, the
    // Messenger's own plugin and the Db, all four of them. Decisions' Public read
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
    // warns about none of it. So a field added to `SignalRecord` and forgotten
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

  it("answers a User and an issued Token as Users recorded them, and drops nothing", async () => {
    // The same hazard the Signal round trip above is about, on the one record where it
    // cuts both ways. A field dropped from a `UserRecord` is an answer quietly missing
    // something; a field *added* to the schema is the password hash on a wire it is
    // never meant to reach. So the shape is asserted whole in both directions: against a
    // record this process holds, and against the bytes that came back.
    const created = await components.db.tx(async (tx) => {
      const user = await components.users.create(tx);
      await components.users.setAttributes(tx, user.id, roundTripAttributes);
      await components.passwordAuth.setPassword(tx, user.id, theOnePassword);
      return user;
    });
    // Read back through the part's own method rather than reusing what `create` answered,
    // since the Attributes and the password were written after it: this is the record the Users
    // component holds, and it is what the wire is compared against.
    const recorded = await components.users.get(created.id);
    assert.ok(recorded !== undefined, "the User this test just created should be readable");

    const read = await agentJson<UserRecord>(`/users/${created.id}`);
    assert.deepEqual(read, {
      id: created.id,
      // Byte intact, nesting and nulls and all, which is what the empty schema on
      // `attributes` is for: the Gateway never interpreted these and the wire does not
      // start.
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
    const minted = await components.db.tx((tx) =>
      components.passwordAuth.issueToken(tx, created.id),
    );
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
    const presented = await fetch(`${publicUrl}/users/me`, {
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
      ["GET /users/me", presentedBody],
    ] as const) {
      assert.equal(/password|scrypt/i.test(body), false, `${what} carried a credential: ${body}`);
    }

    // And the three routes that answer nothing still answer nothing. A response schema is
    // a serializer, so a 204 declared as a body is a route that answers 500 at
    // serialization time; `type: "null"` is what keeps these empty and what keeps the
    // document from promising a body nobody sends. Ordered so that each has a
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

  it("answers a Message log as the HTTP Channel recorded it, and pages it three ways", async () => {
    // A User of this test's own, because `seq` is per User and every number below is an
    // assertion: the User the rest of the file shares has a Message posted into their log by
    // the drain test underneath this one.
    const reader = await admitted();

    // Four Messages in one log and in both directions, written the only two ways a Message
    // can be. `send` is the part's own method, which is what a Signal Handler calls and what
    // the agent's route reaches; the Public submission is the only way an inbound Message
    // exists at all, since there is deliberately no method that writes one.
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
    // of. One numbered sequence across both directions is the whole of the design,
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
    // ascending. No cursor is the **newest** page and not the oldest, which is the
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
    // declare is a log of Decisions nobody can verify, answered with a 200.
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

    // And the same record cited by its number, which is how a User fetches the one somebody
    // quoted at them: the route is a citation rather than a cursor query, and it answers from
    // the read above rather than from a query of its own.
    const numbered = await bearing(`${publicUrl}/decisions/${decision.seq}`, client.token);
    const numberedBody = await numbered.text();
    assert.equal(numbered.status, 200, numberedBody);
    assert.deepEqual(JSON.parse(numberedBody), decisions[0]);

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
    // check of it.
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
    // authority exercised without a log row rather than a forgery. It is asserted
    // against the assembled Gateway rather than against Signatures alone because "nothing is
    // reserved" only means something where the real Decisions is sitting next door.
    const claimed = "a receipt for the March invoice, which is not a Decision";
    const signed = await postJson(`${agentUrl}/sign`, {
      statement: claimed,
      typ: "concorde-decision+jws",
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
    assert.deepEqual(decoded(header), { alg: "EdDSA", typ: "concorde-decision+jws" });
    assert.deepEqual(decoded(payload), { statement: claimed });

    // And the log does not have it, which is the sentence the freedom above costs: `typ` is
    // the agent's signed claim about its own artifact and not a promise that a row exists, so
    // only an artifact fetched from here is guaranteed to be one of these.
    const { decisions } = await agentJson<{ decisions: DecisionRecord[] }>("/decisions?after=0");
    assert.equal(
      decisions.some((published) => published.jws === jws),
      false,
      "signing must not have published anything",
    );

    // The lazy check, and the first half of what it costs: a Token, and the Public server's
    // single 401 without one. Compared body for body against another Public route's refusal,
    // because "the same 401" is the claim and this part authenticates nobody.
    //
    const refused = await fetch(`${publicUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jws }),
    });
    assert.equal(refused.status, 401);
    const elsewhere = await fetch(`${publicUrl}/users/me`);
    assert.equal(elsewhere.status, 401);
    assert.deepEqual(JSON.parse(await refused.text()), JSON.parse(await elsewhere.text()));

    // And with one, the verdict and what the artifact said. The independent side of this
    // comparison is the bytes above, which no response schema has been near, so a `header` or
    // a `payload` the serializer flattened disagrees with what was signed.
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

  it("answers a Schedule as the Scheduler recorded it, and drops nothing", async () => {
    // The same serializer hazard as the round trips above, on the Scheduler's read model: its
    // response schema is the serializer `fast-json-stringify` compiles, so a field added to
    // `ScheduleRecord` and forgotten in the route schema is dropped from the wire *and* the
    // document, and no comparison of one HTTP response against another can see it because a
    // uniformly stripped field is stripped on both sides. This is the assertion that
    // can: the record is produced through the part's own `schedule`, in this process, and the
    // whole body read back over HTTP is compared against a literal the type checker holds to
    // `ScheduleRecord`.
    //
    // A `once` far in the future, so it never matures and the read model is the subject rather
    // than a fire, carrying the awkward JSON the empty `data` schema is meant to pass through
    // byte intact.
    const at = "2999-01-01T00:00:00.000Z";
    const produced = await components.scheduler.schedule({
      name: "the-round-trip-schedule",
      spec: { kind: "once", at },
      data: awkwardJson,
    });
    assert.equal(produced.created, true, "the round-trip Schedule should be newly created");

    const expected = {
      name: "the-round-trip-schedule",
      spec: { kind: "once", at },
      // Byte intact, nesting and nulls and all, which is what the empty schema on `data` is for:
      // the Scheduler echoes it verbatim and the wire does not start.
      data: awkwardJson,
      // Null for a `once` and an unbounded cron, and a required field on the wire all the same.
      until: null,
      // A `once`'s sole occurrence is its instant, and it is still in the future, so it is both
      // the `spec.at` and the next fire.
      nextFireAt: at,
    } satisfies ScheduleRecord;

    // The part's own answer, which is the in-process side a dropped field cannot have gone
    // missing from — the `schedule` call answers with the same shape the routes serialise.
    assert.deepEqual(produced.schedule, expected);

    // Read back over the assembled Agent server, whole-body against the same literal: add a field
    // to `ScheduleRecord` and this file stops compiling; declare it nowhere in the route schema
    // and this comparison fails.
    const read = await agentJson<ScheduleRecord>("/schedules/the-round-trip-schedule");
    assert.deepEqual(read, expected);

    // And through the list route, a second response schema written separately: the same record in
    // its envelope, so a field declared in one schema and forgotten in the other differs here. It
    // is the only Schedule in this deployment, so the whole page is it.
    const listed = await agentJson<{ schedules: ScheduleRecord[] }>("/schedules");
    assert.deepEqual(listed.schedules, [expected]);
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
    // holding it was constructed before. Two lines and not one, because the round
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
    // submissions throughout, which is the trade the order takes — that Message is stored,
    // its Signal stays `pending`, and the next boot picks it up. The Operator's own Component
    // is the one line that says **still running**, because whatever `extend` returns is keyed
    // ahead of the Worker now and therefore stops *after* the drain, not before it.
    //
    // The last line is what a Decision reached by a failing Run costs and buys: a post phase
    // that commits to something on the way out gets a row and an artifact, because the insert
    // goes through the Db and the Db stops last. Which part of the order that
    // depends on is on `answering` above, and it is the Db's key rather than Decisions' own.
    assert.deepEqual(duringTheDrain, [
      "Users read the Db: 1 User",
      "the Agent server answered: 200",
      "the Public server took a submission: 201",
      "the Operator's own Component: still running",
      "the HTTP Channel sent a Message: outbound",
      "Decisions published a Decision: the same artifact",
    ]);

    // And afterwards, nothing. Both sockets are closed and the pool is ended, which is the
    // reverse order having run all the way to the end.
    await assert.rejects(() => fetch(`${agentUrl}/signals`));
    await assert.rejects(() => fetch(`${publicUrl}/messages`));
    await assert.rejects(() => components.users.list());
  });
});

describe("the infrastructure on its own", () => {
  // Constructed and never started, which is free: `openDb` connects lazily, a Fastify instance
  // that never listens holds nothing, and no `extend` means no part reaches a socket or a schema.
  // What these tests are about needs no database.

  it("is the four infrastructure Components and nothing else when no extend is passed", () => {
    // No `extend`, and no `signingKey`: a deployment that publishes nothing builds neither
    // Signatures nor Decisions and holds no key at all, which was once unexpressible —
    // the assembly required a key of every deployment — and is now the smallest possible Gateway.
    const bare = createGateway({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      handlers: () => ({}),
    });

    assert.deepEqual(Object.keys(bare.components), theInfra);

    // And the record still has its types, which is a claim about the type parameter's
    // **default** rather than about the object. With `extend` omitted there is nothing to
    // infer the extension from, and a type parameter with no inference candidates falls back
    // to its constraint — which carries `db?: never` and would reduce the whole intersection
    // to `never`. This line is what stops compiling if that default is ever dropped.
    const db: Db = bare.components.db;
    assert.equal(typeof db.handle, "function");
  });

  it("refuses to construct without a database, naming the option", () => {
    // Required, and read from no environment: there is no `DATABASE_URL` fallback to fall through
    // to any more, so the framework reads nothing. The throw is the constructor's own
    // and happens before `openDb`, which is lazy, so an Operator who omits it — a JavaScript
    // caller, since the type forbids it — is told which option to pass rather than watching `pg`
    // open a pool against its own defaults and fail on the first statement of the first Run.
    assert.throws(
      () =>
        // @ts-expect-error databaseUrl is required; omitting it is the case under test
        createGateway({
          runtime,
          agentListen: { port: 0, host: "127.0.0.1" },
          publicListen: { port: 0, host: "127.0.0.1" },
          handlers: () => ({}),
        }),
      /databaseUrl/,
    );
  });

  it("refuses an extend that returns one of the four infrastructure keys", () => {
    const substituting = createGateway({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // A JavaScript spread overwrites the value and keeps the original key's position, so
      // substituting an infrastructure Component in place would start the Operator's own where
      // ours would have gone and nothing anywhere would say so. The refusal is a type error, and
      // this is where it is pinned: `@ts-expect-error` fails the typecheck if the line below ever
      // starts compiling. An Operator who really wants a Worker of their own writes
      // `createBareGateway` by hand, which is the honest way to say it.
      // @ts-expect-error worker is an infrastructure key and may not be replaced by an extension
      extend: (infra) => ({ notes: notebook(), worker: infra.worker }),
      handlers: () => ({}),
    });

    // And it is refused *statically only*, which is the reason the type has to carry it: at
    // runtime the returned record is assembled with `worker` as the final key regardless, so the
    // Worker keeps the last position the framework gives it and `notes` sits ahead of it.
    assert.deepEqual(Object.keys(substituting.components), [
      "db",
      "agentServer",
      "publicServer",
      "notes",
      "worker",
    ]);
  });

  it("refuses an extend that returns any of the other three infrastructure keys", () => {
    // The remaining three, pinned separately, because the refusal comes from a mapped type over
    // `keyof InfraComponents` and a key added to that record without being added there would be
    // silently substitutable. The Db is the sharpest: an Operator's own under this key would open
    // where ours would have, and every part they built against it would use theirs instead.
    createGateway({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // @ts-expect-error db is an infrastructure key and may not be replaced by an extension
      extend: (infra) => ({ db: infra.db }),
      handlers: () => ({}),
    });
    createGateway({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // @ts-expect-error agentServer is an infrastructure key and may not be replaced
      extend: (infra) => ({ agentServer: infra.agentServer }),
      handlers: () => ({}),
    });
    createGateway({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // @ts-expect-error publicServer is an infrastructure key and may not be replaced
      extend: (infra) => ({ publicServer: infra.publicServer }),
      handlers: () => ({}),
    });
  });
});

/**
 * Both servers describing themselves, which is a claim no part can make on its own: a part
 * knows its own routes and nothing about which surface it shares them with, and the plugin
 * that discovers them is registered by this constructor before any part exists at all.
 *
 * Nothing here reaches PostgreSQL. The Gateways are constructed against the database URL
 * that resolves to nothing, the same one the two tests above it use, and never started:
 * `openDb` connects lazily, `ready()` boots the plugins without listening, and `inject`
 * answers without a socket. `inject` is right here for the reason real sockets are right
 * further up: that suite's subject is what is listening and when, and `inject` answers on
 * a server that has been closed. This one never starts or stops a Gateway.
 *
 * **All twenty-seven routes declare what they answer with**, one part at a time: the Signal
 * Worker's four, Users' three, Password Auth's four, the HTTP Channel's four, Decisions' five,
 * Signatures' three and the Scheduler's four. What no test here can do is catch a *dropped* field,
 * since a document and the wire it describes are the same schema read twice. That is the round-trip
 * assertions in the first suite, which need records real parts recorded and therefore a real
 * database.
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
   * makes an Agent server route unable to leak into the Public server's description.
   *
   * A path ending in a slash is a route registered at `""` under a prefix, which is how
   * `GET /users` and both Message routes are written. Cosmetic, carried by a generated
   * client, and not worth changing a route over.
   */
  const agentPaths = [
    "/decisions/",
    "/decisions/{seq}",
    "/messages/",
    "/runs",
    "/runs/{id}",
    "/schedules",
    "/schedules/{name}",
    "/sign",
    "/signals",
    "/signals/{id}",
    "/users/",
    "/users/{id}",
  ];
  const publicPaths = [
    "/auth/password",
    "/auth/tokens",
    "/auth/tokens/current",
    "/decisions/",
    "/decisions/{seq}",
    "/jwks.json",
    "/messages/",
    "/users/me",
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

  let described: Gateway<InfraComponents & Stack>;

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
    assert.equal(document.info.title, "Concorde Gateway: Agent server");
    assert.equal(document.info.version, describedVersion);
    // The one sentence about this surface that is true of every route on it, and the one
    // an Agent Implementation would otherwise be told by hand: there is no credential here.
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
    assert.equal(document.info.title, "Concorde Gateway: Public server");
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
    // has to guess. Read out of the served document rather than off
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

      // Tagged, so the browsable page groups them rather than listing two dozen routes
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

  it("says what the three Users routes answer with, across both surfaces", async () => {
    // Three routes and two documents, which is one of the parts that span both surfaces and
    // therefore one of the places where "an Agent server route can never leak into the Public
    // server's description" is a claim about a part rather than about a server.
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    // A path ending in a slash is a route registered at `""` under a prefix, which is how
    // `GET /users` is written.
    const answers: readonly {
      readonly surface: keyof typeof documents;
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { surface: "agent", path: "/users/", method: "get", statuses: ["200", "400"] },
      { surface: "agent", path: "/users/{id}", method: "get", statuses: ["200", "400", "404"] },
      { surface: "public", path: "/users/me", method: "get", statuses: ["200", "400", "401"] },
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
        assert.ok(Object.hasOwn(answered, "content"), `${where} ${status}`);
      }

      assert.ok(route.tags !== undefined && route.tags.length > 0, `${where} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
      // One tag across both surfaces, because these three are one part: which surface a
      // reader is on is the document they fetched rather than a label inside it.
      assert.deepEqual(tagsOf(documents[surface], path, method), ["Users"], where);
    }

    // **There is no create, and the document is where that is visible to a client author.**
    // `POST /users` was removed rather than stripped of its password parameter, so an injected
    // prompt cannot mint itself an account and then a credential for it. Asserted on
    // the served document, because that is the only part of this a consumer sees.
    assert.equal(documents.agent.paths["/users/"]?.post, undefined);
    assert.equal(documents.agent.paths["/users/{id}"]?.post, undefined);
    assert.equal(JSON.stringify(documents.agent.paths).includes('"requestBody"'), true);
    for (const surface of ["agent", "public"] as const) {
      for (const [path, operations] of Object.entries(documents[surface].paths)) {
        if (!path.startsWith("/users")) continue;
        assert.deepEqual(Object.keys(operations), ["get"], `${surface} ${path}`);
      }
    }
    // And the read says so, so a client author is told rather than left to notice a missing
    // verb.
    assert.match(
      String(documents.agent.paths["/users/"]?.get?.description),
      /\*\*These routes are reads\.\*\*/,
    );

    // `GET /users/me` wants a credential and names no scheme as *the* scheme, because it
    // echoes whichever User the Gateway authenticated.
    const me = String(documents.public.paths["/users/me"]?.get?.description);
    assert.match(me, /\*\*Requires authentication\.\*\*/);
    assert.match(me, /any scheme this deployment accepts/);

    // The User as it is answered: exactly three fields, named rather than counted, because
    // the schema being a **positive list** is what keeps a column added to `concorde_users.users`
    // off the wire. That no credential reaches one is the first suite's assertion; that the
    // document does not even describe one is this.
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

    // Property descriptions on the one field whose name is not the whole story, and on
    // neither of the two whose name is.
    assert.match(String(user.properties?.attributes?.description), /where grouping/);
    assert.equal(user.properties?.id?.description, undefined);
    assert.equal(user.properties?.createdAt?.description, undefined);

    // The same shape on the Public route, which is a second response schema written
    // separately: a field declared in one and forgotten in the other differs here.
    assert.deepEqual(
      Object.keys(schemaOf(documents.public, "/users/me", "get", "200").properties ?? {}).sort(),
      ["attributes", "createdAt", "id"],
    );
  });

  it("says what Password Auth's four routes answer with, and which one needs no Token", async () => {
    // The one part whose routes are all on the Public server, and the only part in this
    // deployment that holds a credential: the login and the three routes below it.
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const answers: readonly {
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { path: "/auth/tokens", method: "post", statuses: ["201", "400", "401"] },
      { path: "/auth/tokens/current", method: "delete", statuses: ["204", "400", "401"] },
      { path: "/auth/tokens", method: "delete", statuses: ["204", "400", "401"] },
      { path: "/auth/password", method: "put", statuses: ["204", "400", "401"] },
    ];

    for (const { path, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${path}`;
      const route = documents.public.paths[path]?.[method];
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

      assert.deepEqual(tagsOf(documents.public, path, method), ["Authentication"], where);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    // Tagged so that the two surfaces group separately: the routes an agent may call are
    // Users, the routes a person's client calls to get a credential are Authentication, and
    // neither name appears in the other document.
    assert.equal(JSON.stringify(documents.agent.paths).includes("Authentication"), false);
    assert.deepEqual(tagsOf(documents.agent, "/users/", "get"), ["Users"]);
    // Nothing of this part reaches the Agent server at all: every credential route is the
    // Public server's, and the three that escalate have no route anywhere.
    for (const path of ["/auth/tokens", "/auth/tokens/current", "/auth/password"]) {
      assert.equal(documents.agent.paths[path], undefined, path);
    }

    // Which routes want a Token, said per route, because the useful thing to know is which
    // one is the exception rather than that most of them do.
    for (const [path, method] of [
      ["/auth/tokens/current", "delete"],
      ["/auth/tokens", "delete"],
      ["/auth/password", "put"],
    ] as const) {
      const route = documents.public.paths[path]?.[method];
      assert.match(String(route?.description), /\*\*Requires a bearer Token\*\*/, path);
    }
    const trading = String(documents.public.paths["/auth/tokens"]?.post?.description);
    assert.match(trading, /the one route here that requires no Token/);

    const token = schemaOf(documents.public, "/auth/tokens", "post", "201");
    assert.deepEqual(Object.keys(token.properties ?? {}).sort(), ["expiresAt", "token", "user"]);
    assert.match(String(token.properties?.expiresAt?.description), /When the Token stops working/);
    assert.equal(token.properties?.token?.description, undefined);
  });

  it("says what the HTTP Channel's four routes answer with, and how a log is paged", async () => {
    // The other part that spans both surfaces, and the one whose two surfaces are likeliest
    // to be conflated: submitting and reading are the same pair of routes on each, differing
    // in exactly one thing, which is where the User comes from.
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    // One path on both, ending in a slash because both plugins register at `""` under the
    // prefix the constructor supplies.
    const messages = "/messages/";

    // The 404 is the agent's alone, and its absence from the Public submission is the
    // document following the code: nothing removes a User, so the id on that
    // route is the one `requireUser` just read a User by and the status is unreachable.
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
        // Every one of these carries a body, unlike the three 204s of Users.
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
    assert.equal(tagsOf(documents.public, "/users/me", "get").includes("Messages"), false);

    // **The cursor semantics, which no schema conveys any part of**: `after` and `before` are
    // two optional integers, and nothing about that shape says which of them is the newest
    // page or that all three cases answer the same way up. Asserted on both reads
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
      /foreign key onto the Users component's table/,
    );
    for (const surface of ["agent", "public"] as const) {
      assert.match(
        String(documents[surface].paths[messages]?.post?.responses["503"]?.description),
        /\*\*was not recorded\*\*, and sending it again is the right thing to do/,
        surface,
      );
    }

    // Which Public routes want a Token, in the shared words of `route-conventions.ts`: this
    // part holds no scheme of its own, so restating them would be two descriptions of one hook.
    for (const method of ["post", "get"] as const) {
      const route = documents.public.paths[messages]?.[method];
      assert.match(String(route?.description), /\*\*Requires a bearer Token\*\*/, method);
      assert.match(String(route?.responses["401"]?.description), /Authentication failed/, method);
    }
  });

  it("says what Decisions' five routes answer with, and what the artifact in them is", async () => {
    // The third part that spans both surfaces, and the one whose two surfaces are the same
    // read twice: the log is global, so the agent's read and a User's differ in nothing but
    // whether a Token is wanted, which is a thing a client author should be told rather than
    // left to infer from a missing parameter.
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const log = "/decisions/";
    const cited = "/decisions/{seq}";

    const answers: readonly {
      readonly surface: keyof typeof documents;
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { surface: "agent", path: log, method: "post", statuses: ["201", "400"] },
      { surface: "agent", path: log, method: "get", statuses: ["200", "400"] },
      // No 503 anywhere on this part: `nextval` is atomic, so there is no race to lose and no
      // bounded retry to run out of. And the only 404 is the by-number pair's, which is a
      // number nobody has rather than the HTTP Channel's missing User: with no `user_id`
      // there is no foreign key, so the Messenger's "the agent's 404 is PostgreSQL's 23503
      // caught" has no analogue here and neither read of the log can 404 at all.
      { surface: "agent", path: cited, method: "get", statuses: ["200", "400", "404"] },
      { surface: "public", path: log, method: "get", statuses: ["200", "400", "401"] },
      { surface: "public", path: cited, method: "get", statuses: ["200", "400", "401", "404"] },
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
      assert.ok(route.tags !== undefined && route.tags.length > 0, `${where} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    // Tagged as their own group on each page, and there is no publish route on the Public
    // server for a reader to look for: a User with a Token is not the shared agent.
    assert.deepEqual(tagsOf(documents.agent, log, "post"), ["Decisions"]);
    assert.deepEqual(tagsOf(documents.public, log, "get"), ["Decisions"]);
    assert.deepEqual(tagsOf(documents.public, cited, "get"), ["Decisions"]);
    assert.equal(documents.public.paths[log]?.post, undefined);
    assert.equal(documents.public.paths[cited]?.post, undefined);

    // The citation described as the thing it replaces, which is the whole reason it is a route:
    // a client that writes `?after=<n-1>&limit=1` will get that off-by-one wrong once, and
    // nothing but a sentence could tell them not to.
    for (const surface of ["agent", "public"] as const) {
      const citing = String(documents[surface].paths[cited]?.get?.description);
      assert.match(citing, /`GET \/decisions\/7` is the Decision numbered 7/, surface);
      assert.match(citing, /\*\*same read\*\* the log is paged with/, surface);
      // And what a 404 there does **not** mean, said where somebody will over-read it: a hole
      // in the sequence is a rolled-back publish and evidence of nothing at all.
      assert.match(citing, /not evidence of a Decision withheld/, surface);
      // One number in the path and no window beside it, which is the parameter list saying
      // that this route is the citation rather than a page of one.
      assert.deepEqual(
        parametersOf(documents[surface], cited, "get").map((parameter) => parameter.name),
        ["seq"],
        surface,
      );
    }

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
      // two reads pages the other identically.
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

    // And the same four fields on the citation, because it is the same schema rather than a
    // second one describing the same record: a response schema is a serializer, so two of them
    // would be two chances to drop `jws` from one surface and not the other.
    assert.deepEqual(
      Object.keys(schemaOf(documents.public, cited, "get", "200").properties ?? {}).sort(),
      fields,
    );

    // And the sentence the whole feature turns on, on the read a Party actually meets: the
    // offline path named first, and what a signature does not prove said outright, because a
    // reader who over-reads it has been misled by us.
    const takingItAway = String(documents.public.paths[log]?.get?.description);
    assert.match(takingItAway, /off-the-shelf JOSE library/);
    assert.match(takingItAway, /nothing whatever about how the agent behaved/);
  });

  it("says what Signatures' three routes answer with, and what each of them is worth", async () => {
    // The fourth part across both surfaces, and the one whose three routes are three different
    // relationships with the same key: only the agent may sign, anybody with a Token may ask,
    // and anybody at all may take the key and stop asking.
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
    // the shared agent's key to whoever can reach the port.
    assert.equal(documents.public.paths["/sign"], undefined);
    assert.equal(documents.agent.paths["/verify"], undefined);
    assert.equal(documents.agent.paths["/jwks.json"], undefined);

    // **`typ` described as what it is**, which is the one thing about this part a reader can
    // get wrong in the direction that matters: the freedom said outright on the request, and
    // the consequence of that freedom said outright on the answer.
    const signing = bodyOf(documents.agent, "/sign", "post");
    assert.deepEqual(Object.keys(signing.properties ?? {}).sort(), ["statement", "typ"]);
    assert.deepEqual(signing.required, ["statement"]);
    assert.match(
      String(signing.properties?.typ?.description),
      /Any label, `concorde-decision\+jws`/,
    );
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
    // The 401 in the shared words with where the hook came from added, which is how Decisions
    // and the HTTP Channel describe the same refusal: this part holds no scheme of its own, and
    // a client should not have to discover that to know the answer is identical there. It names
    // no scheme either, because more than one can refuse.
    const unauthenticated = String(
      documents.public.paths["/verify"]?.post?.responses["401"]?.description,
    );
    assert.match(unauthenticated, /Authentication failed/);
    assert.match(unauthenticated, /the refusal is `publicServer\.requireUser`/);
    assert.match(
      unauthenticated,
      /the same 401 every protected route on this server answers, whichever scheme the deployment accepts/,
    );
    assert.equal(unauthenticated.includes("of the Users component"), false);

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

  it("says what the Scheduler's four routes answer with, and that they are the agent's alone", async () => {
    // The Scheduler is the second Producer and an opt-in part, built into the Agent server in
    // `extend`; its routes are in this document only because the description plugin was registered
    // ahead of `extend` and its `onRoute` hook saw them register inside the constructor.
    //  All four are the agent's, disableable as a group by constructing the part with no
    // Agent server.
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const byName = "/schedules/{name}";
    const list = "/schedules";

    const answers: readonly {
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { path: byName, method: "put", statuses: ["200", "201", "400"] },
      { path: list, method: "get", statuses: ["200", "400"] },
      { path: byName, method: "get", statuses: ["200", "400", "404"] },
      { path: byName, method: "delete", statuses: ["204", "400", "404"] },
    ];

    for (const { path, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${path}`;
      const route = documents.agent.paths[path]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        // "Default Response" is what an undeclared response reads as, so this is the line that
        // tells a described status from a status the plugin invented a sentence for.
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        // The DELETE's 204 carries **no `content`**, which is what stops the document from
        // promising a body nobody sends; every other status here carries one.
        assert.equal(Object.hasOwn(answered, "content"), status !== "204", `${where} ${status}`);
      }
      assert.ok(route.tags !== undefined && route.tags.length > 0, `${where} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    // Tagged as their own group, and on the Agent server alone: a `PUT /schedules` in the Public
    // server's document would be advertising the agent's self-waking surface to whoever can reach
    // the port.
    assert.deepEqual(tagsOf(documents.agent, list, "get"), ["Schedules"]);
    assert.equal(documents.public.paths[list], undefined);
    assert.equal(documents.public.paths[byName], undefined);
    assert.equal(JSON.stringify(documents.public.paths).includes("Schedules"), false);

    // `PUT` carries a 201 and a 200 and **no 404**: it creates when the name is absent, so the
    // create-versus-update is the whole of what its status says.
    const upsert = documents.agent.paths[byName]?.put;
    assert.match(String(upsert?.description), /\bupsert\b/);
    assert.equal(Object.hasOwn(upsert?.responses ?? {}, "404"), false);

    // The read model, one shape every read answers with: exactly five fields, named rather than
    // counted, because the schema being a **positive list** is what keeps a column added to the
    // table off the wire. `nextFireAt` is required — a read answers only live Schedules.
    const record = schemaOf(documents.agent, byName, "get", "200");
    const fields = ["data", "name", "nextFireAt", "spec", "until"];
    assert.deepEqual(Object.keys(record.properties ?? {}).sort(), fields);
    assert.deepEqual([...(record.required ?? [])].sort(), fields);

    // `data` is declared with an **empty schema**, which passes arbitrary JSON through byte
    // intact and renders as "any": a `type` here would be the Scheduler having an opinion about
    // the payload it emits verbatim, and the round trip in the first suite proves it does not.
    assert.equal(record.properties?.data?.type, undefined);

    // The same shape under the list envelope, which is a second serializer written separately: one
    // `schedules` array and the same five fields on its items, so a field dropped from one schema
    // and not the other differs here.
    const page = schemaOf(documents.agent, list, "get", "200");
    assert.deepEqual(Object.keys(page.properties ?? {}), ["schedules"]);
    assert.deepEqual(
      Object.keys(page.properties?.schedules?.items?.properties ?? {}).sort(),
      fields,
    );
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
    // with an empty document, which is the only symptom there is.
    const { agentServer, publicServer } = unstarted().components;

    // Both spellings, in the stretch an Operator writes them in: nothing is awaited between
    // the constructor and these two lines, which is what makes the difference between them
    // observable at all.
    //
    // Through `register`, which is the door components already point at. The plugin's body runs at
    // boot, by which time the description plugin has added its `onRoute` hook, so this route is
    // discovered.
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
    // `npm version` writes the literal through `scripts/stamp-version.ts`, so this is the
    // backstop rather than the guard: what reaches it is a version edited into the manifest
    // without that command, or a stamp whose declaration no longer matches. Reading the
    // manifest here rather than in the constructor is the whole of the trade:
    // the cost of the constant is paid by a test rather than by a file read inside a
    // constructor documented as doing no I/O.
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    assert.equal(describedVersion, (manifest as { version?: string }).version);
  });

  /**
   * A whole stack, constructed and left alone: no pool opened, no port bound and no Handler that
   * could do anything if one were. The four parts are built in `extend`, exactly as an
   * example's `main.ts` builds them, because that is where their routes are registered now — and
   * the description this suite reads has to describe those routes, which it does only because
   * the plugin is registered ahead of `extend`.
   *
   * Called twice: once for the pair every test below reads, and once by the test that
   * needs a Gateway of its own, since a route has to be registered before the instance
   * boots and the shared pair booted in `before`.
   */
  function unstarted(): Gateway<InfraComponents & Stack> {
    return createGateway({
      databaseUrl: nowhere,
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      extend: (infra) => fullStack(infra),
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

describe("the package root", () => {
  it("reaches no Agent Implementation and none of the four parts, however far the imports go", () => {
    // `createGateway` reaches the Db, the servers and the Signal Worker and     // components an Operator builds in `extend`: they are the Operator's now, built in `extend` and reached through
    // their own subpath exports, so constructing none of them loads none of them. The
    // edge that stays absent is the one worth keeping absent — an Agent Implementation — since
    // the Runtime is an option rather than a spec, so swapping `pi` for another stays "this
    // import and this function name, and nothing below".
    const src = fileURLToPath(new URL("..", import.meta.url));
    const reached = reachableFrom(path.join(src, "gateway", "index.ts"));

    // No Agent Implementation, the one import edge worth keeping absent.
    assert.deepEqual(
      [...reached].filter((module) => module.startsWith(path.join(src, "pi/"))),
      [],
    );

    // And none of the components built in `extend`, which is the assertion inverted: the root used to reach
    // `./users` and `./http-messenger` because the assembly built them, and now reaches neither,
    // nor Signatures nor Decisions.
    for (const part of [
      path.join(src, "users", "users.ts"),
      path.join(src, "messenger", "messenger.ts"),
      path.join(src, "http-channel", "http-channel.ts"),
      path.join(src, "signatures", "signatures.ts"),
      path.join(src, "decisions", "decisions.ts"),
    ]) {
      assert.equal(reached.has(part), false, `the root should not reach ${part}`);
    }

    // The check is only worth having if it is looking at something, and this is what says it is:
    // the root does reach the infrastructure `createGateway` builds — here the Signal Worker.
    assert.ok(reached.has(path.join(src, "signals", "worker.ts")));
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
 * test's: the Db through Users, the two servers over their own sockets. A Run
 * that could not reach one of these would be a Run the shutdown order had broken — the
 * Operator's own Component included now, since it is keyed ahead of the Worker and is therefore
 * *supposed* to be still up through the drain.
 */
async function whatIsStillUp(): Promise<string[]> {
  return [
    await reaching("Users read the Db", async () => {
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
 * function: a throw from inside a Run is caught by the worker and recorded as a failed Run,
 * so the reason the drain broke would never reach the assertion outside. What
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
 * password: `users.create` derives nothing, `passwordAuth.issueToken` mints a Token for
 * somebody who presented nothing, and what comes back is indistinguishable from a Token a
 * login bought. This fixture builds Password Auth with no `scrypt`
 * option, so the alternative would be two derivations at OWASP's 32 MiB cost for nothing most
 * of this file asserts. The one test that does assert something about them buys its own.
 */
async function admitted(): Promise<{ id: string; token: string }> {
  const user: UserRecord = await components.db.tx((tx) => components.users.create(tx));
  const issued = await components.db.tx((tx) => components.passwordAuth.issueToken(tx, user.id));
  return { id: user.id, token: issued.token };
}

/**
 * One read of the Agent server, over its own socket and with nothing to authenticate
 * with, which is the whole of what reaching that port takes.
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
