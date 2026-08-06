/**
 * The Scheduler: the Component that owns Schedules and emits a Signal when one matures.
 *
 * A Producer and a Component. One call builds it, and it registers its Agent routes on the server
 * it is handed. The firing core is the awaitable `tick` due-check, plus `schedule`, an upsert by
 * name, and `list` and `cancel`. Over that core, `start` arms one self-correcting timer that calls
 * the same `tick`, and `stop` cancels it. Passing no Agent server switches the HTTP surface off.
 *
 * The timer is one `setTimeout`, armed to the earliest Schedule's next fire but never for longer
 * than `maxSleepMs`. Every wake re-derives due-ness against the wall clock rather than trusting the
 * elapsed delay. The cap corrects two failures. A delay above about 24.85 days overflows a signed
 * 32-bit `setTimeout` and fires at once. And any multi-hour arm drifts across an NTP correction, a
 * suspend or a DST jump.
 *
 * Three things about it are decisions rather than omissions. The Signal `kind` is fixed. So the
 * agent's whole scheduling power is one sentence: wake the deployment's schedule Handler with
 * context I chose. Firing is exactly-once, because the emit and the retirement share one
 * transaction. And a missed fire is skipped, because `start` re-derives every row forward from
 * `now`. A daily digest after a week down fires next rather than seven times.
 */

import type { FastifyInstance } from "fastify";
import type { Component } from "../components.ts";
import type { Db } from "../db/index.ts";
import { defaultLogger, type Logger } from "../logging.ts";
import type { SignalWorker } from "../signals/worker.ts";
import { scheduleRoutes } from "./routes.ts";
import {
  advanceSchedule,
  asScheduleRecord,
  deleteSchedule,
  earliestFireAt,
  matureOf,
  nextFireOf,
  nextFireOfRow,
  parseUntil,
  type ScheduleFiredRecord,
  type ScheduleInput,
  type ScheduleOutcome,
  type ScheduleRecord,
  scheduleRecord,
  scheduleRow,
  selectDue,
  selectSchedule,
  selectSchedules,
  upsertSchedule,
} from "./schedules.ts";
import { schedulerTables, type schedules } from "./schema.ts";

/**
 * The `kind` of the Signal every matured Schedule emits, and half of the Signal contract.
 *
 * The other half is that the payload is the `ScheduleFiredRecord`, flat. So a Handler is written
 * `SignalHandler<ScheduleFiredRecord>` and an Operator's map needs no string literal.
 *
 * A constant rather than a construction option. The creator never chooses the `kind`, which is the
 * cap this Component puts on the agent's power. A `kind` with no Handler registered leaves a stored
 * Schedule firing into a permanently failed Signal.
 */
export const scheduleFiredKind = "saf_schedule_fired";

/**
 * How long the firing timer sleeps at most when the Operator names no `maxSleepMs`.
 *
 * Roughly a minute. That is comfortably under the 24.85-day `setTimeout` ceiling, and short enough
 * to bound drift across a clock change. No correctness rests on the exact number.
 */
const defaultMaxSleepMs = 60_000;

/** Everything `createScheduler` needs: the Db, the Signal Worker, and four defaults. */
export type SchedulerOptions = {
  readonly db: Db;
  /**
   * The Signal Worker a matured Schedule emits into.
   *
   * Required: a Scheduler that woke nobody would be a Producer that produces nothing. The emit
   * shares the fire's transaction, which is what makes retiring a spent one-shot and announcing it
   * one atomic act.
   */
  readonly worker: SignalWorker;
  /**
   * The clock the due-check reads. Defaults to real time.
   *
   * Injected so timing is deterministic in tests: set `now`, await `tick`, assert what fired, with
   * no sleeping.
   */
  readonly now?: () => Date;
  /**
   * The longest the firing timer sleeps before it wakes and re-derives due-ness, in milliseconds.
   * Defaults to roughly a minute.
   *
   * A cap for correctness rather than tuning. It keeps the armed delay under the 24.85-day
   * `setTimeout` ceiling. It also bounds the drift a long arm accrues across an NTP step, a suspend
   * or a DST jump.
   *
   * There is no correctness in the exact value. Lower it and the timer polls more often. Raise it
   * past the ceiling and a far Schedule overflows into an immediate wake.
   */
  readonly maxSleepMs?: number;
  /**
   * The Agent server, if the agent is to create, list, read and cancel Schedules over HTTP.
   *
   * Given one, the constructor registers `PUT`, `GET` and `DELETE` on `/schedules` and
   * `/schedules/:name` at no prefix. Omit it and nothing is registered anywhere. That is the
   * disable switch. It stops the agent waking itself and touching the Operator's own Schedules. The
   * programmatic interface below stays available regardless.
   *
   * Structural, and asks for nothing but the Fastify instance, so what satisfies it is what
   * `serverComponent` returns.
   */
  readonly agentServer?: {
    readonly fastify: FastifyInstance;
  };
  /** Defaults to a `pino` instance on stdout. */
  readonly logger?: Logger;
};

/**
 * What the constructor answers with: the interface the Operator always has.
 *
 * `schedule`, `list` and `cancel` are the management surface, and they work whether or not the
 * Agent routes are switched on. `tick` is the due-check the internal timer also calls, exposed as
 * the testing seam. `start` arms that timer and `stop` cancels it.
 */
export type Scheduler = Component & {
  /**
   * Creates a Schedule, or updates the one already under this name.
   *
   * An upsert, so a retry or a revised plan converges to one Schedule rather than accumulating
   * duplicates. It answers whether it created or updated, and with the resulting record.
   *
   * A `once` whose instant is already past has no future fire. It is not armed, and any existing
   * row under the name is removed. The record comes back with a `null` `nextFireAt`.
   *
   * @throws `ScheduleSpecError` if a cron `expr` is invalid, a `tz` unknown, or an `until`
   *   malformed. Nothing is written first.
   */
  schedule(input: ScheduleInput): Promise<ScheduleOutcome>;

  /** Every Schedule, ascending by next fire then name, so an Operator sees what is arranged. */
  list(): Promise<ScheduleRecord[]>;

  /**
   * Cancels a Schedule by name, and answers whether one was there.
   *
   * So a caller learns that a name was already gone. It is not told that it stopped something which
   * did not exist.
   */
  cancel(name: string): Promise<boolean>;

  /**
   * Fires every Schedule matured at the current `now`, and resolves when none is left.
   *
   * Each fire emits one Signal and retires the spent one-shot in one transaction. This is the
   * awaitable seam the timer calls and the tests drive directly. Drive it serially: await one
   * `tick` before the next, which is how the timer calls it too.
   */
  tick(): Promise<void>;

  /**
   * Re-derives every Schedule's next fire forward from `now`, then arms the firing timer.
   *
   * The re-derivation is what makes a restart clean. The persisted `at` is display-only and is not
   * trusted as a trigger across a boot. So an occurrence that fell during an outage is dropped for
   * a spent `once` and jumped for a `cron`. Only a continuously-live process frozen through a fire
   * time fires once late, because no boot ran.
   *
   * The timer is a single capped `setTimeout`, re-armed after every fire and on every `schedule`
   * and `cancel`. A second `start` is a no-op rather than a second timer.
   */
  start(): Promise<void>;

  /**
   * Cancels the firing timer, so no fire begins during or after the worker's drain.
   *
   * A fire already committed is a pending Signal the next start's worker drains. What `stop`
   * guarantees is that no new fire begins once it returns. A second `stop`, or a `stop` before any
   * `start`, finds no timer and does nothing.
   */
  stop(): Promise<void>;
};

/**
 * Builds the Scheduler and registers its Agent routes when an Agent server is given.
 *
 * Nothing here connects, listens or applies DDL. Put the result in the Gateway's record under a key
 * of your own, ahead of the Signal Worker.
 *
 * @example
 * Built in `extend`, and then given the Operator's own boot-time Schedule.
 * ```ts
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import type { ScheduleFiredRecord } from "shared-agent-framework/scheduler";
 * import { createScheduler, scheduleFiredKind } from "shared-agent-framework/scheduler";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   agentListen: { host: "127.0.0.1", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   // No `agentServer` here, so the agent cannot reach the Schedules at all.
 *   extend: ({ db, worker }) => ({ scheduler: createScheduler({ db, worker }) }),
 *   handlers: () => ({
 *     [scheduleFiredKind]: templateHandler<ScheduleFiredRecord>({
 *       template: new URL("./prompts/digest.hbs", import.meta.url),
 *       session: (signal) => signal.payload.scheduleName,
 *       data: (signal) => signal.payload,
 *     }),
 *   }),
 * });
 *
 * await gateway.start();
 *
 * const { scheduler } = gateway.components;
 * const { created, schedule } = await scheduler.schedule({
 *   name: "morning-digest",
 *   spec: { kind: "cron", expr: "0 7 * * *", tz: "Europe/Berlin" },
 * });
 * console.log(created, schedule.nextFireAt);
 * ```
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  // The Component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(schedulerTables);
  const now = options.now ?? (() => new Date());
  const maxSleepMs = options.maxSleepMs ?? defaultMaxSleepMs;
  const log = options.logger ?? defaultLogger();

  /** Whether the timer is armed to run, flipped by `start` and `stop` and read by `arm`. */
  let started = false;
  /** The one live firing timer, or `undefined` when nothing is armed. There is only ever one. */
  let timer: NodeJS.Timeout | undefined;

  /** Cancels the live timer, if any. Safe to call when there is none. */
  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  /**
   * Fires every Schedule matured at the current `now`, one transaction each, and resolves when none
   * is left. The awaitable seam the timer calls and the tests drive directly.
   */
  async function tick(): Promise<void> {
    const due = await selectDue(handle, now());
    for (const row of due) await fire(row);
  }

  /**
   * Re-derives every Schedule's next fire strictly forward from `now`, once, before the timer arms.
   *
   * This is what makes a restart clean. The persisted `at` is not trusted as a trigger across a
   * boot. An outage leaves it in the past. Firing it would replay an occurrence that fell while the
   * process was down. A `cron` moves to its next strictly future occurrence, and is retired if that
   * passes `until`. A `once` is dropped if its instant has passed. Nothing in the past is ever
   * enumerated, so however many occurrences were missed, none fires.
   *
   * Each row is re-derived on the Component's own handle rather than in one transaction. There is
   * nothing here to keep atomic. Every step is an idempotent forward derivation, so a boot that
   * dies half-way re-derives the rest on the next start.
   */
  async function deriveForward(): Promise<void> {
    const at = now();
    for (const row of await selectSchedules(handle)) {
      const next = nextFireOfRow(row, at);
      if (next === undefined) {
        await deleteSchedule(handle, row.name);
      } else if (row.at === null || next.getTime() !== row.at.getTime()) {
        await advanceSchedule(handle, row.name, next);
      }
    }
  }

  /**
   * Arms the single timer to the earliest Schedule's next fire, capped at `maxSleepMs`.
   *
   * With nothing scheduled it stays disarmed, and a later `schedule` re-arms it. The cap is the
   * whole overflow and drift guard. The armed delay never exceeds `maxSleepMs`, and each wake
   * re-derives against `now` rather than trusting how long it slept.
   *
   * The `clearTimer` after the await is deliberate. Two arms racing on the pool each clear the
   * other's handle before assigning. So one live timer survives rather than two.
   */
  async function arm(): Promise<void> {
    if (!started) {
      clearTimer();
      return;
    }
    const earliest = await earliestFireAt(handle);
    clearTimer();
    if (!started) return;
    if (earliest === undefined) return;
    const delay = Math.min(maxSleepMs, Math.max(0, earliest.getTime() - now().getTime()));
    timer = setTimeout(() => {
      void onWake();
    }, delay);
  }

  /**
   * One wake: fire everything the wall clock now says is due, then re-arm for the next earliest.
   *
   * A Db error here is logged and swallowed rather than allowed to kill the process. A fire's own
   * emit is transactional, so the only thing that reaches here is a failed read. The next wake
   * retries it.
   */
  async function onWake(): Promise<void> {
    timer = undefined; // The one-shot handle has fired and is spent.
    if (!started) return;
    try {
      await tick();
    } catch (error) {
      log.error({ err: error }, "the Scheduler's firing tick failed, and retries on the next wake");
    }
    await arm();
  }

  /**
   * Matures one due Schedule: announce its Signal, and advance or retire it, in one transaction.
   *
   * So a crash between the two is impossible. `matureOf` decides both. A `once` announces its
   * instant and retires. A `cron` announces its stored occurrence and advances to the next one
   * strictly after `now`, retiring if that passes `until`.
   *
   * A stored occurrence is announced late here only when the process was continuously live and
   * frozen through the fire time. A restart re-derives every row forward first, so a booted
   * Scheduler never reaches this with a stale `at`. `firedAt` is the Scheduler's own `now`, so a
   * Handler can compare it to `scheduledFor` and judge lateness.
   */
  async function fire(row: typeof schedules.$inferSelect): Promise<void> {
    const firedAt = now();
    const maturation = matureOf(row, firedAt);
    await options.db.tx(async (tx) => {
      if (maturation.emit) {
        const payload: ScheduleFiredRecord = {
          scheduleName: row.name,
          data: row.data,
          scheduledFor: maturation.scheduledFor.toISOString(),
          firedAt: firedAt.toISOString(),
        };
        await options.worker.emit(tx, { kind: scheduleFiredKind, payload });
      }
      if (maturation.next === undefined) {
        await deleteSchedule(tx, row.name);
      } else {
        await advanceSchedule(tx, row.name, maturation.next);
      }
    });
    if (maturation.emit) {
      log.info({ schedule: row.name, kind: scheduleFiredKind }, "Schedule fired");
    }
  }

  /**
   * Creates a Schedule or updates the one already under the name.
   *
   * The upsert the programmatic interface and the agent's `PUT` both go through. Deliberately
   * lenient about a spent create. A `once` already in the past resolves to no future fire. So any
   * row under the name is removed, and the answer carries a `null` `nextFireAt`.
   *
   * The Agent route refuses that same case loudly with `assertCreatable` first. An Operator
   * re-running a boot-time declaration converges here instead of crashing.
   */
  async function doSchedule(input: ScheduleInput): Promise<ScheduleOutcome> {
    const at = now();
    // A malformed `until`, a bad cron `expr` or an unknown `tz` throws `ScheduleSpecError` here,
    // before anything is written. `until` is a cron bound only: a `once` bounds itself by firing
    // once, so its `until` is ignored.
    const until =
      input.spec.kind === "cron" && input.until !== undefined ? parseUntil(input.until) : undefined;
    const next = nextFireOf(input.spec, at, until);
    const data = input.data ?? null;
    if (next === undefined) {
      // No future fire: spent. Honour the upsert by removing any row under this name, so a name
      // that mapped to a live Schedule maps to nothing rather than to a stale one.
      await deleteSchedule(handle, input.name);
      // The removed row may have been the earliest, so the timer's target changed.
      await arm();
      return { created: false, schedule: scheduleRecord(input, undefined, until, data) };
    }
    const { created } = await upsertSchedule(handle, scheduleRow(input, next, until, data));
    // A new or moved fire may now be the earliest, so re-derive the timer against it.
    await arm();
    // The same shape `list` reads a row through, so this answer and a later list agree
    // byte-for-byte on the same Schedule without reading the row back.
    return { created, schedule: scheduleRecord(input, next, until, data) };
  }

  /** Every live Schedule as a read model, ascending by next fire then name, bounded by `limit`. */
  async function listRecords(limit?: number): Promise<ScheduleRecord[]> {
    const rows = await selectSchedules(handle, limit);
    return rows.map(asScheduleRecord);
  }

  /** One live Schedule by name as a read model, or `undefined` when the name addresses none. */
  async function readRecord(name: string): Promise<ScheduleRecord | undefined> {
    const row = await selectSchedule(handle, name);
    return row === undefined ? undefined : asScheduleRecord(row);
  }

  /** Cancels a Schedule by name, re-arming the timer, and answers whether one was there. */
  async function doCancel(name: string): Promise<boolean> {
    const removed = await deleteSchedule(handle, name);
    // Cancelling may have removed the earliest fire, so re-derive the timer's target.
    await arm();
    return removed;
  }

  // The Agent routes, registered only when a server is given: that is the disable switch. Not
  // awaited: Fastify defers a plugin until the server is ready, so this is a registration made at
  // construction and loaded at `listen`. The routes reach this Component through these operations
  // and its own clock.
  options.agentServer?.fastify.register(
    scheduleRoutes({
      now,
      schedule: doSchedule,
      list: listRecords,
      read: readRecord,
      cancel: doCancel,
    }),
  );

  return {
    schedule: doSchedule,

    list: () => listRecords(),

    cancel: doCancel,

    tick,

    async start() {
      // A second `start` re-arming would be harmless, but the Component contract is one lifecycle:
      // arm once, and let `schedule`, `cancel` and each wake re-derive from there.
      if (started) return;
      started = true;
      // Boot: re-derive every row's next fire forward from now before arming, so a stale `at` left
      // by an outage is recomputed rather than fired.
      await deriveForward();
      await arm();
    },

    async stop() {
      // Flip the flag before clearing, so a wake already queued for this tick of the event loop
      // finds `started` false and does nothing rather than firing after stop.
      started = false;
      clearTimer();
    },
  };
}
