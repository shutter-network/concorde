/**
 * The Scheduler's types, and the statements its firing core is made of. The record shapes live
 * beside the statements because they are what the upsert answers with and what a Handler is written
 * against.
 *
 * The calendar arithmetic is `cron-parser`'s and never ours. It computes the next occurrence
 * against a reference instant in a named IANA zone, DST included, through its own `luxon`
 * dependency. Do not reimplement any of it. `luxon` is imported directly for one thing only:
 * validating a zone name up front, so an unknown `tz` is a legible refusal at creation rather than
 * a throw at fire time.
 *
 * `nextFireOf` and `nextFireOfRow` are the same derivation from two sources, an input spec and a
 * stored row, and every path that needs a next fire goes through one of them. Both derive strictly
 * forward from the instant they are given, which is the whole of why a missed occurrence is never
 * enumerated. The `until` bound is compared by hand rather than passed to the parser as an end
 * date, so "at or before it" does not rest on the library's inclusivity.
 */

import { CronExpressionParser } from "cron-parser";
import { asc, eq, lte, sql } from "drizzle-orm";
import { IANAZone } from "luxon";
import type { Handle } from "../db/index.ts";
import { type schedulerTables, schedules } from "./schema.ts";

type SchedulerHandle = Handle<typeof schedulerTables>;

// Never the server's local zone, so nothing depends on where the Gateway happens to run. Applied
// at the one place a cron's zone is read, and stored resolved.
const defaultZone = "UTC";

/**
 * A cron `expr`, a `tz`, an `until` or a `once` instant the Scheduler will not accept.
 *
 * Thrown by `schedule` before anything is written, so a caller learns of the mistake at creation
 * rather than through a Schedule that silently never fires.
 *
 * The `message` is the refusal reason and is safe to show a caller: it names the value that was
 * refused and nothing about the Scheduler itself. A named class rather than a bare `Error` so that
 * the Agent routes catch this and only this, and answer 400. Every other failure stays a 500.
 */
export class ScheduleSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleSpecError";
  }
}

/**
 * How a Schedule recurs: a tagged union on `kind`.
 *
 *  - `once` is one absolute instant, ISO 8601. cron cannot express it, having no year field.
 *  - `cron` is a recurring expression evaluated in a named IANA time zone. `tz` may be omitted, and
 *    then it is UTC rather than the zone the Gateway's host is set to.
 */
export type ScheduleSpec =
  | { readonly kind: "once"; readonly at: string }
  | { readonly kind: "cron"; readonly expr: string; readonly tz?: string };

/**
 * The payload of the Signal a matured Schedule emits, flat, and half of the Signal contract.
 *
 * The other half is the fixed `kind`. Every fire of every Schedule, from either creator, arrives as
 * this one shape, so a Handler is written `SignalHandler<ScheduleFiredRecord>` and neither the
 * `kind` string nor the payload shape is spelled out a second time by hand.
 */
export type ScheduleFiredRecord = {
  /** The Schedule this fire came from, which is its whole identity and the thing to correlate on. */
  readonly scheduleName: string;
  /** The creator's data, byte for byte as it was supplied. The Scheduler reads none of it. */
  readonly data: unknown;
  /** The instant the fire was arranged for, ISO 8601. */
  readonly scheduledFor: string;
  /** When the Scheduler actually emitted, ISO 8601. Past `scheduledFor` means the fire was late. */
  readonly firedAt: string;
};

/**
 * A Schedule as every surface answers with it: the upsert's answer and the list's entries.
 *
 * One shape rather than a projection per surface, so a record in hand and a record read back later
 * agree field for field. `spec` is the union rebuilt from the stored columns, with a cron's zone
 * resolved. `until` is a cron's end instant, and is null for a `once` and for an unbounded cron.
 *
 * `nextFireAt` is derived forward from now rather than read off a trusted timestamp. It is null
 * only for a Schedule with no future fire, which is therefore spent and stored nowhere.
 */
export type ScheduleRecord = {
  readonly name: string;
  readonly spec: ScheduleSpec;
  readonly data: unknown;
  readonly until: string | null;
  readonly nextFireAt: string | null;
};

/**
 * What a create-or-update takes.
 *
 * `data` is the creator's own, uninterpreted, and is stored as null when omitted. `until` bounds a
 * `cron`: after its last occurrence at or before that instant the Schedule retires. It means
 * nothing on a `once`, which bounds itself by firing once, and is ignored there rather than
 * refused. The Agent route refuses it instead.
 */
export type ScheduleInput = {
  readonly name: string;
  readonly spec: ScheduleSpec;
  readonly data?: unknown;
  readonly until?: string;
};

/**
 * What a create-or-update answers with.
 *
 * `created` is read out of the write itself rather than from a lookup in front of it, so nothing
 * races between the two. It is what an HTTP `PUT` turns into 201 versus 200. A create that resolved
 * to no future fire is `created: false` carrying a record whose `nextFireAt` is null, nothing
 * having been armed.
 */
export type ScheduleOutcome = {
  readonly created: boolean;
  readonly schedule: ScheduleRecord;
};

// Resolved once, here, so storage, computation and the read model cannot disagree about which zone
// is in force.
function zoneOf(spec: { readonly tz?: string }): string {
  return spec.tz ?? defaultZone;
}

// Up front, so an unknown zone is a legible 400 rather than a throw at fire time.
function assertKnownZone(tz: string): void {
  if (!IANAZone.isValidZone(tz)) {
    throw new ScheduleSpecError(`unknown time zone ${JSON.stringify(tz)}`);
  }
}

/**
 * The next occurrence of a cron expression strictly after `after`, in `tz`, or `undefined` when it
 * would fall past `until`.
 *
 * `next()` returns the occurrence strictly after `currentDate`, which is the library's contract and
 * not something to re-derive. The `until` comparison is ours on purpose; see the file header.
 */
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
  // A cron has no year field, so an unbounded expression always has a next occurrence. `next()`
  // only runs out against an end date, which this call does not set.
  const next = interval.next().toDate();
  if (until !== undefined && next.getTime() > until.getTime()) return undefined;
  return next;
}

// Parsed rather than trusted: a cron whose `until` is unreadable would otherwise persist as one
// that never respects the bound it was given.
export function parseUntil(until: string): Date {
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) {
    throw new ScheduleSpecError(`malformed until instant ${JSON.stringify(until)}`);
  }
  return at;
}

/**
 * The next instant a spec fires strictly after `now`, or `undefined` when it has none.
 *
 * The input-shaped half of the forward derivation. A `once` counts only while its instant is still
 * future, and a malformed instant is reported as spent rather than thrown: `assertCreatable` is
 * where a caller in the moment gets the loud refusal, and nothing else has anybody to answer.
 */
export function nextFireOf(spec: ScheduleSpec, now: Date, until?: Date): Date | undefined {
  if (spec.kind === "cron") {
    return cronNextAfter(spec.expr, zoneOf(spec), now, until);
  }
  const at = new Date(spec.at);
  const atMs = at.getTime();
  if (Number.isNaN(atMs) || atMs <= now.getTime()) return undefined;
  return at;
}

/**
 * Refuses a create that could never fire, so the Agent route answers it as a 400 before anything is
 * written.
 *
 * The loud refusal a caller in the moment earns, and the reason the wire's `nextFireAt` is never
 * null. The two lenient paths are deliberate and must stay lenient: boot re-derivation drops the
 * very same Schedule in silence, having nobody to answer, and the programmatic `schedule` converges
 * rather than crashing an Operator re-running a boot-time declaration whose `once` has passed.
 *
 * Every refusal reuses the derivation `schedule` will run, so the two cannot come to disagree. What
 * this adds is naming the three cases that derivation reports as spent instead of throwing.
 */
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

/**
 * The next fire of a stored row strictly after `now`, or `undefined` when it has none.
 *
 * The row-shaped half of the forward derivation, and the one place a stored row becomes a fire. The
 * boot re-derivation and maturing a due row both come through here, which is what keeps them from
 * deriving differently.
 */
export function nextFireOfRow(row: typeof schedules.$inferSelect, now: Date): Date | undefined {
  if (row.kind === "cron" && row.cronExpr !== null && row.tz !== null) {
    return cronNextAfter(row.cronExpr, row.tz, now, row.until ?? undefined);
  }
  const at = row.at;
  if (at === null || at.getTime() <= now.getTime()) return undefined;
  return at;
}

/** What maturing decides. An `undefined` `next` retires the Schedule. */
export type Maturation = {
  readonly scheduledFor: Date;
  readonly emit: boolean;
  readonly next: Date | undefined;
};

/**
 * What maturing a due row decides: announce the occurrence it was armed for, and derive the next.
 *
 * The stored `at` is announced verbatim, and `next` is derived strictly forward from `now`, so a
 * gap the process slept through is jumped rather than enumerated. Keep both halves in one decision:
 * the caller commits them in one transaction, and splitting the decision is the first step towards
 * splitting the write.
 */
export function matureOf(row: typeof schedules.$inferSelect, now: Date): Maturation {
  const at = row.at;
  if (at === null) {
    // Guarded by `selectDue`, which never returns a null `at`. Defensive, so a caller cannot emit a
    // fire for an instant that does not exist.
    return { scheduledFor: now, emit: false, next: undefined };
  }
  return { scheduledFor: at, emit: true, next: nextFireOfRow(row, now) };
}

type ScheduleRow = typeof schedules.$inferInsert;

// Every column, always. An upsert that changes a Schedule's kind has to clear the columns of the
// kind it no longer is, or the row fails the check constraints it now falls under.
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

/**
 * Writes a Schedule by name, updating in place when the name is taken.
 *
 * `on conflict (name) do update` is what makes re-creating a name converge rather than add a second
 * row or drop the change. The `set` names every column, for the reason `scheduleRow` builds every
 * column.
 *
 * Whether this inserted or updated comes from PostgreSQL's `xmax`, zero on a freshly inserted row.
 * Do not replace it with a read in front of the write: that is a race where this is a fact.
 */
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

// The update half of maturing a recurring Schedule, widened over the handle so it runs on the
// fire's own transaction. Sets only `at`: a fire changes nothing else about the arrangement.
export async function advanceSchedule<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  name: string,
  at: Date,
): Promise<void> {
  await handle.update(schedules).set({ at }).where(eq(schedules.name, name));
}

// The one delete, for all three reasons a row leaves: a cancel, an upsert that resolved to no
// future fire, and the retirement half of a fire. Widened over the handle for that last one, which
// runs on the fire's transaction. The boolean is what lets a cancel refuse an unknown name.
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

/**
 * Every Schedule, ascending by next fire and then by name.
 *
 * @param limit Bounds the page the agent's list answers. The boot re-derivation passes none on
 *   purpose: it must reach every row, and a cap would leave the rest on a stale `at`.
 */
export async function selectSchedules(
  handle: SchedulerHandle,
  limit?: number,
): Promise<(typeof schedules.$inferSelect)[]> {
  const ordered = handle.select().from(schedules).orderBy(asc(schedules.at), asc(schedules.name));
  return limit === undefined ? ordered : ordered.limit(limit);
}

// A row exists only while a Schedule is armed, so a row found here is live and has a future `at`.
// That is why the read model built from it always carries a non-null `nextFireAt`.
export async function selectSchedule(
  handle: SchedulerHandle,
  name: string,
): Promise<typeof schedules.$inferSelect | undefined> {
  const [row] = await handle.select().from(schedules).where(eq(schedules.name, name));
  return row;
}

// One comparison over one column selects both kinds, because a cron materialises its next
// occurrence into `at` as well. `matureOf` is where a due row's kind starts to matter again.
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

/**
 * The instant the earliest-firing Schedule is next due, or `undefined` when none is armed.
 *
 * What the timer arms against, the soonest fire being the only one the next wake has to know about.
 * A row left in the past by an outage wins this ordering and arms an immediate wake, whose own
 * derivation then skips the stale occurrence. That is the self-correction the timer rests on.
 */
export async function earliestFireAt(handle: SchedulerHandle): Promise<Date | undefined> {
  const [row] = await handle
    .select({ at: schedules.at })
    .from(schedules)
    .orderBy(asc(schedules.at))
    .limit(1);
  return row?.at ?? undefined;
}

// A persisted `once` is armed, so its instant is both its `spec.at` and its `nextFireAt`. One
// builder for both paths that answer with an armed `once`, so the two cannot drift.
function onceRecord(name: string, at: Date, data: unknown): ScheduleRecord {
  const iso = at.toISOString();
  return { name, spec: { kind: "once", at: iso }, data, until: null, nextFireAt: iso };
}

// The `once` builder's counterpart, and shared by both armed-`cron` paths for the same reason.
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

/**
 * The read model an upsert answers with, built from the input and the fire just computed rather
 * than from a read of the row.
 *
 * An armed Schedule goes through the very builders a stored row goes through, which is what makes
 * "the answer and a later list agree" a shared fact instead of a coincidence. A spent one has a
 * null `nextFireAt`, and a spent `once` echoes the instant it was asked for, there being no
 * computed fire to state.
 */
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

// The read model of a stored row, through the same two builders.
export function asScheduleRecord(row: typeof schedules.$inferSelect): ScheduleRecord {
  const at = row.at;
  if (row.kind === "once" && at !== null) {
    return onceRecord(row.name, at, row.data);
  }
  if (row.kind === "cron" && at !== null && row.cronExpr !== null && row.tz !== null) {
    return cronRecord(row.name, row.cronExpr, row.tz, row.until, at, row.data);
  }
  // A row that is neither shape is a database in a state this Component does not write. Surface it
  // rather than answer a half-formed record.
  throw new Error(`Schedule ${row.name} has an unsupported kind ${JSON.stringify(row.kind)}`);
}
