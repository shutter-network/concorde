/**
 * The firing core, observed at the highest seam: what fired (a Signal on the wire) and what the
 * Schedule became (a list result, or a subsequent fire), never the Scheduler's private state.
 *
 * Two seams, both from the HTTP Messenger's prior art. Timing is deterministic: the Scheduler
 * takes an injected clock, and this file sets `now`, awaits `tick`, and asserts what fired, with no
 * sleeping (ADR-0018). And the fired Signal is read back over a **real, unstarted** Signal Worker's
 * `GET /signals` route — `src/http-messenger/trusted.test.ts` does exactly this: the worker is
 * constructed with its Agent routes and never started, so nothing drains the queue and the Signal
 * the Scheduler emitted sits there to be read. Because the emit and the schedule's retirement share
 * one transaction, the same read proves atomicity: after a tick, the Signal is readable *and* the
 * Schedule advanced or retired.
 *
 * A database of this file's own, because no two test files may share one.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { type Component, serverComponent } from "../components.ts";
import type { Db } from "../db/index.ts";
import type { Logger } from "../logging.ts";
import { signalsMigrations } from "../signals/migrations.ts";
import type { SignalRecord } from "../signals/routes.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { schedulerMigrations } from "./migrations.ts";
import { createScheduler, type Scheduler, scheduleFiredKind } from "./scheduler.ts";
import type { ScheduleFiredRecord } from "./schedules.ts";

let database: TestDatabase;
let db: Db;
let worker: SignalWorker;
/** The Agent server the worker's read routes land on, injected against and never started. */
let agentServer: Component & { readonly fastify: FastifyInstance };

/** The clock the Scheduler reads, moved by the tests. Constructed fresh per test. */
let clockNow: Date;

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

/** A fixed origin, so every instant in a test is a legible offset from it. */
const t0 = new Date("2030-06-01T12:00:00.000Z").getTime();
const iso = (ms: number) => new Date(ms).toISOString();

/** Nothing here starts the worker, so nothing should be printed by one. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

before(async () => {
  database = await createTestDatabase("scheduler_firing");
  db = database.db;
  // The two descriptors a deployment with a Scheduler registers, applied once up front the way a
  // pre-deploy entry point applies them. Order is free — the Scheduler references nobody.
  db.registerMigrations(signalsMigrations, schedulerMigrations);
  await db.migrate();

  agentServer = serverComponent(Fastify(), nowhere);
  // Constructed and never started, with its own Agent routes on the Agent server: this file reads
  // the Signals the Scheduler emits back over `GET /signals`, and a running worker would take them
  // off the queue and try to handle them.
  worker = createSignalWorker({
    db,
    runtime: fakeRuntime(),
    handlers: {},
    agentServer,
    logger: silent,
  });
});

after(async () => {
  await agentServer.stop();
  await worker.stop();
  await database.drop();
});

/** A Scheduler on the shared Db and worker, reading a clock this file moves. */
function scheduler(): Scheduler {
  return createScheduler({ db, worker, now: () => clockNow, logger: silent });
}

/**
 * The fired-Schedule Signals for one Schedule name, over the worker's own Agent routes.
 *
 * That seam rather than the `signals` table: what a transaction committed is observable where a
 * deployment reads it. Filtered by the Schedule the payload names, because the surface is unscoped
 * and this file's one database accumulates every test's Signals.
 */
async function fired(name: string): Promise<ScheduleFiredRecord[]> {
  const response = await agentServer.fastify.inject({
    method: "GET",
    url: `/signals?kind=${scheduleFiredKind}`,
  });
  assert.equal(response.statusCode, 200, `GET /signals should have answered: ${response.body}`);
  return response
    .json<{ signals: SignalRecord[] }>()
    .signals.map((signal) => signal.payload as ScheduleFiredRecord)
    .filter((payload) => payload.scheduleName === name);
}

/** The names in a Scheduler's list, which is what most retire/upsert assertions turn on. */
async function names(instance: Scheduler): Promise<string[]> {
  return (await instance.list()).map((schedule) => schedule.name);
}

describe("a once Schedule", () => {
  it("fires exactly once when tick runs at or after its instant, and is retired", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();

    const outcome = await instance.schedule({
      name: "followup",
      spec: { kind: "once", at: iso(t0 + hour) },
      data: { topic: "deploy" },
    });
    assert.equal(outcome.created, true);
    assert.equal(outcome.schedule.nextFireAt, iso(t0 + hour));
    assert.deepEqual(await names(instance), ["followup"]);

    // Not yet due: now is still before the instant, so a tick fires nothing.
    await instance.tick();
    assert.deepEqual(await fired("followup"), []);
    assert.deepEqual(await names(instance), ["followup"]);

    // Now reaches past the instant, and one tick fires it. `firedAt` is that later now, and
    // `scheduledFor` the instant it was meant for, so a Handler can see the fire was late.
    clockNow = new Date(t0 + 2 * hour);
    await instance.tick();
    assert.deepEqual(await fired("followup"), [
      {
        scheduleName: "followup",
        data: { topic: "deploy" },
        scheduledFor: iso(t0 + hour),
        firedAt: iso(t0 + 2 * hour),
      },
    ]);
    // Retired: the emit and the delete were one transaction, so the Schedule is gone the moment
    // its Signal is readable.
    assert.deepEqual(await names(instance), []);

    // Spent: a second tick, at the same now, fires nothing more. Exactly-once against real
    // PostgreSQL rather than a claim about the code.
    await instance.tick();
    assert.equal((await fired("followup")).length, 1);
  });

  it("never fires when its instant is already past at creation, and is not armed", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();

    // A once whose instant is behind now has no future occurrence: it is not a future fire, so it
    // is dropped and marked spent rather than stored as something a tick would fire (ADR-0018).
    const outcome = await instance.schedule({
      name: "stale",
      spec: { kind: "once", at: iso(t0 - hour) },
      data: { note: "too late" },
    });
    assert.equal(outcome.created, false);
    assert.equal(outcome.schedule.nextFireAt, null);
    assert.deepEqual(await names(instance), []);

    // And it never fires, however far now advances: nothing in the past was ever enumerated.
    clockNow = new Date(t0 + 10 * hour);
    await instance.tick();
    assert.deepEqual(await fired("stale"), []);
  });

  it("fires late, once, when now jumps past a future instant between ticks", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();
    // Armed as a future fire, then now jumps clean across it before any tick — a live process
    // frozen through the fire time. The accepted residual is one late fire, not a drop, which is
    // the difference from a past-at-creation once above (ADR-0018).
    await instance.schedule({
      name: "frozen",
      spec: { kind: "once", at: iso(t0 + hour) },
      data: 7,
    });

    clockNow = new Date(t0 + 5 * hour);
    await instance.tick();
    assert.deepEqual(await fired("frozen"), [
      {
        scheduleName: "frozen",
        data: 7,
        scheduledFor: iso(t0 + hour),
        firedAt: iso(t0 + 5 * hour),
      },
    ]);
    assert.deepEqual(await names(instance), []);
  });
});

describe("creating a Schedule whose name already exists", () => {
  it("updates it in place, never duplicating and never dropping the change", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();

    const first = await instance.schedule({
      name: "digest",
      spec: { kind: "once", at: iso(t0 + hour) },
      data: { revision: 1 },
    });
    assert.equal(first.created, true);

    // The same name again, with a later instant and different data: an update, not a second row.
    const second = await instance.schedule({
      name: "digest",
      spec: { kind: "once", at: iso(t0 + 3 * hour) },
      data: { revision: 2 },
    });
    assert.equal(second.created, false);
    assert.equal(second.schedule.nextFireAt, iso(t0 + 3 * hour));

    // One row, carrying the revised instant and data — the change was not silently dropped.
    const listed = await instance.list();
    assert.equal(listed.filter((schedule) => schedule.name === "digest").length, 1);
    const digest = listed.find((schedule) => schedule.name === "digest");
    assert.deepEqual(digest?.spec, { kind: "once", at: iso(t0 + 3 * hour) });
    assert.deepEqual(digest?.data, { revision: 2 });

    // The old instant is gone: a tick at it fires nothing, since the row now fires later.
    clockNow = new Date(t0 + 2 * hour);
    await instance.tick();
    assert.deepEqual(await fired("digest"), []);

    // And the revised one fires, with the revised data — the update reached the fire.
    clockNow = new Date(t0 + 3 * hour);
    await instance.tick();
    assert.deepEqual(await fired("digest"), [
      {
        scheduleName: "digest",
        data: { revision: 2 },
        scheduledFor: iso(t0 + 3 * hour),
        firedAt: iso(t0 + 3 * hour),
      },
    ]);
  });
});

describe("cancelling a Schedule", () => {
  it("removes future fires and reports whether one was there", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();
    await instance.schedule({
      name: "abandon",
      spec: { kind: "once", at: iso(t0 + hour) },
      data: {},
    });

    assert.equal(await instance.cancel("abandon"), true);
    assert.deepEqual(await names(instance), []);
    // Cancelling one already gone says so, rather than an idempotent success it cannot honestly
    // claim (ADR-0018).
    assert.equal(await instance.cancel("abandon"), false);
    assert.equal(await instance.cancel("never-existed"), false);

    // And it does not fire: a cancel removes the future fire, so a tick past its instant is silent.
    clockNow = new Date(t0 + 2 * hour);
    await instance.tick();
    assert.deepEqual(await fired("abandon"), []);
  });
});
