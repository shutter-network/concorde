/**
 * The Signal Worker's Agent server routes: reading prior Signals and Runs.
 *
 * The subject is not that Fastify routes a request. It is what the agent can see — so
 * every assertion here is made against state a real Signal Worker recorded, by emitting
 * Signals through a real worker against real PostgreSQL and then reading them back
 * over HTTP. Nothing inserts a row directly.
 *
 * The load-bearing test is `is unscoped`, and it is written the way ADR-0011
 * describes rather than the way it is convenient: the reads happen **from inside a
 * Run**, executing in one Session, and what comes back is every other Session's
 * Signals and Runs.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { inArray } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type Component, serverComponent } from "../gateway/components.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";
import type { Prompt, SignalHandler } from "./handlers.ts";
import type { RunRecord, SignalRecord } from "./routes.ts";
import * as signalsSchema from "./schema/index.ts";
import { signals } from "./schema/index.ts";
import { createSignalWorker, type SignalWorker } from "./worker.ts";

let database: TestDatabase;
let db: Db;
let worker: SignalWorker;
/**
 * The Agent server: a bare Fastify instance an Operator constructed, given a place in
 * the start order — and the thing the Signal Worker is handed to wire itself to.
 */
let agentServer: Component & { readonly fastify: FastifyInstance };
/** Where the Agent server bound, for the one test that goes over a real socket. */
let address: string;

/**
 * What a Run read while it was the Run in flight, appended by the fake Runtime
 * Adapter.
 *
 * At module level because the reading has to happen *during* a Run and the Runs all
 * happen while the fixture below is being laid down — the one thing a test cannot do
 * from inside its own body. The reads are asserted in `the read surface`.
 */
const readsFromInsideARun: { readonly signals: SignalRecord[]; readonly runs: RunRecord[] }[] = [];

/**
 * The Signals of the fixture, by a label naming what each is for.
 *
 * Labelled rather than looked up by `kind` or by position: two of them share a `kind`
 * on purpose, and `emitted[2]` in an assertion says nothing about which Signal is
 * meant.
 */
const emitted = new Map<string, string>();

function idOf(label: string): string {
  const id = emitted.get(label);
  assert.ok(id !== undefined, `no Signal was emitted for ${label}`);
  return id;
}

/** A Handler that turns its Signal's payload into the Prompts written into it. */
const scripted: SignalHandler<{ readonly prompts: readonly Prompt[] }> = {
  handle: (signal) => signal.payload.prompts,
};

before(async () => {
  database = await createTestDatabase("core_routes");
  db = database.db;
  await applySchema(db, signalsSchema);

  // The framework constructs no server: this is a bare Fastify instance, the same call
  // an Operator's entry point makes. `serverComponent` adds only where it listens, and
  // it is what the Signal Worker below is given to register its routes on.
  agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });

  const runtime = fakeRuntime(async (prompt) => {
    if (prompt.text === "doomed") {
      return { ok: false, error: "the agent gave up" };
    }
    if (prompt.session === "user_e") {
      // A Run reading the Gateway's state as the agent does: through the Agent
      // server, mid-Run, with its own Signal still `processing`.
      readsFromInsideARun.push({
        signals: (await read("/signals")).json<{ signals: SignalRecord[] }>().signals,
        runs: (await read("/runs")).json<{ runs: RunRecord[] }>().runs,
      });
    }
    return { ok: true };
  });

  // Handed the Agent server, so the Signal and Run surface is registered on it at no
  // prefix by the constructor: nothing here registers a plugin, and nothing here could
  // forget to (ADR-0032).
  worker = createSignalWorker({
    db,
    runtime,
    handlers: { alpha: scripted, beta: scripted },
    agentServer,
    sweepIntervalMs: 50,
  });
  // An explicit loopback host and an ephemeral port, both this test's to state — the
  // framework supplies no default for either. Fastify reports the address it bound,
  // which is what the one test over a real socket fetches.
  await agentServer.start();
  address = agentServer.fastify.listeningOrigin;
  await worker.start();

  // Arrival order matters to every ordering assertion below, so each Signal is
  // emitted in its own transaction and awaited.
  await emit("one prompt", "alpha", [{ session: "user_a", text: "for a" }]);
  await emit("two prompts", "beta", [
    { session: "user_b", text: "for b" },
    { session: null, text: "fresh" },
  ]);
  await emit("a failing Run", "alpha", [{ session: "user_c", text: "doomed" }]);
  await emit("no Handler", "unhandled", []);
  await emit("a Run that reads", "beta", [{ session: "user_e", text: "reading" }]);

  await waitUntil("every emitted Signal has reached a terminal state", async () => {
    const unsettled = await db
      .handle({ signals })
      .select({ state: signals.state })
      .from(signals)
      .where(inArray(signals.state, ["pending", "processing"]));
    return unsettled.length === 0;
  });
});

after(async () => {
  await worker.stop();
  await agentServer.stop();
  await database.drop();
});

/** Emits one Signal of the fixture and remembers its id under `label`. */
async function emit(label: string, kind: string, prompts: readonly Prompt[]): Promise<void> {
  const id = await db.tx((tx) => worker.emit(tx, { kind, payload: { prompts } }));
  emitted.set(label, id);
}

/**
 * One read over the Agent server. `inject` rather than a socket: what the surface
 * answers is this file's subject, and a socket per case would only re-prove Fastify.
 * The one case that does go over the wire is `answers over HTTP` below.
 */
function read(path: string) {
  return agentServer.fastify.inject({ method: "GET", url: path });
}

async function readSignals(path = "/signals"): Promise<SignalRecord[]> {
  const response = await read(path);
  assert.equal(response.statusCode, 200, `${path} should have answered: ${response.body}`);
  return response.json<{ signals: SignalRecord[] }>().signals;
}

async function readRuns(path = "/runs"): Promise<RunRecord[]> {
  const response = await read(path);
  assert.equal(response.statusCode, 200, `${path} should have answered: ${response.body}`);
  return response.json<{ runs: RunRecord[] }>().runs;
}

describe("reading prior Signals over the Agent server", () => {
  it("reports every Signal, newest first, with its state and its error", async () => {
    const list = await readSignals();
    assert.deepEqual(
      list.map((signal) => signal.kind),
      ["beta", "unhandled", "alpha", "beta", "alpha"],
    );

    const settled = list[4];
    assert.ok(settled !== undefined);
    assert.equal(settled.id, idOf("one prompt"));
    assert.equal(settled.state, "done");
    assert.equal(settled.error, null);
    assert.deepEqual(settled.payload, { prompts: [{ session: "user_a", text: "for a" }] });
    assert.equal(new Date(settled.emittedAt).toISOString(), settled.emittedAt);

    // A Signal that failed carries why, which is the whole reason a state without an
    // error would be no use: a typo in a `kind` is permanent (ADR-0017), so the
    // reason has to be readable.
    const unhandled = list.find((signal) => signal.kind === "unhandled");
    assert.ok(unhandled !== undefined);
    assert.equal(unhandled.state, "failed");
    assert.match(String(unhandled.error), /no Signal Handler is registered for kind "unhandled"/);
  });

  it("reports one Signal by id, and says so when there is none", async () => {
    const one = await read(`/signals/${idOf("no Handler")}`);
    assert.equal(one.statusCode, 200);
    const record = one.json<SignalRecord>();
    assert.equal(record.id, idOf("no Handler"));
    assert.equal(record.state, "failed");

    const absent = await read("/signals/2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21");
    assert.equal(absent.statusCode, 404);

    // A malformed id is a bad request rather than a 500 from PostgreSQL refusing to
    // cast it, which is what an unvalidated parameter would produce.
    const malformed = await read("/signals/not-an-id");
    assert.equal(malformed.statusCode, 400);

    // A single record takes no parameters either, so a `?session=` on one is refused
    // rather than answered as though it had been honoured.
    const scoped = await read(`/signals/${idOf("no Handler")}?session=user_a`);
    assert.equal(scoped.statusCode, 400);
  });

  it("takes a limit and a kind, and refuses anything else", async () => {
    assert.equal((await readSignals("/signals?limit=2")).length, 2);
    assert.deepEqual(
      (await readSignals("/signals?kind=alpha")).map((signal) => signal.state),
      ["failed", "done"],
    );

    for (const query of ["limit=0", "limit=201", "limit=nine"]) {
      assert.equal((await read(`/signals?${query}`)).statusCode, 400, query);
    }

    // There is no scope parameter to pass, and asking for one is an error rather than
    // a request silently answered with everything (ADR-0011).
    for (const query of ["session=user_a", "userId=a"]) {
      assert.equal((await read(`/signals?${query}`)).statusCode, 400, query);
    }
  });
});

describe("reading Runs over the Agent server", () => {
  it("reports which Signal each Run came from and how it ended", async () => {
    const list = await readRuns();
    assert.deepEqual(
      list.map((run) => run.prompt),
      ["reading", "doomed", "fresh", "for b", "for a"],
    );

    const failed = list.find((run) => run.prompt === "doomed");
    assert.ok(failed !== undefined);
    assert.equal(failed.signalId, idOf("a failing Run"));
    assert.equal(failed.session, "user_c");
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "the agent gave up");
    assert.equal(new Date(String(failed.startedAt)).toISOString(), failed.startedAt);
    assert.equal(new Date(String(failed.endedAt)).toISOString(), failed.endedAt);

    const fresh = list.find((run) => run.prompt === "fresh");
    assert.ok(fresh !== undefined);
    // The Run whose Prompt asked for a fresh Session, and it reads as a Session like any
    // other: the Signal Worker named it after this very Run before starting it, so what
    // the agent sees here is where the transcript went rather than `null` (ADR-0033).
    assert.equal(fresh.session, `run_${fresh.id}`);
    assert.equal(fresh.state, "done");
    assert.equal(fresh.error, null);
  });

  it("reports the Runs of one Signal, and one Run by id", async () => {
    const twoPrompts = idOf("two prompts");
    const both = await readRuns(`/runs?signalId=${twoPrompts}`);
    const one = both[0];
    assert.ok(one !== undefined);
    assert.deepEqual(
      both.map((run) => run.session),
      [`run_${one.id}`, "user_b"],
    );
    assert.ok(both.every((run) => run.signalId === twoPrompts));

    const byId = await read(`/runs/${one.id}`);
    assert.equal(byId.statusCode, 200);
    assert.deepEqual(byId.json<RunRecord>(), one);

    assert.equal((await read("/runs/2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21")).statusCode, 404);
    assert.equal((await read("/runs/not-an-id")).statusCode, 400);
    assert.equal((await read("/runs?signalId=not-an-id")).statusCode, 400);
    assert.equal((await read("/runs?session=user_b")).statusCode, 400);
    assert.equal((await read(`/runs/${one.id}?session=user_b`)).statusCode, 400);
  });
});

describe("the read surface", () => {
  it("is unscoped: a Run in one Session reads every other Session's Signals and Runs", () => {
    // Read by the Run in Session `user_e`, while it was the Run in flight. Session
    // routing organises context; it isolates nothing, and no endpoint may be designed
    // as though it did (ADR-0011).
    assert.equal(
      readsFromInsideARun.length,
      1,
      "the Run in user_e should have read the Agent server exactly once",
    );
    const whatItSaw = readsFromInsideARun[0];
    assert.ok(whatItSaw !== undefined);
    const { signals: seenSignals, runs: seenRuns } = whatItSaw;

    assert.deepEqual(
      // The one Session nobody named is folded to a fixed word, because its name is the
      // id of the Run carrying it and so differs every time this suite runs (ADR-0033).
      seenRuns
        .map((run) => (run.session === `run_${run.id}` ? "named after its own Run" : run.session))
        .toSorted(),
      ["named after its own Run", "user_a", "user_b", "user_c", "user_e"].toSorted(),
      "a Run should see the Runs of every other Session",
    );
    assert.deepEqual(
      seenSignals.map((signal) => signal.kind).toSorted(),
      ["alpha", "alpha", "beta", "beta", "unhandled"].toSorted(),
    );

    // Its own Signal and its own Run, mid-flight: the states are the live ones rather
    // than a snapshot taken at some settled moment.
    const own = seenRuns.find((run) => run.session === "user_e");
    assert.ok(own !== undefined);
    assert.equal(own.state, "running");
    assert.equal(own.endedAt, null);
    assert.equal(seenSignals.find((signal) => signal.id === own.signalId)?.state, "processing");
  });

  it("answers over HTTP at the address the Agent server bound", async () => {
    // What the agent actually does: one `curl` against a base URL and a path, with
    // nothing to authenticate with, because reaching the port is access (ADR-0010).
    const response = await fetch(`${address}/signals?limit=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");

    // Byte for byte what `inject` answers, which is what makes every other assertion
    // in this file a claim about the wire and not only about Fastify's own harness.
    const overTheSocket = await response.text();
    assert.equal(overTheSocket, (await read("/signals?limit=1")).body);
    assert.match(overTheSocket, /"kind":"beta"/);
  });
});
