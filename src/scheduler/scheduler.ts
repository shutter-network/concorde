/**
 * The Scheduler: the part of the Gateway that owns Schedules and emits a Signal when one matures.
 *
 * A **Producer** and a **Component**, constructed like every other part — one call, an ordinary
 * object back — and wiring itself the way every part does, registering its own migration
 * descriptor with the Db (ADR-0032). It is the second Producer, the peer ADR-0018 anticipated
 * alongside the HTTP Messenger, and reading that part is the closest prior art for this one.
 *
 * The storage, the Signal contract, and the firing core are the awaitable `tick` due-check plus
 * `schedule` (an upsert by name), `list`, and `cancel`. Over that core, `start` arms a single
 * **capped, self-correcting timer** that calls the same `tick` on its own, and `stop` cancels it —
 * the autonomous firing this ticket adds. The agent-facing HTTP routes arrive in a later ticket, so
 * there is no server option yet.
 *
 * The timer is one `setTimeout`, armed to the earliest Schedule's next fire but never for longer
 * than `maxSleepMs` (~a minute, Operator-configurable), and re-derived against the wall clock on
 * every wake rather than trusting the elapsed delay. Two failures ride on the cap. A raw
 * `setTimeout` above ~24.85 days overflows a signed 32-bit delay and fires almost immediately; and
 * any multi-hour arm drifts across an NTP correction, a suspend, or a DST jump. Capping the sleep
 * and re-checking due-ness against `now` on each wake corrects all three — there is no correctness
 * in the cap's exact value, only in that it is bounded. The one accepted residual is a live process
 * frozen straight through a fire time, which fires once, late; there is no staleness threshold
 * (ADR-0018).
 *
 * Three things about it are decisions rather than omissions (ADR-0018):
 *
 *  - **The Signal `kind` is fixed.** Every matured Schedule emits `scheduleFiredKind`, never a
 *    caller-chosen one. A Producer is trusted (ADR-0020) — whatever it writes in a payload the
 *    worker takes as fact — so a caller-chosen `kind` would let the agent emit any Signal on a
 *    delay, message-received included. The fixed `kind` caps the agent's whole scheduling power at
 *    "wake the deployment's one schedule Handler with context I chose."
 *  - **Firing is exactly-once via one transaction.** Maturing is two writes — emit the Signal and
 *    retire the spent one-shot — and per ADR-0023 `worker.emit(tx, signal)` takes the caller's
 *    transaction, so the Scheduler does both inside one and they commit together. A crash between
 *    them is impossible: either both happened or neither.
 *  - **Missed fires are skipped by deriving forward from now.** The persisted source of truth is
 *    the Schedule's definition, not a due-timestamp that could outlive a restart sitting in the
 *    past. A `once` is armed only while its instant is still in the future — an already-past one is
 *    never persisted — so nothing in the past is ever enumerated and no missed fire replays.
 */

import type { Component } from "../components.ts";
import type { Db } from "../db/index.ts";
import { defaultLogger, type Logger } from "../logging.ts";
import type { SignalWorker } from "../signals/worker.ts";
import { schedulerMigrations } from "./migrations.ts";
import {
  asScheduleRecord,
  deleteSchedule,
  earliestFireAt,
  nextFireOf,
  onceRecord,
  type ScheduleFiredRecord,
  type ScheduleInput,
  type ScheduleOutcome,
  type ScheduleRecord,
  selectDue,
  selectSchedules,
  upsertSchedule,
} from "./schedules.ts";
import { schedulerTables, type schedules } from "./schema.ts";

/**
 * The `kind` of the Signal every matured Schedule emits, and half of this part's Signal contract;
 * the other half is that the payload **is** the `ScheduleFiredRecord`, flat.
 *
 * Exported, so that an Operator's Handler map is not a string literal that can drift, and a
 * constant rather than a construction option: the creator never chooses the `kind`, which is the
 * cap on the agent's power this part turns on (ADR-0018). A Handler is therefore written
 * `SignalHandler<ScheduleFiredRecord>`, mirroring the HTTP Messenger's `messageReceivedKind`.
 *
 * A `kind` with no Handler registered is a stored Schedule that fires into nothing — a permanently
 * failed Signal, exactly as an unhandled Message (ADR-0017).
 */
export const scheduleFiredKind = "saf_schedule_fired";

/**
 * How long the firing timer sleeps at most before it wakes to re-derive due-ness, when the Operator
 * names no `maxSleepMs`. Roughly a minute: comfortably under the ~24.85-day signed-32-bit
 * `setTimeout` ceiling and short enough that drift across a clock change is bounded to about that,
 * with no correctness resting on the exact number (ADR-0018).
 */
const defaultMaxSleepMs = 60_000;

export type SchedulerOptions = {
  readonly db: Db;
  /**
   * The Signal Worker a matured Schedule emits into.
   *
   * Named nominally and required: a Scheduler that woke nobody would be a Producer that produces
   * nothing. The emit shares the fire's transaction, which is what makes retiring a spent one-shot
   * and announcing it one atomic act (ADR-0023).
   */
  readonly worker: SignalWorker;
  /**
   * The clock the due-check reads, injected so timing is deterministic in tests: set `now`, await
   * `tick`, assert what fired, with no sleeping. Defaults to real time.
   */
  readonly now?: () => Date;
  /**
   * The longest the firing timer may sleep before it wakes and re-derives due-ness, in
   * milliseconds. Defaults to roughly a minute.
   *
   * A cap for correctness rather than tuning: it keeps the armed delay under the ~24.85-day
   * signed-32-bit `setTimeout` ceiling, and bounds the drift a long arm accrues across an NTP step,
   * a suspend, or a DST jump — because each wake re-checks the wall clock rather than trusting the
   * delay. There is no correctness in the exact value; lower it and the timer polls more often,
   * raise it past the ceiling and a far Schedule overflows into an immediate wake. The tests set it
   * small so the real timer proves itself in milliseconds.
   */
  readonly maxSleepMs?: number;
  /** Defaults to a `pino` instance on stdout. */
  readonly logger?: Logger;
};

/**
 * What the constructor answers with: the programmatic interface the Operator always has, whether
 * or not the agent-facing routes are switched on (which is a later ticket).
 *
 * `schedule`, `list` and `cancel` are the management surface; `tick` is the due-check the internal
 * timer also calls, exposed as the testing seam (ADR-0018). `start` arms that timer and `stop`
 * cancels it — the Component's lifecycle around the firing core.
 */
export type Scheduler = Component & {
  /**
   * Creates a Schedule, or updates the one already under this name — an upsert, so a retry or a
   * revised plan converges to one Schedule rather than accumulating duplicates (ADR-0018).
   *
   * Answers whether it created or updated, and with the resulting record. A `once` whose instant
   * is already in the past has no future fire: it is not armed, any existing row under the name is
   * removed, and the record comes back with a `null` `nextFireAt`.
   */
  schedule(input: ScheduleInput): Promise<ScheduleOutcome>;

  /** Every Schedule, ascending by next fire then name, so an Operator can see what is arranged. */
  list(): Promise<ScheduleRecord[]>;

  /**
   * Cancels a Schedule by name, answering whether one was there — so a caller learns that a name
   * was already gone rather than being told it stopped something that did not exist (ADR-0018).
   */
  cancel(name: string): Promise<boolean>;

  /**
   * The due-check: fires every Schedule matured at the current `now`, emitting one Signal and
   * retiring the spent one-shot in one transaction each, and resolves when none is left.
   *
   * The awaitable seam the timer calls and the tests drive directly. Driven serially — a caller
   * awaits one `tick` before the next — which is how the autonomous timer will call it too.
   */
  tick(): Promise<void>;

  /**
   * Arms the autonomous firing timer, so the Scheduler fires on its own with nobody calling `tick`.
   *
   * A single capped `setTimeout`, armed to the earliest Schedule's next fire and re-armed after
   * every fire and on every `schedule` and `cancel`. Idempotent-enough for a Component's contract:
   * a second `start` is a no-op rather than a second timer. There is nothing to recover on start —
   * unlike the Signal Worker, a Scheduler holds no in-flight state across a restart, deriving its
   * next fire forward from `now` (ADR-0018).
   */
  start(): Promise<void>;

  /**
   * Cancels the firing timer, so no fire is started during or after the worker's drain.
   *
   * A fire already committed is a pending Signal the next start's worker drains; what `stop`
   * guarantees is that no *new* fire begins once it returns. Idempotent: a second `stop`, or a
   * `stop` before any `start`, finds no timer and does nothing.
   */
  stop(): Promise<void>;
};

export function createScheduler(options: SchedulerOptions): Scheduler {
  // The part's own handle, typed to its own tables. `pg` never leaves the Db (ADR-0022).
  const handle = options.db.handle(schedulerTables);
  const now = options.now ?? (() => new Date());
  const maxSleepMs = options.maxSleepMs ?? defaultMaxSleepMs;
  const log = options.logger ?? defaultLogger();

  // Registering the descriptor is bookkeeping the Db does nothing with until `migrate` or `start`,
  // and unlike the HTTP Messenger's the order it lands in does not matter — a Schedule references
  // nobody (ADR-0018).
  options.db.registerMigrations(schedulerMigrations);

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
   * The due-check: fires every Schedule matured at the current `now`, one transaction each, and
   * resolves when none is left. The awaitable seam the timer calls and the tests drive directly.
   */
  async function tick(): Promise<void> {
    const due = await selectDue(handle, now());
    for (const row of due) await fire(row);
  }

  /**
   * Arms the single timer to the earliest Schedule's next fire, capped at `maxSleepMs`, or leaves
   * it disarmed when nothing is scheduled — a later `schedule` re-arms it.
   *
   * The cap is the whole of the overflow and drift guard: the armed delay never exceeds `maxSleepMs`,
   * so a far-future fire cannot overflow the signed-32-bit `setTimeout` delay into an immediate wake,
   * and each wake re-derives against `now` rather than trusting how long it slept (ADR-0018). The
   * `clearTimer` after the await is deliberate: two arms racing on the pool each clear the other's
   * handle before assigning, so one live timer survives rather than two.
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
   * A Db error here is logged and swallowed rather than allowed to kill the process — a fire's own
   * emit is transactional (ADR-0023), so the only thing that reaches here is a failed read, retried
   * on the next wake, which the cap bounds the wait for.
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
   * Matures one Schedule: emit its Signal and retire it, in one transaction so a crash between
   * them is impossible (ADR-0023). `firedAt` is the Scheduler's own `now`, so it is deterministic
   * and a Handler can compare it to `scheduledFor` to judge lateness.
   */
  async function fire(row: typeof schedules.$inferSelect): Promise<void> {
    const at = row.at;
    if (at === null) return; // Guarded by `selectDue`; the column is nullable for the cron arm.
    const payload: ScheduleFiredRecord = {
      scheduleName: row.name,
      data: row.data,
      scheduledFor: at.toISOString(),
      firedAt: now().toISOString(),
    };
    await options.db.tx(async (tx) => {
      await options.worker.emit(tx, { kind: scheduleFiredKind, payload });
      await deleteSchedule(tx, row.name);
    });
    log.info({ schedule: row.name, kind: scheduleFiredKind }, "Schedule fired");
  }

  return {
    async schedule(input) {
      const at = now();
      const next = nextFireOf(input.spec, at);
      const data = input.data ?? null;
      if (next === undefined) {
        // No future fire: spent. Honour the upsert by removing any row under this name, so a name
        // that mapped to a live Schedule maps to nothing rather than to a stale one.
        await deleteSchedule(handle, input.name);
        // The removed row may have been the earliest, so the timer's target changed.
        await arm();
        return {
          created: false,
          schedule: { name: input.name, spec: input.spec, data, nextFireAt: null },
        };
      }
      const { created } = await upsertSchedule(handle, {
        name: input.name,
        kind: input.spec.kind,
        at: next,
        data,
      });
      // A new or moved fire may now be the earliest, so re-derive the timer against it.
      await arm();
      // The same builder `list` reads a row through, so this answer and a later list agree
      // byte-for-byte on the same Schedule without reading the row back.
      return { created, schedule: onceRecord(input.name, next, data) };
    },

    async list() {
      const rows = await selectSchedules(handle);
      return rows.map(asScheduleRecord);
    },

    async cancel(name) {
      const removed = await deleteSchedule(handle, name);
      // Cancelling may have removed the earliest fire, so re-derive the timer's target.
      await arm();
      return removed;
    },

    tick,

    async start() {
      // A second `start` re-arming would be harmless, but the Component contract is one lifecycle:
      // arm once, and let `schedule`, `cancel`, and each wake re-derive from there.
      if (started) return;
      started = true;
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
