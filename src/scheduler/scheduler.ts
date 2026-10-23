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
import { schedulerTables, type schedules } from "./schema/index.ts";

export const scheduleFiredKind = "concorde_schedule_fired";

const defaultMaxSleepMs = 60_000;

export type SchedulerOptions = {
  readonly db: Db;
  readonly worker: SignalWorker;
  readonly now?: () => Date;
  /** Maximum delay between timer checks in milliseconds; defaults to 60,000. */
  readonly maxSleepMs?: number;
  readonly agentServer?: {
    readonly fastify: FastifyInstance;
  };
  readonly logger?: Logger;
};

export type Scheduler = Component & {
  /**
   * Creates or replaces by name. A spec with no future occurrence removes any existing schedule.
   * Missed occurrences are skipped; they are not replayed after restart.
   */
  schedule(input: ScheduleInput): Promise<ScheduleOutcome>;

  list(): Promise<ScheduleRecord[]>;

  cancel(name: string): Promise<boolean>;

  tick(): Promise<void>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

export function createScheduler(options: SchedulerOptions): Scheduler {
  const handle = options.db.handle(schedulerTables);
  const now = options.now ?? (() => new Date());
  const maxSleepMs = options.maxSleepMs ?? defaultMaxSleepMs;
  const log = options.logger ?? defaultLogger();

  let started = false;
  let timer: NodeJS.Timeout | undefined;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  async function tick(): Promise<void> {
    const due = await selectDue(handle, now());
    for (const row of due) await fire(row);
  }

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

  async function onWake(): Promise<void> {
    timer = undefined;
    if (!started) return;
    try {
      await tick();
    } catch (error) {
      log.error({ err: error }, "Scheduler tick failed; retrying on the next wakeup");
    }
    await arm();
  }

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

  async function doSchedule(input: ScheduleInput): Promise<ScheduleOutcome> {
    assertScheduleName(input.name);
    const at = now();
    const until =
      input.spec.kind === "cron" && input.until !== undefined ? parseUntil(input.until) : undefined;
    const next = nextFireOf(input.spec, at, until);
    const data = input.data ?? null;
    if (next === undefined) {
      await deleteSchedule(handle, input.name);
      await arm();
      return { created: false, schedule: scheduleRecord(input, undefined, until, data) };
    }
    const { created } = await upsertSchedule(handle, scheduleRow(input, next, until, data));
    await arm();
    return { created, schedule: scheduleRecord(input, next, until, data) };
  }

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
    await arm();
    return removed;
  }

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
      if (started) return;
      started = true;
      await deriveForward();
      await arm();
    },

    async stop() {
      started = false;
      clearTimer();
    },
  };
}
