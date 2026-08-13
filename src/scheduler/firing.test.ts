/**
 * The firing core, observed at the highest seam: what fired (a Signal on the wire) and what the
 * Schedule became (a list result, or a subsequent fire), never the Scheduler's private state.
 *
 * Two seams, both from the Messenger's prior art. Timing is deterministic: the Scheduler
 * takes an injected clock, and this file sets `now`, awaits `tick`, and asserts what fired, with no
 * sleeping (ADR-0018). And the fired Signal is read back over a **real, unstarted** Signal Worker's
 * `GET /signals` route — `src/messenger/trusted.test.ts` does exactly this: the worker is
 * constructed with its Agent routes and never started, so nothing drains the queue and the Signal
 * the Scheduler emitted sits there to be read. Because the emit and the schedule's retirement share
 * one transaction, the same read proves atomicity: after a tick, the Signal is readable *and* the
 * Schedule advanced or retired.
 *
 * A database of this file's own, because no two test files may share one.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type Component, serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import type { SignalRecord } from "../signals/routes.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";
import { createScheduler, type Scheduler, scheduleFiredKind } from "./scheduler.ts";
import { type ScheduleFiredRecord, ScheduleSpecError } from "./schedules.ts";
import * as schedulerSchema from "./schema/index.ts";
import { schedules } from "./schema/index.ts";

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
const day = 24 * hour;

/** A real-time pause, for the timer tests that assert something does *not* happen. */
const delay = (ms: number) => new Promise((resume) => setTimeout(resume, ms));

/** A fixed origin, so every instant in a test is a legible offset from it. */
const t0 = new Date("2030-06-01T12:00:00.000Z").getTime();
const iso = (ms: number) => new Date(ms).toISOString();

/** Nothing here starts the worker, so nothing should be printed by one. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

before(async () => {
  database = await createTestDatabase("scheduler_firing");
  db = database.db;
  // The two schemas a deployment with a Scheduler lists, pushed once up front the way an
  // Operator's own `drizzle-kit` applies them (ADR-0046).
  await applySchema(db, signalsSchema, schedulerSchema);

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

// Each test observes a fresh, empty table. Unlike a spent `once` or a cancelled Schedule, a
// recurring cron persists after it fires, so without this a test's survivors would leak into the
// next and the global `list` a `names` assertion reads would no longer be that test's alone. The
// Signals a fire emits are not cleared — they accumulate in the shared Signal Worker — so every
// Schedule name in this file is globally unique and `fired` filters on it.
beforeEach(async () => {
  await db.handle({ schedules }).delete(schedules);
});

/** A Scheduler on the shared Db and worker, reading a clock this file moves. */
function scheduler(): Scheduler {
  return createScheduler({ db, worker, now: () => clockNow, logger: silent });
}

/**
 * Simulates a restart: a fresh Scheduler over the same persisted rows, booted so its `start`
 * re-derives every next fire forward from the current clock, then its live timer stopped so the test
 * goes on driving `tick`/`now` deterministically. What survives a restart is the database, not the
 * instance — so this is the seam that tells a booted Scheduler apart from a continuously-live one.
 */
async function restart(): Promise<Scheduler> {
  const instance = scheduler();
  await instance.start();
  await instance.stop();
  return instance;
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

/** A cap short enough that the real timer wakes in milliseconds, so the timer tests stay fast. */
const cappedMs = 20;

/**
 * A Scheduler with the firing cap set small, run through `body` and stopped after — even on a
 * failure, so its live timer never outlives the test and keeps this process awake. Mirrors the
 * Signal Worker tests' `withWorker`. `body` does its own `start`, because the timer tests differ in
 * whether they arm before or after scheduling and one drives `stop` itself; `stop` is idempotent, so
 * the `finally` is a backstop rather than a second teardown. `clock` is the wall clock the timer
 * re-derives against: the smoke test passes real time, the rest a fake clock they advance.
 */
async function withScheduler(
  clock: () => Date,
  body: (instance: Scheduler) => Promise<void>,
): Promise<void> {
  const instance = createScheduler({
    db,
    worker,
    now: clock,
    maxSleepMs: cappedMs,
    logger: silent,
  });
  try {
    await body(instance);
  } finally {
    await instance.stop();
  }
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

  it("is dropped on boot, not fired late, when its instant passed while the process was down", async () => {
    clockNow = new Date(t0);
    const armed = scheduler();
    await armed.schedule({
      name: "boot-drop",
      spec: { kind: "once", at: iso(t0 + hour) },
      data: 1,
    });
    assert.deepEqual(await names(armed), ["boot-drop"]);

    // The instant passes while the process is down, then it restarts. Boot re-derives forward, and a
    // once with no future instant is dropped rather than replayed — the same rule creation applies,
    // now at boot too, so a reminder for a moment the process was down is simply lost, not fired late
    // (ADR-0018). This is the restart counterpart of the live-frozen "fires late" case above.
    clockNow = new Date(t0 + 2 * hour);
    const rebooted = await restart();
    assert.deepEqual(await names(rebooted), []);
    await rebooted.tick();
    assert.deepEqual(await fired("boot-drop"), []);
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

/**
 * The programmatic door, which is the only one a name outside the charset can reach: the params
 * schema refuses the rest in front of a handler. `routes.test.ts` covers that half.
 */
describe("a Schedule's name", () => {
  it("is refused at the call when it is not a url-safe key, so nothing unaddressable is stored", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();

    for (const name of ["morning digest!", "has space", "", "a".repeat(129), "sla/sh"]) {
      await assert.rejects(
        instance.schedule({ name, spec: { kind: "once", at: iso(t0 + hour) } }),
        (error: unknown) => error instanceof ScheduleSpecError,
        `${JSON.stringify(name)} should throw ScheduleSpecError`,
      );
    }

    // A refusal persists nothing, so the agent's list never shows a row it cannot then address.
    assert.deepEqual(await names(instance), []);
  });

  it("takes every name the Agent routes can address, to the length and charset they allow", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();

    const longest = "a".repeat(128);
    for (const name of ["Digest.7", "with_under-score", longest]) {
      await instance.schedule({ name, spec: { kind: "once", at: iso(t0 + hour) } });
    }

    assert.deepEqual((await names(instance)).sort(), ["Digest.7", longest, "with_under-score"]);
  });
});

describe("a cron Schedule", () => {
  it("fires on each occurrence, advances, and keeps firing with the fixed kind and verbatim data", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();

    // Every hour on the hour, no tz (so UTC). Created exactly on the hour at t0, so the next fire
    // is the *following* hour — cron's next is strictly after now.
    const outcome = await instance.schedule({
      name: "hourly",
      spec: { kind: "cron", expr: "0 * * * *" },
      data: { check: "health" },
    });
    assert.equal(outcome.created, true);
    assert.deepEqual(outcome.schedule.spec, { kind: "cron", expr: "0 * * * *", tz: "UTC" });
    assert.equal(outcome.schedule.nextFireAt, iso(t0 + hour));

    // Before the first occurrence: nothing fires.
    await instance.tick();
    assert.deepEqual(await fired("hourly"), []);

    // The first occurrence matures: one fire, the fixed kind, the data verbatim, and the Schedule
    // stays — advanced to the next hour.
    clockNow = new Date(t0 + hour);
    await instance.tick();
    assert.deepEqual(await fired("hourly"), [
      {
        scheduleName: "hourly",
        data: { check: "health" },
        scheduledFor: iso(t0 + hour),
        firedAt: iso(t0 + hour),
      },
    ]);
    assert.deepEqual(await names(instance), ["hourly"]);
    assert.equal((await instance.list())[0]?.nextFireAt, iso(t0 + 2 * hour));

    // The second occurrence: it keeps firing without being re-armed. `fired` returns newest-first,
    // so sort by the instant to compare against the occurrences in order.
    clockNow = new Date(t0 + 2 * hour);
    await instance.tick();
    const byInstant = (await fired("hourly")).sort((a, b) =>
      a.scheduledFor.localeCompare(b.scheduledFor),
    );
    assert.deepEqual(byInstant, [
      {
        scheduleName: "hourly",
        data: { check: "health" },
        scheduledFor: iso(t0 + hour),
        firedAt: iso(t0 + hour),
      },
      {
        scheduleName: "hourly",
        data: { check: "health" },
        scheduledFor: iso(t0 + 2 * hour),
        firedAt: iso(t0 + 2 * hour),
      },
    ]);
  });

  it("treats a cron with no time zone as UTC, never the server's local zone", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();

    // 08:30 daily, no tz. From noon on 2030-06-01 the next 08:30 is the next day — and it is 08:30
    // *UTC*, the instant asserted below, which only holds if the omitted zone resolved to UTC.
    const outcome = await instance.schedule({
      name: "utc-default",
      spec: { kind: "cron", expr: "30 8 * * *" },
      data: null,
    });
    assert.equal(outcome.schedule.spec.kind, "cron");
    assert.deepEqual(outcome.schedule.spec, { kind: "cron", expr: "30 8 * * *", tz: "UTC" });
    assert.equal(outcome.schedule.nextFireAt, "2030-06-02T08:30:00.000Z");
  });

  it("stops after its last occurrence at or before until, and is retired", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();

    // Hourly, bounded at t0 + 2h. The occurrences at t0+1h and t0+2h are at or before the bound and
    // fire; the one at t0+3h is past it, so the Schedule retires after t0+2h.
    const outcome = await instance.schedule({
      name: "bounded",
      spec: { kind: "cron", expr: "0 * * * *" },
      data: 1,
      until: iso(t0 + 2 * hour),
    });
    assert.equal(outcome.schedule.until, iso(t0 + 2 * hour));
    assert.equal(outcome.schedule.nextFireAt, iso(t0 + hour));

    clockNow = new Date(t0 + hour);
    await instance.tick();
    assert.deepEqual(await names(instance), ["bounded"]); // still going

    clockNow = new Date(t0 + 2 * hour);
    await instance.tick();
    // The bound's own occurrence fired, and there is no occurrence at or before the bound left, so
    // the Schedule is gone.
    assert.deepEqual(await names(instance), []);
    assert.deepEqual((await fired("bounded")).map((f) => f.scheduledFor).sort(), [
      iso(t0 + hour),
      iso(t0 + 2 * hour),
    ]);

    // Past the bound: nothing more fires.
    clockNow = new Date(t0 + 5 * hour);
    await instance.tick();
    assert.equal((await fired("bounded")).length, 2);
  });

  it("re-derives forward on boot, so a restart skips every missed occurrence — one or many", async () => {
    clockNow = new Date(t0);
    const armed = scheduler();
    await armed.schedule({ name: "outage", spec: { kind: "cron", expr: "0 * * * *" }, data: "d" });
    // Armed at t0 + 1h.

    // A restart down across a SINGLE occurrence: now is 30m past the t0+1h fire, before the t0+2h
    // one. Boot must not replay t0+1h — it re-derives forward to t0+2h and fires nothing late.
    clockNow = new Date(t0 + hour + 30 * 60 * 1000);
    const afterOne = await restart();
    assert.deepEqual(await fired("outage"), [], "a single missed occurrence must not fire on boot");
    assert.equal((await afterOne.list())[0]?.nextFireAt, iso(t0 + 2 * hour));

    // A restart down across MANY occurrences: now jumps ten hours on. Same rule, no backlog — the
    // one-occurrence and many-occurrence outages are identical, both clean.
    clockNow = new Date(t0 + 10 * hour + 15 * 60 * 1000);
    const afterMany = await restart();
    assert.deepEqual(await fired("outage"), [], "many missed occurrences must not fire on boot");
    assert.equal((await afterMany.list())[0]?.nextFireAt, iso(t0 + 11 * hour));

    // And once genuinely live again, the next occurrence fires normally.
    clockNow = new Date(t0 + 11 * hour);
    await afterMany.tick();
    assert.deepEqual(await fired("outage"), [
      {
        scheduleName: "outage",
        data: "d",
        scheduledFor: iso(t0 + 11 * hour),
        firedAt: iso(t0 + 11 * hour),
      },
    ]);
  });

  it("fires once, late, when a continuously-live process is frozen through a fire (the only residual)", async () => {
    // The single accepted residual: a process that never restarted, whose timer wakes late because it
    // was frozen straight through the fire time. No boot re-derivation runs here — the test drives
    // `tick` on a live instance — so the armed occurrence is announced once, late, and the next fire
    // is then derived strictly forward. A restart, by contrast, re-derives on boot and fires nothing
    // late, however few or many occurrences it missed (the test above). Pinned so the split between a
    // live freeze and a restart is deliberate.
    clockNow = new Date(t0);
    const instance = scheduler();
    await instance.schedule({
      name: "live-frozen",
      spec: { kind: "cron", expr: "0 * * * *" }, // hourly; first fire at t0 + 1h
      data: "g",
    });

    // Now is 30 minutes past the t0+1h occurrence but before the t0+2h one, with no restart between.
    clockNow = new Date(t0 + hour + 30 * 60 * 1000);
    await instance.tick();
    assert.deepEqual(await fired("live-frozen"), [
      {
        scheduleName: "live-frozen",
        data: "g",
        scheduledFor: iso(t0 + hour),
        firedAt: iso(t0 + hour + 30 * 60 * 1000),
      },
    ]);
    // Advanced to the next occurrence, not skipped forward past it.
    assert.equal((await instance.list())[0]?.nextFireAt, iso(t0 + 2 * hour));
  });

  it("holds the wall-clock time across a daylight-saving boundary in the named zone", async () => {
    // 09:00 every day in Berlin, across the 2030 spring-forward (clocks jump 02:00->03:00 on
    // 2030-03-31). The wall-clock 09:00 holds, so the UTC instant shifts from 08:00 (CET, UTC+1)
    // to 07:00 (CEST, UTC+2) across the boundary. Driven by moving `now` across the transition.
    clockNow = new Date("2030-03-29T00:00:00.000Z");
    const instance = scheduler();

    await instance.schedule({
      name: "berlin",
      spec: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
      data: null,
    });

    for (const at of [
      "2030-03-29T08:00:00.000Z", // 09:00 CET, before the boundary
      "2030-03-30T08:00:00.000Z", // 09:00 CET, still before
      "2030-03-31T07:00:00.000Z", // 09:00 CEST, after the boundary
    ]) {
      clockNow = new Date(at);
      await instance.tick();
    }

    assert.deepEqual(
      (await fired("berlin")).map((f) => f.scheduledFor).sort(),
      ["2030-03-29T08:00:00.000Z", "2030-03-30T08:00:00.000Z", "2030-03-31T07:00:00.000Z"],
      "09:00 Berlin should hold across DST while its UTC instant shifts by an hour",
    );
  });

  it("refuses an invalid cron expression and an unknown time zone at creation, persisting nothing", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();

    await assert.rejects(
      instance.schedule({ name: "bad-expr", spec: { kind: "cron", expr: "not a cron" } }),
      (error: unknown) => error instanceof ScheduleSpecError,
      "an invalid cron expression should throw ScheduleSpecError",
    );
    await assert.rejects(
      instance.schedule({
        name: "bad-zone",
        spec: { kind: "cron", expr: "0 9 * * *", tz: "Mars/Phobos" },
      }),
      (error: unknown) => error instanceof ScheduleSpecError,
      "an unknown time zone should throw ScheduleSpecError",
    );
    await assert.rejects(
      instance.schedule({
        name: "bad-until",
        spec: { kind: "cron", expr: "0 9 * * *" },
        until: "not an instant",
      }),
      (error: unknown) => error instanceof ScheduleSpecError,
      "a malformed until should throw ScheduleSpecError",
    );

    // A refusal persists nothing: none of the three names is armed, so a tick far in the future
    // fires none of them.
    assert.deepEqual(await names(instance), []);
    clockNow = new Date(t0 + 100 * day);
    await instance.tick();
    assert.deepEqual(await fired("bad-expr"), []);
    assert.deepEqual(await fired("bad-zone"), []);
    assert.deepEqual(await fired("bad-until"), []);
  });
});

/**
 * The autonomous timer, observed the same way: nobody calls `tick`, and a Signal on the wire is the
 * proof it fired. Almost every test drives a **fake clock** (`() => clock`) so it does not sleep the
 * real horizon — the timer polls at the small `maxSleepMs`, and advancing the fake clock is what
 * makes a Schedule due. Exactly one, the smoke test, uses a **real** short horizon to prove the
 * capped `setTimeout` truly calls `tick` end to end.
 *
 * Each started Scheduler owns a live timer that would keep this process alive, so every test stops
 * it in a `finally`.
 */
describe("the autonomous firing timer", () => {
  it("fires a real short-horizon Schedule with nobody calling tick (smoke)", async () => {
    // The one real-time test: real clock, an instant ~60ms out, and a cap short enough to poll a
    // few times before it. If the capped setTimeout did not call `tick`, nothing would ever fire.
    await withScheduler(
      () => new Date(),
      async (instance) => {
        await instance.schedule({
          name: "smoke",
          spec: { kind: "once", at: new Date(Date.now() + 60).toISOString() },
          data: { via: "timer" },
        });
        await instance.start();
        await waitUntil(
          "the real timer fires the smoke Schedule",
          async () => (await fired("smoke")).length === 1,
        );
        // Fired exactly once, retired, and with the data intact — the whole path, autonomously.
        const [signal] = await fired("smoke");
        assert.deepEqual(signal?.data, { via: "timer" });
        assert.deepEqual(await names(instance), []);
      },
    );
  });

  it("does not overflow a far-future fire into an immediate one, and fires it once due", async () => {
    // 30 days is 2.592e9 ms — past the ~2.147e9 signed-32-bit `setTimeout` ceiling, so a raw arm
    // would overflow and wake almost immediately. The cap holds the armed delay to `maxSleepMs`.
    let clock = new Date(t0);
    await withScheduler(
      () => clock,
      async (instance) => {
        await instance.schedule({
          name: "far",
          spec: { kind: "once", at: iso(t0 + 30 * day) },
          data: "far",
        });
        await instance.start();

        // Several cap intervals pass with the clock held at t0. An overflow would have fired by now;
        // re-deriving against the wall clock on each wake keeps it silent.
        await delay(80);
        assert.deepEqual(await fired("far"), []);
        assert.deepEqual(await names(instance), ["far"]);

        // Now the instant passes. Because the timer polls at the cap rather than sleeping the whole
        // 30 days, the next wake within ~20ms re-derives it as due and fires it — still no `tick`.
        clock = new Date(t0 + 40 * day);
        await waitUntil(
          "the far Schedule fires once its instant has passed",
          async () => (await fired("far")).length === 1,
        );
        assert.deepEqual(await names(instance), []);
      },
    );
  });

  it("re-arms when a Schedule is created after start, and fires it autonomously", async () => {
    // Started with nothing scheduled, the timer is disarmed. Creating a Schedule must arm it, or it
    // would never fire without a create-time re-arm.
    let clock = new Date(t0);
    await withScheduler(
      () => clock,
      async (instance) => {
        await instance.start();
        await instance.schedule({
          name: "late-arrival",
          spec: { kind: "once", at: iso(t0 + hour) },
          data: "arrived",
        });

        clock = new Date(t0 + 2 * hour);
        await waitUntil(
          "the Schedule created after start fires",
          async () => (await fired("late-arrival")).length === 1,
        );
        assert.deepEqual(await names(instance), []);
      },
    );
  });

  it("keeps firing the survivors after one is cancelled while running", async () => {
    // Cancel re-arms too: the cancelled Schedule never fires, and the one left does — proving the
    // timer was not left pointing only at the row that went away.
    let clock = new Date(t0);
    await withScheduler(
      () => clock,
      async (instance) => {
        await instance.schedule({
          name: "keep",
          spec: { kind: "once", at: iso(t0 + hour) },
          data: 1,
        });
        await instance.schedule({
          name: "drop",
          spec: { kind: "once", at: iso(t0 + hour) },
          data: 2,
        });
        await instance.start();
        assert.equal(await instance.cancel("drop"), true);

        clock = new Date(t0 + 2 * hour);
        await waitUntil(
          "the surviving Schedule fires",
          async () => (await fired("keep")).length === 1,
        );
        assert.deepEqual(await fired("drop"), []);
        assert.deepEqual(await names(instance), []);
      },
    );
  });

  it("cancels the timer on stop, so nothing fires after", async () => {
    let clock = new Date(t0);
    await withScheduler(
      () => clock,
      async (instance) => {
        await instance.schedule({
          name: "post-stop",
          spec: { kind: "once", at: iso(t0 + hour) },
          data: {},
        });
        await instance.start();
        await instance.stop();

        // The instant passes after stop. With the timer cancelled, no wake re-derives it, so it
        // stays unfired however far the clock advances — a real pause proves nothing wakes.
        clock = new Date(t0 + 5 * hour);
        await delay(80);
        assert.deepEqual(await fired("post-stop"), []);
        assert.deepEqual(await names(instance), ["post-stop"]);
      },
    );
  });
});
