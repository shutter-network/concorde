import { CronExpressionParser } from "cron-parser";
import { asc, eq, lte, sql } from "drizzle-orm";
import { IANAZone } from "luxon";
import type { Handle } from "../db/index.ts";
import { type schedulerTables, schedules } from "./schema/index.ts";

type SchedulerHandle = Handle<typeof schedulerTables>;

const defaultZone = "UTC";

export class ScheduleSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleSpecError";
  }
}

export const scheduleNamePattern = "^[A-Za-z0-9._-]{1,128}$";

const urlSafeKey = new RegExp(scheduleNamePattern);

export function assertScheduleName(name: string): void {
  if (!urlSafeKey.test(name)) {
    throw new ScheduleSpecError(
      `the Schedule name ${JSON.stringify(name)} is not a url-safe key: letters, digits, dots, dashes and underscores, at most 128 of them`,
    );
  }
}

export type ScheduleSpec =
  | { readonly kind: "once"; readonly at: string }
  /** Time zone defaults to UTC. Accepts IANA names and cron expressions with an optional seconds field. */
  | { readonly kind: "cron"; readonly expr: string; readonly tz?: string };

export type ScheduleFiredRecord = {
  readonly scheduleName: string;
  readonly data: unknown;
  readonly scheduledFor: string;
  readonly firedAt: string;
};

export type ScheduleRecord = {
  readonly name: string;
  readonly spec: ScheduleSpec;
  readonly data: unknown;
  readonly until: string | null;
  readonly nextFireAt: string | null;
};

export type ScheduleInput = {
  readonly name: string;
  readonly spec: ScheduleSpec;
  readonly data?: unknown;
  /** Inclusive end instant for recurring schedules. Ignored for one-shot schedules. */
  readonly until?: string;
};

export type ScheduleOutcome = {
  readonly created: boolean;
  readonly schedule: ScheduleRecord;
};

function zoneOf(spec: { readonly tz?: string }): string {
  return spec.tz ?? defaultZone;
}

function assertKnownZone(tz: string): void {
  if (!IANAZone.isValidZone(tz)) {
    throw new ScheduleSpecError(`unknown time zone ${JSON.stringify(tz)}`);
  }
}

function cronNextAfter(
  expr: string,
  tz: string,
  after: Date,
  until: Date | undefined,
): Date | undefined {
  assertKnownZone(tz);
  let interval: ReturnType<typeof CronExpressionParser.parse>;
  try {
    interval = CronExpressionParser.parse(expr, { currentDate: after, tz });
  } catch {
    throw new ScheduleSpecError(`invalid cron expression ${JSON.stringify(expr)}`);
  }
  const next = interval.next().toDate();
  if (until !== undefined && next.getTime() > until.getTime()) return undefined;
  return next;
}

export function parseUntil(until: string): Date {
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) {
    throw new ScheduleSpecError(`malformed until instant ${JSON.stringify(until)}`);
  }
  return at;
}

export function nextFireOf(spec: ScheduleSpec, now: Date, until?: Date): Date | undefined {
  if (spec.kind === "cron") {
    return cronNextAfter(spec.expr, zoneOf(spec), now, until);
  }
  const at = new Date(spec.at);
  const atMs = at.getTime();
  if (Number.isNaN(atMs) || atMs <= now.getTime()) return undefined;
  return at;
}

export function assertCreatable(input: ScheduleInput, now: Date): void {
  const until =
    input.spec.kind === "cron" && input.until !== undefined ? parseUntil(input.until) : undefined;
  if (nextFireOf(input.spec, now, until) !== undefined) return;
  if (input.spec.kind === "once") {
    const at = new Date(input.spec.at);
    if (Number.isNaN(at.getTime())) {
      throw new ScheduleSpecError(`malformed once instant ${JSON.stringify(input.spec.at)}`);
    }
    throw new ScheduleSpecError(
      `the once instant ${JSON.stringify(input.spec.at)} is already in the past`,
    );
  }
  throw new ScheduleSpecError(
    `the cron until ${JSON.stringify(input.until)} is at or before the Schedule's next fire, so it would never fire`,
  );
}

export function nextFireOfRow(row: typeof schedules.$inferSelect, now: Date): Date | undefined {
  if (row.kind === "cron" && row.cronExpr !== null && row.tz !== null) {
    return cronNextAfter(row.cronExpr, row.tz, now, row.until ?? undefined);
  }
  const at = row.at;
  if (at === null || at.getTime() <= now.getTime()) return undefined;
  return at;
}

export type Maturation = {
  readonly scheduledFor: Date;
  readonly emit: boolean;
  readonly next: Date | undefined;
};

export function matureOf(row: typeof schedules.$inferSelect, now: Date): Maturation {
  const at = row.at;
  if (at === null) {
    return { scheduledFor: now, emit: false, next: undefined };
  }
  return { scheduledFor: at, emit: true, next: nextFireOfRow(row, now) };
}

type ScheduleRow = typeof schedules.$inferInsert;

export function scheduleRow(
  input: ScheduleInput,
  next: Date,
  until: Date | undefined,
  data: unknown,
): ScheduleRow {
  if (input.spec.kind === "cron") {
    return {
      name: input.name,
      kind: "cron",
      at: next,
      cronExpr: input.spec.expr,
      tz: zoneOf(input.spec),
      until: until ?? null,
      data,
    };
  }
  return {
    name: input.name,
    kind: "once",
    at: next,
    cronExpr: null,
    tz: null,
    until: null,
    data,
  };
}

export async function upsertSchedule(
  handle: SchedulerHandle,
  row: ScheduleRow,
): Promise<{ created: boolean }> {
  const [written] = await handle
    .insert(schedules)
    .values(row)
    .onConflictDoUpdate({
      target: schedules.name,
      set: {
        kind: row.kind,
        at: row.at,
        cronExpr: row.cronExpr ?? null,
        tz: row.tz ?? null,
        until: row.until ?? null,
        data: row.data ?? null,
      },
    })
    .returning({ created: sql<boolean>`(xmax = 0)` });
  if (written === undefined) {
    throw new Error("upserting a Schedule wrote no row");
  }
  return { created: written.created };
}

export async function advanceSchedule<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  name: string,
  at: Date,
): Promise<void> {
  await handle.update(schedules).set({ at }).where(eq(schedules.name, name));
}

export async function deleteSchedule<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  name: string,
): Promise<boolean> {
  const removed = await handle
    .delete(schedules)
    .where(eq(schedules.name, name))
    .returning({ name: schedules.name });
  return removed.length > 0;
}

export async function selectSchedules(
  handle: SchedulerHandle,
  limit?: number,
): Promise<(typeof schedules.$inferSelect)[]> {
  const ordered = handle.select().from(schedules).orderBy(asc(schedules.at), asc(schedules.name));
  return limit === undefined ? ordered : ordered.limit(limit);
}

export async function selectSchedule(
  handle: SchedulerHandle,
  name: string,
): Promise<typeof schedules.$inferSelect | undefined> {
  const [row] = await handle.select().from(schedules).where(eq(schedules.name, name));
  return row;
}

export async function selectDue(
  handle: SchedulerHandle,
  now: Date,
): Promise<(typeof schedules.$inferSelect)[]> {
  return handle
    .select()
    .from(schedules)
    .where(lte(schedules.at, now))
    .orderBy(asc(schedules.at), asc(schedules.name));
}

export async function earliestFireAt(handle: SchedulerHandle): Promise<Date | undefined> {
  const [row] = await handle
    .select({ at: schedules.at })
    .from(schedules)
    .orderBy(asc(schedules.at))
    .limit(1);
  return row?.at ?? undefined;
}

function onceRecord(name: string, at: Date, data: unknown): ScheduleRecord {
  const iso = at.toISOString();
  return { name, spec: { kind: "once", at: iso }, data, until: null, nextFireAt: iso };
}

function cronRecord(
  name: string,
  expr: string,
  tz: string,
  until: Date | null,
  at: Date,
  data: unknown,
): ScheduleRecord {
  return {
    name,
    spec: { kind: "cron", expr, tz },
    data,
    until: until === null ? null : until.toISOString(),
    nextFireAt: at.toISOString(),
  };
}

export function scheduleRecord(
  input: ScheduleInput,
  next: Date | undefined,
  until: Date | undefined,
  data: unknown,
): ScheduleRecord {
  if (next !== undefined) {
    return input.spec.kind === "cron"
      ? cronRecord(input.name, input.spec.expr, zoneOf(input.spec), until ?? null, next, data)
      : onceRecord(input.name, next, data);
  }
  if (input.spec.kind === "cron") {
    return {
      name: input.name,
      spec: { kind: "cron", expr: input.spec.expr, tz: zoneOf(input.spec) },
      data,
      until: until === undefined ? null : until.toISOString(),
      nextFireAt: null,
    };
  }
  return {
    name: input.name,
    spec: { kind: "once", at: input.spec.at },
    data,
    until: null,
    nextFireAt: null,
  };
}

export function asScheduleRecord(row: typeof schedules.$inferSelect): ScheduleRecord {
  const at = row.at;
  if (row.kind === "once" && at !== null) {
    return onceRecord(row.name, at, row.data);
  }
  if (row.kind === "cron" && at !== null && row.cronExpr !== null && row.tz !== null) {
    return cronRecord(row.name, row.cronExpr, row.tz, row.until, at, row.data);
  }
  throw new Error(`Schedule ${row.name} has an unsupported kind ${JSON.stringify(row.kind)}`);
}
