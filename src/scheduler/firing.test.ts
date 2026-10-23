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
let agentServer: Component & { readonly fastify: FastifyInstance };

let clockNow: Date;

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;
const day = 24 * hour;

const delay = (ms: number) => new Promise((resume) => setTimeout(resume, ms));

const t0 = new Date("2030-06-01T12:00:00.000Z").getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

before(async () => {
  database = await createTestDatabase("scheduler_firing");
  db = database.db;
  await applySchema(db, signalsSchema, schedulerSchema);

  agentServer = serverComponent(Fastify(), nowhere);
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

beforeEach(async () => {
  await db.handle({ schedules }).delete(schedules);
});

function scheduler(): Scheduler {
  return createScheduler({ db, worker, now: () => clockNow, logger: silent });
}

async function restart(): Promise<Scheduler> {
  const instance = scheduler();
  await instance.start();
  await instance.stop();
  return instance;
}

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

async function names(instance: Scheduler): Promise<string[]> {
  return (await instance.list()).map((schedule) => schedule.name);
}

const cappedMs = 20;

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

    await instance.tick();
    assert.deepEqual(await fired("followup"), []);
    assert.deepEqual(await names(instance), ["followup"]);

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
    assert.deepEqual(await names(instance), []);

    await instance.tick();
    assert.equal((await fired("followup")).length, 1);
  });

  it("never fires when its instant is already past at creation, and is not armed", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();

    const outcome = await instance.schedule({
      name: "stale",
      spec: { kind: "once", at: iso(t0 - hour) },
      data: { note: "too late" },
    });
    assert.equal(outcome.created, false);
    assert.equal(outcome.schedule.nextFireAt, null);
    assert.deepEqual(await names(instance), []);

    clockNow = new Date(t0 + 10 * hour);
    await instance.tick();
    assert.deepEqual(await fired("stale"), []);
  });

  it("fires late, once, when now jumps past a future instant between ticks", async () => {
    clockNow = new Date(t0);
    const instance = scheduler();
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

    const second = await instance.schedule({
      name: "digest",
      spec: { kind: "once", at: iso(t0 + 3 * hour) },
      data: { revision: 2 },
    });
    assert.equal(second.created, false);
    assert.equal(second.schedule.nextFireAt, iso(t0 + 3 * hour));

    const listed = await instance.list();
    assert.equal(listed.filter((schedule) => schedule.name === "digest").length, 1);
    const digest = listed.find((schedule) => schedule.name === "digest");
    assert.deepEqual(digest?.spec, { kind: "once", at: iso(t0 + 3 * hour) });
    assert.deepEqual(digest?.data, { revision: 2 });

    clockNow = new Date(t0 + 2 * hour);
    await instance.tick();
    assert.deepEqual(await fired("digest"), []);

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
    assert.equal(await instance.cancel("abandon"), false);
    assert.equal(await instance.cancel("never-existed"), false);

    clockNow = new Date(t0 + 2 * hour);
    await instance.tick();
    assert.deepEqual(await fired("abandon"), []);
  });
});

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

    const outcome = await instance.schedule({
      name: "hourly",
      spec: { kind: "cron", expr: "0 * * * *" },
      data: { check: "health" },
    });
    assert.equal(outcome.created, true);
    assert.deepEqual(outcome.schedule.spec, { kind: "cron", expr: "0 * * * *", tz: "UTC" });
    assert.equal(outcome.schedule.nextFireAt, iso(t0 + hour));

    await instance.tick();
    assert.deepEqual(await fired("hourly"), []);

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
    assert.deepEqual(await names(instance), ["bounded"]);

    clockNow = new Date(t0 + 2 * hour);
    await instance.tick();
    assert.deepEqual(await names(instance), []);
    assert.deepEqual((await fired("bounded")).map((f) => f.scheduledFor).sort(), [
      iso(t0 + hour),
      iso(t0 + 2 * hour),
    ]);

    clockNow = new Date(t0 + 5 * hour);
    await instance.tick();
    assert.equal((await fired("bounded")).length, 2);
  });

  it("re-derives forward on boot, so a restart skips every missed occurrence — one or many", async () => {
    clockNow = new Date(t0);
    const armed = scheduler();
    await armed.schedule({ name: "outage", spec: { kind: "cron", expr: "0 * * * *" }, data: "d" });

    clockNow = new Date(t0 + hour + 30 * 60 * 1000);
    const afterOne = await restart();
    assert.deepEqual(await fired("outage"), [], "a single missed occurrence must not fire on boot");
    assert.equal((await afterOne.list())[0]?.nextFireAt, iso(t0 + 2 * hour));

    clockNow = new Date(t0 + 10 * hour + 15 * 60 * 1000);
    const afterMany = await restart();
    assert.deepEqual(await fired("outage"), [], "many missed occurrences must not fire on boot");
    assert.equal((await afterMany.list())[0]?.nextFireAt, iso(t0 + 11 * hour));

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
    clockNow = new Date(t0);
    const instance = scheduler();
    await instance.schedule({
      name: "live-frozen",
      spec: { kind: "cron", expr: "0 * * * *" },
      data: "g",
    });

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
    assert.equal((await instance.list())[0]?.nextFireAt, iso(t0 + 2 * hour));
  });

  it("holds the wall-clock time across a daylight-saving boundary in the named zone", async () => {
    clockNow = new Date("2030-03-29T00:00:00.000Z");
    const instance = scheduler();

    await instance.schedule({
      name: "berlin",
      spec: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
      data: null,
    });

    for (const at of [
      "2030-03-29T08:00:00.000Z",
      "2030-03-30T08:00:00.000Z",
      "2030-03-31T07:00:00.000Z",
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

    assert.deepEqual(await names(instance), []);
    clockNow = new Date(t0 + 100 * day);
    await instance.tick();
    assert.deepEqual(await fired("bad-expr"), []);
    assert.deepEqual(await fired("bad-zone"), []);
    assert.deepEqual(await fired("bad-until"), []);
  });
});

describe("the autonomous firing timer", () => {
  it("fires a real short-horizon Schedule with nobody calling tick (smoke)", async () => {
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
        const [signal] = await fired("smoke");
        assert.deepEqual(signal?.data, { via: "timer" });
        assert.deepEqual(await names(instance), []);
      },
    );
  });

  it("does not overflow a far-future fire into an immediate one, and fires it once due", async () => {
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

        await delay(80);
        assert.deepEqual(await fired("far"), []);
        assert.deepEqual(await names(instance), ["far"]);

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

        clock = new Date(t0 + 5 * hour);
        await delay(80);
        assert.deepEqual(await fired("post-stop"), []);
        assert.deepEqual(await names(instance), ["post-stop"]);
      },
    );
  });
});
