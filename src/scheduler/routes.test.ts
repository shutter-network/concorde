/**
 * The Scheduler's agent-facing routes, observed over `fastify.inject` — what the surface answers on
 * the wire, and never the Scheduler's private state. Prior art: `src/signals/routes.test.ts`, which
 * injects rather than opening a socket and treats what the surface answers as the subject.
 *
 * Nothing here starts the Scheduler's timer or the Worker: the routes operate on the tables directly,
 * so every case is a request in and a response out against real PostgreSQL. The clock is injected and
 * fixed, so a past-`at` refusal and a `nextFireAt` are both deterministic. A database of this file's
 * own, because no two test files share one.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { type Component, serverComponent } from "../components.ts";
import type { Db } from "../db/index.ts";
import type { Logger } from "../logging.ts";
import { createSignalWorker, type SignalWorker } from "../signals/worker.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { createScheduler } from "./scheduler.ts";
import type { ScheduleRecord } from "./schedules.ts";
import { schedules } from "./schema.ts";

let database: TestDatabase;
let db: Db;
let worker: SignalWorker;
/** The Agent server the Scheduler's routes land on, injected against and never started. */
let agentServer: Component & { readonly fastify: FastifyInstance };

/** The clock the Scheduler reads, fixed here so every instant is a legible offset and the past is the past. */
let clockNow: Date;

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

/** Nothing here starts the worker or the timer, so nothing should be printed by one. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const hour = 60 * 60 * 1000;

/** A fixed origin, so every instant in a test is a legible offset from it. */
const t0 = new Date("2030-06-01T12:00:00.000Z").getTime();
const iso = (ms: number) => new Date(ms).toISOString();

before(async () => {
  database = await createTestDatabase("scheduler_routes");
  db = database.db;

  agentServer = serverComponent(Fastify(), nowhere);

  // A real Worker, unstarted: the Scheduler requires one to emit into, and constructing it registers
  // the signals migrations this file also applies. It is given no Agent server, so the only routes on
  // `agentServer` are the Scheduler's.
  worker = createSignalWorker({ db, runtime: fakeRuntime(), handlers: {}, logger: silent });

  // Constructed for its side effect: given the Agent server, it registers the routes this file
  // injects against. The programmatic handle is not needed here — the wire is the subject.
  createScheduler({ db, worker, agentServer, now: () => clockNow, logger: silent });

  await db.migrate();
});

after(async () => {
  await database.drop();
});

beforeEach(async () => {
  clockNow = new Date(t0);
  // A fresh, empty table each test: a Schedule with no future fire is a deleted row, so clearing is
  // deleting every one there is.
  await db.handle({ schedules }).delete(schedules);
});

/** A create-or-update over the wire. `body` is the raw JSON, so a test can send an unknown field. */
function put(name: string, body: unknown) {
  return agentServer.fastify.inject({
    method: "PUT",
    url: `/schedules/${name}`,
    payload: body as object,
  });
}
function get(path: string) {
  return agentServer.fastify.inject({ method: "GET", url: path });
}
function del(path: string) {
  return agentServer.fastify.inject({ method: "DELETE", url: path });
}

describe("PUT /schedules/:name upserts", () => {
  it("answers 201 with the read model on create and 200 on update, the same record shape", async () => {
    const created = await put("followup", {
      spec: { kind: "once", at: iso(t0 + hour) },
      data: { note: "call back" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdRecord: ScheduleRecord = {
      name: "followup",
      spec: { kind: "once", at: iso(t0 + hour) },
      data: { note: "call back" },
      until: null,
      nextFireAt: iso(t0 + hour),
    };
    assert.deepEqual(created.json<ScheduleRecord>(), createdRecord);

    // Same name again: an update, 200, and the change is not dropped — the new instant is what comes back.
    const updated = await put("followup", {
      spec: { kind: "once", at: iso(t0 + 2 * hour) },
      data: { note: "later" },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json<ScheduleRecord>(), {
      name: "followup",
      spec: { kind: "once", at: iso(t0 + 2 * hour) },
      data: { note: "later" },
      until: null,
      nextFireAt: iso(t0 + 2 * hour),
    });

    // And there is exactly one Schedule under the name, not two.
    const list = (await get("/schedules")).json<{ schedules: ScheduleRecord[] }>().schedules;
    assert.equal(list.filter((s) => s.name === "followup").length, 1);
  });

  it("creates a cron with a resolved zone and a bound, and defaults an omitted zone to UTC", async () => {
    const withZone = await put("digest", {
      spec: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
      until: iso(t0 + 100 * hour),
    });
    assert.equal(withZone.statusCode, 201, withZone.body);
    const record = withZone.json<ScheduleRecord>();
    assert.deepEqual(record.spec, { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" });
    assert.equal(record.until, iso(t0 + 100 * hour));
    // The next 09:00 Berlin strictly after noon UTC on 2030-06-01 is 2030-06-02 09:00 Berlin = 07:00Z.
    assert.equal(record.nextFireAt, "2030-06-02T07:00:00.000Z");

    const noZone = await put("hourly", { spec: { kind: "cron", expr: "0 * * * *" } });
    assert.equal(noZone.statusCode, 201, noZone.body);
    assert.deepEqual(noZone.json<ScheduleRecord>().spec, {
      kind: "cron",
      expr: "0 * * * *",
      tz: "UTC",
    });
  });

  it("stores null data when the field is omitted", async () => {
    const created = await put("bare", { spec: { kind: "once", at: iso(t0 + hour) } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json<ScheduleRecord>().data, null);
  });
});

describe("the read model round-trips over HTTP without serializer drift", () => {
  it("reads back byte-for-byte what a create answered, for a once and a cron", async () => {
    await put("once_rt", { spec: { kind: "once", at: iso(t0 + hour) }, data: [1, 2, 3] });
    const once = await get("/schedules/once_rt");
    assert.equal(once.statusCode, 200);
    const onceExpected: ScheduleRecord = {
      name: "once_rt",
      spec: { kind: "once", at: iso(t0 + hour) },
      data: [1, 2, 3],
      until: null,
      nextFireAt: iso(t0 + hour),
    };
    assert.deepEqual(once.json<ScheduleRecord>(), onceExpected);

    await put("cron_rt", {
      spec: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      data: { k: "v" },
    });
    const cron = await get("/schedules/cron_rt");
    assert.equal(cron.statusCode, 200);
    const cronExpected: ScheduleRecord = {
      name: "cron_rt",
      spec: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      data: { k: "v" },
      until: null,
      nextFireAt: iso(t0 + hour),
    };
    assert.deepEqual(cron.json<ScheduleRecord>(), cronExpected);
  });
});

describe("GET /schedules lists live Schedules, soonest fire first", () => {
  it("answers a capped envelope ascending by nextFireAt, and refuses a bad or unknown query", async () => {
    await put("third", { spec: { kind: "once", at: iso(t0 + 3 * hour) } });
    await put("first", { spec: { kind: "once", at: iso(t0 + 1 * hour) } });
    await put("second", { spec: { kind: "once", at: iso(t0 + 2 * hour) } });

    const list = (await get("/schedules")).json<{ schedules: ScheduleRecord[] }>().schedules;
    assert.deepEqual(
      list.map((s) => s.name),
      ["first", "second", "third"],
    );
    assert.deepEqual(
      list.map((s) => s.nextFireAt),
      [iso(t0 + hour), iso(t0 + 2 * hour), iso(t0 + 3 * hour)],
    );

    // The limit caps the page.
    assert.equal(
      (await get("/schedules?limit=2")).json<{ schedules: ScheduleRecord[] }>().schedules.length,
      2,
    );

    // A bad limit and an unknown or scoping parameter are each a 400.
    for (const query of ["limit=0", "limit=201", "limit=nine", "creator=agent", "name=first"]) {
      assert.equal((await get(`/schedules?${query}`)).statusCode, 400, query);
    }
  });
});

describe("GET and DELETE address one Schedule by name", () => {
  it("reads one, 404s an unknown name, and 400s a malformed one", async () => {
    await put("known", { spec: { kind: "once", at: iso(t0 + hour) } });

    assert.equal((await get("/schedules/known")).statusCode, 200);
    assert.equal((await get("/schedules/absent")).statusCode, 404);
    // A name outside the url-safe charset is refused before it reaches PostgreSQL.
    assert.equal((await get("/schedules/has%20space")).statusCode, 400);
    assert.equal((await get("/schedules/bad!name")).statusCode, 400);
    // A single record takes no query parameters.
    assert.equal((await get("/schedules/known?creator=agent")).statusCode, 400);
  });

  it("cancels with 204, 404s an unknown name, and 400s a malformed one", async () => {
    await put("doomed", { spec: { kind: "once", at: iso(t0 + hour) } });

    const cancelled = await del("/schedules/doomed");
    assert.equal(cancelled.statusCode, 204);
    assert.equal(cancelled.body, "");
    // Gone afterwards, and cancelling again is an honest 404 rather than an idempotent 204.
    assert.equal((await get("/schedules/doomed")).statusCode, 404);
    assert.equal((await del("/schedules/doomed")).statusCode, 404);

    assert.equal((await del("/schedules/never")).statusCode, 404);
    assert.equal((await del("/schedules/has%20space")).statusCode, 400);
    assert.equal((await del("/schedules/known?creator=agent")).statusCode, 400);
  });
});

describe("the two validation layers each answer 400", () => {
  it("the schema layer: unknown fields, unknown kind, and a once carrying a cron-only until", async () => {
    // An unknown top-level field, which removeAdditional would otherwise strip silently.
    assert.equal(
      (await put("x", { spec: { kind: "once", at: iso(t0 + hour) }, bogus: 1 })).statusCode,
      400,
    );
    // An unknown field inside the spec.
    assert.equal(
      (await put("x", { spec: { kind: "once", at: iso(t0 + hour), bogus: 1 } })).statusCode,
      400,
    );
    // An unknown kind, refused by the oneOf.
    assert.equal(
      (await put("x", { spec: { kind: "weekly", at: iso(t0 + hour) } })).statusCode,
      400,
    );
    // A once carrying a cron-only until.
    assert.equal(
      (await put("x", { spec: { kind: "once", at: iso(t0 + hour) }, until: iso(t0 + hour) }))
        .statusCode,
      400,
    );
    // A malformed path name on a PUT.
    assert.equal(
      (await put("has%20space", { spec: { kind: "once", at: iso(t0 + hour) } })).statusCode,
      400,
    );
    // A query parameter on a write is refused too, not quietly ignored.
    assert.equal(
      (
        await agentServer.fastify.inject({
          method: "PUT",
          url: "/schedules/scoped?creator=agent",
          payload: { spec: { kind: "once", at: iso(t0 + hour) } },
        })
      ).statusCode,
      400,
    );
    // None of these stored anything.
    assert.deepEqual(
      (await get("/schedules")).json<{ schedules: ScheduleRecord[] }>().schedules,
      [],
    );
  });

  it("the handler layer: an invalid expr, an unknown tz, a malformed or past at, a malformed until", async () => {
    const cases: Array<[string, unknown]> = [
      ["invalid cron expr", { spec: { kind: "cron", expr: "not a cron", tz: "UTC" } }],
      ["unknown tz", { spec: { kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" } }],
      ["malformed at", { spec: { kind: "once", at: "not-an-instant" } }],
      ["past at", { spec: { kind: "once", at: iso(t0 - hour) } }],
      [
        "malformed until",
        { spec: { kind: "cron", expr: "0 9 * * *", tz: "UTC" }, until: "not-an-instant" },
      ],
    ];
    for (const [label, body] of cases) {
      const response = await put("candidate", body);
      assert.equal(response.statusCode, 400, `${label}: ${response.body}`);
      // The refusal is the shared error shape, carrying a message that names the bad value.
      const refusal = response.json<{ statusCode: number; error: string; message: string }>();
      assert.equal(refusal.statusCode, 400);
      assert.equal(refusal.error, "Bad Request");
      assert.ok(refusal.message.length > 0, label);
    }
    // A handler-layer 400 never mutated: nothing was stored under the name it refused.
    assert.equal((await get("/schedules/candidate")).statusCode, 404);
  });
});

describe("the disable switch", () => {
  it("registers no routes when no Agent server is given, and the programmatic interface still works", async () => {
    const bare = serverComponent(Fastify(), nowhere);
    const off = createScheduler({ db, worker, now: () => clockNow });

    // Nothing was registered on a server the off Scheduler was not given: every route is a 404.
    assert.equal(
      (
        await bare.fastify.inject({
          method: "PUT",
          url: "/schedules/x",
          payload: { spec: { kind: "once", at: iso(t0 + hour) } },
        })
      ).statusCode,
      404,
    );
    assert.equal((await bare.fastify.inject({ method: "GET", url: "/schedules" })).statusCode, 404);

    // Yet the programmatic interface is fully available with the server absent.
    const outcome = await off.schedule({
      name: "operator_standing",
      spec: { kind: "once", at: iso(t0 + hour) },
    });
    assert.equal(outcome.created, true);
    assert.equal(outcome.schedule.nextFireAt, iso(t0 + hour));
    assert.ok((await off.list()).some((s) => s.name === "operator_standing"));
    assert.equal(await off.cancel("operator_standing"), true);
    assert.equal(await off.cancel("operator_standing"), false);
  });
});
