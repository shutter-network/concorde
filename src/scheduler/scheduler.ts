/**
 * The Scheduler: the part of the Gateway that owns Schedules and emits a Signal when one matures.
 *
 * A **Producer** and a **Component**, constructed like every other part — one call, an ordinary
 * object back — and wiring itself the way every part does, registering its own migration
 * descriptor with the Db (ADR-0032). It is the second Producer, the peer ADR-0018 anticipated
 * alongside the HTTP Messenger, and reading that part is the closest prior art for this one.
 *
 * This ticket builds the storage, the Signal contract, and the firing core: `schedule` (an upsert
 * by name), `list`, `cancel`, and an awaitable `tick` that is the real due-check. The autonomous
 * timer that calls `tick` on a clock, and the agent-facing HTTP routes, arrive in later tickets —
 * so `start` and `stop` are no-ops here, and there is no server option yet.
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
  /** Defaults to a `pino` instance on stdout. */
  readonly logger?: Logger;
};

/**
 * What the constructor answers with: the programmatic interface the Operator always has, whether
 * or not the agent-facing routes are switched on (which is a later ticket).
 *
 * `schedule`, `list` and `cancel` are the management surface; `tick` is the due-check the internal
 * timer will also call, exposed as the testing seam (ADR-0018). `start` and `stop` are the
 * Component's, no-ops until the timer lands.
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

  /** **Does nothing** yet: the autonomous timer that this will start arrives in a later ticket. */
  start(): Promise<void>;

  /** **Does nothing** yet: there is no timer to stop until a later ticket adds one. */
  stop(): Promise<void>;
};

export function createScheduler(options: SchedulerOptions): Scheduler {
  // The part's own handle, typed to its own tables. `pg` never leaves the Db (ADR-0022).
  const handle = options.db.handle(schedulerTables);
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? defaultLogger();

  // Registering the descriptor is bookkeeping the Db does nothing with until `migrate` or `start`,
  // and unlike the HTTP Messenger's the order it lands in does not matter — a Schedule references
  // nobody (ADR-0018).
  options.db.registerMigrations(schedulerMigrations);

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
      // The same builder `list` reads a row through, so this answer and a later list agree
      // byte-for-byte on the same Schedule without reading the row back.
      return { created, schedule: onceRecord(input.name, next, data) };
    },

    async list() {
      const rows = await selectSchedules(handle);
      return rows.map(asScheduleRecord);
    },

    cancel(name) {
      return deleteSchedule(handle, name);
    },

    async tick() {
      const due = await selectDue(handle, now());
      for (const row of due) await fire(row);
    },

    start: async () => {},
    stop: async () => {},
  };
}
