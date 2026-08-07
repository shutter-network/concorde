/**
 * The Component itself: the timer, the fire, and the four operations both creators reach the table
 * through.
 *
 * Three shapes here are load-bearing and none is an optimisation.
 *
 * The timer is one `setTimeout` and never a set of them. It is armed to the earliest Schedule's
 * next fire, capped at `maxSleepMs`, and every wake re-derives due-ness against the wall clock
 * instead of trusting how long it slept. The cap is what corrects two failures at once: a delay
 * above about 24.85 days overflows a signed 32-bit `setTimeout` and fires immediately, and any
 * multi-hour arm drifts across an NTP step, a suspend or a DST jump. Do not raise it past the
 * ceiling and do not trust an elapsed delay.
 *
 * A fire's emit and the row's advance or delete share one transaction, so no crash can announce an
 * occurrence twice or retire one that was never announced. Splitting them is the thing to refuse.
 *
 * `start` re-derives every row forward before arming. That is what makes a restart clean, and it is
 * why nothing has to enumerate the occurrences an outage covered. `deriveForward` is deliberately
 * not one transaction: every step is an idempotent forward derivation, so a boot that dies half way
 * finishes the rest on the next one.
 */

import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import type { Component } from "../gateway/components.ts";
import { defaultLogger, type Logger } from "../logging/logging.ts";
import type { SignalWorker } from "../signals/worker.ts";
import { scheduleRoutes } from "./routes.ts";
import {
  advanceSchedule,
  asScheduleRecord,
  assertScheduleName,
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
 * The `kind` every matured Schedule emits under, and half of the Signal contract. The other half is
 * that the payload is the fired record, flat.
 *
 * A constant and not a construction option, which is the cap this component puts on the agent's
 * power: whatever the agent arranges, it wakes the one Handler the Operator wrote. Register that
 * Handler. A Schedule that fires with none registered under this `kind` leaves a Signal that fails
 * on every attempt.
 */
export const scheduleFiredKind = "saf_schedule_fired";

// Roughly a minute: comfortably under the `setTimeout` ceiling and short enough to bound drift
// across a clock change. Nothing rests on the exact number.
const defaultMaxSleepMs = 60_000;

export type SchedulerOptions = {
  readonly db: Db;
  /**
   * The Signal Worker every fire emits into.
   *
   * The emit joins the fire's own transaction, so announcing an occurrence and retiring or
   * advancing the Schedule commit together or not at all.
   */
  readonly worker: SignalWorker;
  /**
   * The clock the due-check, the derivations and every timestamp read. Defaults to real time.
   *
   * Taken as an option so timing is deterministic in a test: set the instant, await `tick`, and
   * assert what fired, with nothing sleeping.
   */
  readonly now?: () => Date;
  /**
   * The longest the firing timer sleeps before it wakes and re-derives due-ness, in milliseconds.
   * Defaults to roughly a minute.
   *
   * A bound on correctness rather than a tuning knob. It keeps an armed delay under the 24.85-day
   * `setTimeout` ceiling, and it bounds the drift a long arm accrues across an NTP step, a suspend
   * or a DST jump. Lower it and the timer wakes more often for nothing. Raise it past the ceiling
   * and a far Schedule overflows into an immediate wake.
   */
  readonly maxSleepMs?: number;
  /**
   * Where the agent creates, lists, reads and cancels Schedules over HTTP. Omit it and no route is
   * registered anywhere, which is the switch that keeps the agent away from Schedules altogether.
   * The programmatic API below stays available either way.
   *
   * Given one, the constructor registers `PUT /schedules/:name`, `GET /schedules`,
   * `GET /schedules/:name` and `DELETE /schedules/:name`, at no prefix. These are the only routes
   * in the framework that address a record by a name its caller chose rather than by an id the
   * Gateway minted, which is why the create is a `PUT`.
   *
   * Worth switching off for two reasons. An agent that wakes itself can loop the one serial Signal
   * lane, and nothing scopes a Schedule by creator, so the same routes reach the Operator's own.
   *
   * Structural: anything carrying a Fastify instance satisfies it.
   */
  readonly agentServer?: {
    readonly fastify: FastifyInstance;
  };
  /**
   * Defaults to a `pino` instance on stdout.
   *
   * One info line per fire, naming the Schedule, and one error line for a due-check that failed.
   * That failure is swallowed rather than thrown, so the line is the only record of it.
   */
  readonly logger?: Logger;
};

/**
 * The Schedules a deployment has arranged, as a Component: an upsert by name, a list, a cancel, and
 * the due-check the timer calls.
 *
 * A Schedule is stored, so it outlives the Run and the process that arranged it. Nothing removes
 * one but a cancel, a `once` that has fired, or a `cron` reaching its `until`. There is no expiry
 * and nothing sweeps.
 *
 * The programmatic API works whether or not the Agent routes were registered, and none of its four
 * methods is scoped: names live in one flat namespace that the Operator and the agent share, so
 * either reaches what the other arranged.
 *
 * An occurrence is announced once. The Signal and the row's advance or delete commit in one
 * transaction, so nothing can fire twice or retire silently. An occurrence that fell while the
 * process was down is skipped rather than replayed, every next fire being derived forward from now.
 */
export type Scheduler = Component & {
  /**
   * Creates a Schedule under this name, or updates the one already there, and answers with the
   * record and whether the name was new.
   *
   * An upsert, so a retry or a revised plan converges to one Schedule instead of accumulating
   * duplicates, and a declaration made at every boot is safe to re-run.
   *
   * A spec with no future fire is not refused here. A `once` whose instant has passed, and a `cron`
   * whose `until` sits at or before its next occurrence, arm nothing: any row under the name is
   * removed, and the record answers with a null `nextFireAt`. The Agent route refuses that same
   * case with a 400 instead, a caller in the moment being able to act on it.
   *
   * Refuses a name that is not a url-safe key: at most 128 letters, digits, dots, dashes and
   * underscores. The Agent routes' `/:name` path holds one to that same rule, so every Schedule
   * this creates is one those routes can address.
   *
   * @throws `ScheduleSpecError` for a name outside that set, a cron `expr` that will not parse, a
   *   `tz` that is no IANA zone, or a malformed `until`. Nothing is written first.
   */
  schedule(input: ScheduleInput): Promise<ScheduleOutcome>;

  /**
   * Every Schedule, soonest to fire first and then by name.
   *
   * Unbounded: the cap on a page belongs to the Agent route rather than to this.
   */
  list(): Promise<ScheduleRecord[]>;

  /**
   * Cancels the Schedule this name addresses, and answers whether one was there.
   *
   * A name that was already gone answers `false` rather than an idempotent `true`, so a caller is
   * never told it stopped something that did not exist. A `cron` carrying no `until` has a next
   * fire forever, so this is what ends one.
   */
  cancel(name: string): Promise<boolean>;

  /**
   * Fires every Schedule the clock has reached, and resolves when none is left.
   *
   * The seam the timer calls, exposed so a test drives the same code with an injected clock and
   * without sleeping. Drive it serially, awaiting one call before the next, which is how the timer
   * calls it. It arms nothing: a `tick` on a stopped Scheduler fires what is due and leaves the
   * timer as it found it.
   */
  tick(): Promise<void>;

  /**
   * Re-derives every Schedule's next fire forward from now, then arms the firing timer.
   *
   * The re-derivation is what makes a restart clean. A stored next fire is not trusted as a trigger
   * across a boot, so an occurrence that fell during an outage is dropped for a spent `once` and
   * jumped for a `cron`, however many were missed. The one fire that still arrives late is on a
   * process that stayed live and was frozen through the instant, because no boot ran.
   *
   * A second `start` is a no-op rather than a second timer.
   */
  start(): Promise<void>;

  /**
   * Cancels the firing timer, so no fire begins once it returns.
   *
   * A fire already under way commits its Signal with the row's advance or delete, so an occurrence
   * announced during a shutdown is announced exactly once. A Signal no Worker reached before the
   * process ended is run at the next boot.
   *
   * A second `stop`, or a `stop` before any `start`, finds no timer and does nothing.
   */
  stop(): Promise<void>;
};

/**
 * Builds the Scheduler, and registers the four Agent routes when an Agent server is given.
 *
 * Nothing here connects, listens or applies DDL, and no timer is armed until `start`.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  // The Component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(schedulerTables);
  const now = options.now ?? (() => new Date());
  const maxSleepMs = options.maxSleepMs ?? defaultMaxSleepMs;
  const log = options.logger ?? defaultLogger();

  // Whether the timer is meant to be running, flipped by `start` and `stop` and read by `arm`.
  let started = false;
  // The one live firing timer, or `undefined` when nothing is armed. There is only ever one.
  let timer: NodeJS.Timeout | undefined;

  // Safe to call when there is none.
  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  // One transaction per due row rather than one for the batch, so a fire that fails leaves the
  // rest of the batch committed and retriable on the next wake.
  async function tick(): Promise<void> {
    const due = await selectDue(handle, now());
    for (const row of due) await fire(row);
  }

  /**
   * Every row's next fire, re-derived strictly forward from `now`, once, before the timer arms.
   *
   * An outage leaves a stored fire in the past, and firing it would replay an occurrence nobody was
   * there for. A `cron` moves to its next strictly future occurrence and retires if that passes
   * `until`; a `once` whose instant has passed is dropped. Nothing in the past is ever enumerated,
   * so the number of occurrences missed does not matter.
   *
   * On the Component's own handle and not in one transaction, for the reason in the file header.
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
   * With nothing scheduled it stays disarmed, and a later `schedule` re-arms it.
   *
   * The `clearTimer` after the await is deliberate. Two arms racing on the pool each clear the
   * other's handle before assigning, so one live timer survives rather than two.
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
   * One wake: fire what the wall clock now says is due, then re-arm for the next earliest.
   *
   * A Db error is logged and swallowed rather than allowed to kill the process. A fire's own write
   * is transactional, so what reaches here is a failed read, and the next wake retries it.
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

  // The announcement and the advance in one transaction, which is the whole of "an occurrence fires
  // once". `matureOf` decides both, and the two must stay inside this one `tx`. `firedAt` is the
  // Scheduler's own clock, so a Handler can compare it to `scheduledFor` and judge lateness.
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

  // The one upsert, reached by the method and by the agent's `PUT` alike. Lenient about a spec that
  // resolves to no future fire, so an Operator re-running a boot-time declaration converges instead
  // of crashing. The route runs `assertCreatable` in front of this to refuse that case loudly.
  async function doSchedule(input: ScheduleInput): Promise<ScheduleOutcome> {
    // Before the spec: a name outside the pattern would be a Schedule the agent sees in a list and
    // can never address.
    assertScheduleName(input.name);
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
    // Built from the input and the computed fire rather than read back, and through the same
    // builders a stored row goes through, so this answer and a later list cannot disagree.
    return { created, schedule: scheduleRecord(input, next, until, data) };
  }

  // `limit` is the agent route's cap. The method below passes none.
  async function listRecords(limit?: number): Promise<ScheduleRecord[]> {
    const rows = await selectSchedules(handle, limit);
    return rows.map(asScheduleRecord);
  }

  async function readRecord(name: string): Promise<ScheduleRecord | undefined> {
    const row = await selectSchedule(handle, name);
    return row === undefined ? undefined : asScheduleRecord(row);
  }

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
      // Boot: re-derive every row's next fire forward from now before arming, so a stale fire left
      // by an outage is recomputed rather than announced.
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
