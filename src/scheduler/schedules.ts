/**
 * The Scheduler's types and the statements the firing core is made of: the read model every
 * surface answers with, the Signal payload a matured Schedule emits, and the upsert/list/delete
 * over this part's one table.
 *
 * Kept beside the Component the way `messages.ts` sits beside the HTTP Messenger: the record
 * shapes here are not only the wire shapes, they are what the upsert answers with and what a
 * Handler is written against, so they live with the statements rather than in a routes module a
 * later ticket adds.
 *
 * The cron arm's calendar arithmetic is `cron-parser`'s and never ours: it computes the next
 * occurrence against a reference instant in a named IANA time zone and handles DST through its
 * `luxon` dependency (ADR-0018). `luxon` is imported directly for one thing `cron-parser` does not
 * do cleanly — validating a zone name up front, so an unknown `tz` is a legible refusal at creation
 * rather than a confusing throw the first time a fire is computed.
 */

import { CronExpressionParser } from "cron-parser";
import { asc, eq, lte, sql } from "drizzle-orm";
import { IANAZone } from "luxon";
import type { Handle } from "../db/index.ts";
import { type schedulerTables, schedules } from "./schema.ts";

/** A handle typed to this part's own tables, and to no other part's (ADR-0022). */
type SchedulerHandle = Handle<typeof schedulerTables>;

/**
 * The zone a cron Schedule is evaluated in when its creator names none: UTC, never the server's
 * local zone, so there is no hidden dependency on where the Gateway runs (ADR-0018). Applied at the
 * one place a cron's zone is read, and stored resolved, so the read model shows the zone in force.
 */
const defaultZone = "UTC";

/**
 * A cron `expr`, a `tz`, or an `until` the Scheduler will not accept, thrown by `schedule` before
 * anything is persisted so a caller learns of the mistake at creation rather than through a Schedule
 * that silently never fires (ADR-0018).
 *
 * A named class rather than a bare `Error` so the agent-facing routes a later ticket adds can catch
 * exactly this and answer 400, leaving every other error a 500. Its `message` is the refusal reason,
 * safe to surface: it names the bad value and nothing about the Scheduler's internals.
 */
export class ScheduleSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleSpecError";
  }
}

/**
 * How a Schedule recurs: an **extensible tagged union**, with `kind` as the seam a future format
 * is added at rather than a field overloaded to mean several things (ADR-0018).
 *
 *  - `once` is a single absolute instant (ISO 8601). It needs no library and is the agent's most
 *    ordinary request. cron cannot express it, having no year field.
 *  - `cron` is a recurring expression in a named IANA time zone, computed by `cron-parser`. `tz` is
 *    optional: a caller who omits it gets UTC, never the server's local zone.
 *
 * Adding the `cron` arm was a new member of this union rather than a rethink of it: the row's
 * discriminant column and its nullable `at` were already there from ticket 01.
 */
export type ScheduleSpec =
  | { readonly kind: "once"; readonly at: string }
  | { readonly kind: "cron"; readonly expr: string; readonly tz?: string };

/**
 * The Signal a matured Schedule emits, and half of this part's Signal contract; the other half is
 * the fixed `scheduleFiredKind` in `scheduler.ts`.
 *
 * Every matured Schedule, from either creator, emits this one envelope: the creator's opaque
 * `data` verbatim, plus the metadata a Handler needs to correlate and to judge lateness. It is
 * exported so that an Operator's Handler is `SignalHandler<ScheduleFiredRecord>` and neither the
 * `kind` nor the payload shape is re-declared by hand, mirroring the HTTP Messenger's
 * `messageReceivedKind` and `MessageRecord` (ADR-0018).
 */
export type ScheduleFiredRecord = {
  /** The Schedule this fire came from, its sole identifier and the reference to correlate on. */
  readonly scheduleName: string;
  /** The creator's opaque data, exactly as it was supplied at creation. */
  readonly data: unknown;
  /** The instant this fire was intended for, ISO 8601 — a Handler compares it to `firedAt`. */
  readonly scheduledFor: string;
  /** The instant the Scheduler actually emitted, ISO 8601. Late when it is past `scheduledFor`. */
  readonly firedAt: string;
};

/**
 * A Schedule as every surface answers with it: the upsert response and the list.
 *
 * One shape and not a projection per surface. `spec` is the tagged union reconstructed from the
 * row's columns, `data` is the creator's opaque payload, `until` is a cron's optional end instant
 * (null for a `once` and an unbounded cron), and `nextFireAt` is when it will next fire — derived
 * forward from now rather than read from a trusted timestamp, and `null` only for a Schedule that
 * has no future fire and is therefore spent (ADR-0018).
 */
export type ScheduleRecord = {
  readonly name: string;
  readonly spec: ScheduleSpec;
  readonly data: unknown;
  readonly until: string | null;
  readonly nextFireAt: string | null;
};

/**
 * What a create-or-update takes: the name, the recurrence, the creator's opaque data, and a cron's
 * optional end instant.
 *
 * `data` is optional and stored as `null` when omitted. `until` bounds a recurring Schedule — after
 * its last occurrence at or before that instant it is retired — and is meaningless for a `once`,
 * which bounds itself by firing once; the programmatic layer ignores it there, and the schema layer
 * a later ticket adds refuses it.
 */
export type ScheduleInput = {
  readonly name: string;
  readonly spec: ScheduleSpec;
  readonly data?: unknown;
  readonly until?: string;
};

/**
 * What `schedule` answers with: whether the name was newly created, and the resulting record.
 *
 * `created` distinguishes an insert from an update — the same signal an HTTP `PUT` turns into 201
 * versus 200 (ADR-0018) — and is read from the upsert itself rather than from a lookup in front of
 * it. A Schedule that resolved to no future fire is `created: false` with a `null` `nextFireAt`,
 * since nothing was armed.
 */
export type ScheduleOutcome = {
  readonly created: boolean;
  readonly schedule: ScheduleRecord;
};

/**
 * The zone a cron spec is evaluated in: the caller's, or UTC when they named none. Resolved once,
 * here, so storage, computation, and the read model all agree on the zone in force.
 */
function zoneOf(spec: { readonly tz?: string }): string {
  return spec.tz ?? defaultZone;
}

/** Refuses an unknown IANA zone up front, so it is a legible 400 rather than a fire-time throw. */
function assertKnownZone(tz: string): void {
  if (!IANAZone.isValidZone(tz)) {
    throw new ScheduleSpecError(`unknown time zone ${JSON.stringify(tz)}`);
  }
}

/**
 * The next occurrence of a cron expression strictly after `after`, in `tz`, or `undefined` when the
 * next occurrence would fall past `until`.
 *
 * The whole of the cron arm's calendar arithmetic, delegated to `cron-parser`: `next()` returns the
 * occurrence strictly after `currentDate`, which is exactly "strictly after now" (ADR-0018). The
 * `until` bound is checked here rather than through the parser's own end date, so "at or before it"
 * is enforced by our own comparison and does not rest on the library's inclusivity. A bad `expr` or
 * an unknown `tz` throws `ScheduleSpecError`, the refusal `schedule` surfaces.
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
  // A cron has no year field, so an unbounded expression always has a next occurrence; `next()`
  // only runs out against an end date, which this call does not set.
  const next = interval.next().toDate();
  if (until !== undefined && next.getTime() > until.getTime()) return undefined;
  return next;
}

/**
 * Parses an ISO instant that a caller supplied as a bound, refusing a malformed one rather than
 * dropping it silently — a cron with an unreadable `until` would otherwise persist as one that never
 * respects its bound.
 */
export function parseUntil(until: string): Date {
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) {
    throw new ScheduleSpecError(`malformed until instant ${JSON.stringify(until)}`);
  }
  return at;
}

/**
 * The next instant a spec fires strictly after `now`, or `undefined` when it has none. Throws
 * `ScheduleSpecError` for a cron whose `expr` or `tz` it will not accept.
 *
 * This is the whole of "the next fire is derived forward from now":
 *
 *  - For a `once`, the sole occurrence is its instant, which counts only if it is still in the
 *    future — an instant at or before `now` is not a future occurrence, so the Schedule is spent and
 *    never enumerated (ADR-0018). A malformed instant is treated as spent, refused at the HTTP door
 *    in a later ticket where there is a caller to answer.
 *  - For a `cron`, it is the next occurrence strictly after `now` in the spec's zone, or `undefined`
 *    when that occurrence falls past `until` — the bounded Schedule has already spent its last fire.
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
 * Refuses a create that could never fire, throwing `ScheduleSpecError` so the agent-facing route
 * answers it as a 400 — the loud refusal a caller in the moment earns, where boot re-derivation
 * drops the very same Schedule silently because it has nobody to answer (ADR-0018).
 *
 * The programmatic `schedule` is deliberately lenient about this: an Operator re-running a boot-time
 * declaration whose `once` has since passed converges to a spent, unarmed Schedule rather than a
 * thrown boot. The agent submitting the same over HTTP is a caller making a mistake it should learn
 * of at once, so the route runs this **first** — before anything is written, so a 400 never mutates —
 * and only calls `schedule` once a live fire is assured, which is also what keeps the read model's
 * `nextFireAt` non-null on every answer.
 *
 * Every refusal reuses the very derivation `schedule` will run, so the two cannot disagree about what
 * is acceptable: a bad cron `expr` or an unknown `tz` throws out of `nextFireOf`, and a malformed
 * `until` out of `parseUntil`. What this adds over those is the two cases `nextFireOf` reports as
 * *spent* rather than throwing — a `once` whose instant is malformed or already past — and the cron
 * whose `until` already sits at or before its next occurrence, which is a create that resolves to no
 * fire at all.
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
 * The next fire of a persisted **row** strictly after `now`, or `undefined` when it has none — the
 * row-shaped counterpart of `nextFireOf`, which works from an input spec before a row exists.
 *
 *  - A `cron` derives its next occurrence strictly after `now` in its stored zone, or `undefined`
 *    when that would fall past `until` (the bounded Schedule has spent its last fire).
 *  - A `once` is its stored instant while that is still in the future, and `undefined` once `now` has
 *    reached it — a spent one-shot.
 *
 * The one place the Scheduler turns a stored row into a fire, shared by the boot re-derivation and
 * by maturing a due row, so both derive forward the same way (ADR-0018).
 */
export function nextFireOfRow(row: typeof schedules.$inferSelect, now: Date): Date | undefined {
  if (row.kind === "cron" && row.cronExpr !== null && row.tz !== null) {
    return cronNextAfter(row.cronExpr, row.tz, now, row.until ?? undefined);
  }
  const at = row.at;
  if (at === null || at.getTime() <= now.getTime()) return undefined;
  return at;
}

/** What maturing a due row decides: the occurrence to announce, whether to announce it, and the
 * fire to advance to (`undefined` retires the Schedule). */
export type Maturation = {
  readonly scheduledFor: Date;
  readonly emit: boolean;
  readonly next: Date | undefined;
};

/**
 * What maturing a due row does: announce the occurrence it was armed for and advance to the next
 * fire strictly after `now`, both in one act so a crash cannot split them (ADR-0023).
 *
 * The stored `at` is the occurrence this fire is *for*, and it is announced verbatim: a `once`
 * announces its instant and retires (`next` is `undefined`), and a `cron` announces its stored
 * occurrence and advances to the next one strictly after `now` (retiring if that passes `until`).
 *
 * The only accepted residual is a **continuously-live process frozen straight through a fire time**:
 * its timer wakes late, `now` is past `at`, and the armed occurrence is announced once, late — but
 * `next` is still derived strictly forward from `now`, so the frozen gap is jumped, never enumerated
 * into the serial lane. A **restart** never lands here: `start` re-derives every row's next fire
 * forward before the timer is armed (`nextFireOfRow` above), so a booted Scheduler's `at` is always
 * strictly in the future and a missed occurrence is dropped, not replayed — the restart case is
 * clean however many occurrences fell during the outage (ADR-0018).
 */
export function matureOf(row: typeof schedules.$inferSelect, now: Date): Maturation {
  const at = row.at;
  if (at === null) {
    // Guarded by `selectDue`, which never returns a null `at`; defensive so a caller cannot emit a
    // fire for an instant that does not exist.
    return { scheduledFor: now, emit: false, next: undefined };
  }
  return { scheduledFor: at, emit: true, next: nextFireOfRow(row, now) };
}

/** The columns a row is written from, derived once from an input and a computed next fire. */
type ScheduleRow = typeof schedules.$inferInsert;

/**
 * The row a create-or-update writes: every column, so an upsert that changes a Schedule's kind
 * clears the columns of the kind it no longer is. `at` is the next fire for both kinds.
 */
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
 * Writes a Schedule by name, updating in place when the name already exists.
 *
 * `on conflict (name) do update` is the upsert the spec asks for: re-creating a name never adds a
 * second row and never silently drops the change (ADR-0018). The `set` names **every** column, so a
 * name that was a `once` and is re-created as a `cron` has its cron columns filled and its `once`
 * shape overwritten, and vice versa. Whether this inserted or updated is read from PostgreSQL's
 * `xmax`, which is zero on a freshly inserted row and non-zero on one an update touched — so the
 * create/update distinction comes from the write itself rather than a read racing in front of it.
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

/**
 * Advances a Schedule to its next fire, the update half of maturing a recurring one. Runs on the
 * fire's own transaction, so announcing the fire and advancing to the next commit together or not at
 * all (ADR-0023). Sets only `at`: the expression, zone, bound, and data are unchanged by a fire.
 */
export async function advanceSchedule<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  name: string,
  at: Date,
): Promise<void> {
  await handle.update(schedules).set({ at }).where(eq(schedules.name, name));
}

/**
 * Removes a Schedule by name, answering whether one was there.
 *
 * The one delete for every reason a row leaves: a cancel, an upsert that resolved to no future
 * fire, and the retirement half of a fire (which runs on the fire's own transaction and so passes
 * its handle in). The boolean is what lets a cancel refuse an unknown name rather than answer an
 * idempotent success it cannot honestly claim (ADR-0018).
 */
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
 * Every Schedule, ascending by next fire and then by name, as the list answers.
 *
 * Ordered by `at` — the next fire for both kinds — and by `name` to break the tie deterministically.
 * On the part's own handle: a read takes no transaction (ADR-0023).
 *
 * `limit` bounds the page for the agent's `GET /schedules`, which caps its envelope like every
 * other list (ADR-0035); the boot re-derivation calls this with none, because it must re-derive
 * **every** row's next fire and a cap would silently leave the rest armed on a stale `at`.
 */
export async function selectSchedules(
  handle: SchedulerHandle,
  limit?: number,
): Promise<(typeof schedules.$inferSelect)[]> {
  const ordered = handle.select().from(schedules).orderBy(asc(schedules.at), asc(schedules.name));
  return limit === undefined ? ordered : ordered.limit(limit);
}

/**
 * One Schedule by name, or `undefined` when the name addresses none — what the agent's
 * `GET /schedules/:name` reads.
 *
 * A row exists only while a Schedule is armed, so a found row is a **live** Schedule with a
 * future `at`, which is why the read model it becomes always has a non-null `nextFireAt`
 * (ADR-0018). On the part's own handle: a read takes no transaction (ADR-0023).
 */
export async function selectSchedule(
  handle: SchedulerHandle,
  name: string,
): Promise<typeof schedules.$inferSelect | undefined> {
  const [row] = await handle.select().from(schedules).where(eq(schedules.name, name));
  return row;
}

/**
 * The Schedules due to fire at `now`: any whose stored next fire `now` has reached, of either kind.
 *
 * `at` is the next fire for both a `once` and a `cron` — a cron materialises its next occurrence
 * forward into the same column — so one comparison selects both, and `matureOf` decides per row
 * whether a due cron announces the occurrence or skips a stale one. A row exists only while it is
 * armed, so a due row is one whose future fire `now` has reached.
 */
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
 * What the autonomous timer arms against: the soonest fire is the only one the next wake needs to
 * know about, and the cap bounds how long it sleeps waiting for it. `at` is the next fire for both
 * kinds, so this reads the soonest across them off one column. A cron whose stored `at` sits in the
 * past after an outage wins this ordering and arms an immediate wake, whose `tick` skips the stale
 * occurrence and re-derives forward — the self-correction the timer is built on.
 */
export async function earliestFireAt(handle: SchedulerHandle): Promise<Date | undefined> {
  const [row] = await handle
    .select({ at: schedules.at })
    .from(schedules)
    .orderBy(asc(schedules.at))
    .limit(1);
  return row?.at ?? undefined;
}

/**
 * The read model of an armed `once` Schedule. A persisted `once` is armed, so its instant is both
 * its `spec.at` and its `nextFireAt`. The one builder both paths that answer with an armed `once`
 * go through — the upsert response (`scheduleRecord`) and the list (`asScheduleRecord`) — so the two
 * cannot drift apart.
 */
function onceRecord(name: string, at: Date, data: unknown): ScheduleRecord {
  const iso = at.toISOString();
  return { name, spec: { kind: "once", at: iso }, data, until: null, nextFireAt: iso };
}

/**
 * The read model of an armed `cron` Schedule. `nextFireAt` is the materialised next occurrence; the
 * `spec` carries the expression and the resolved zone, and `until` the bound, so a caller sees the
 * arrangement it will keep. The one builder both armed-`cron` paths go through, as `onceRecord` is.
 */
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
 * The read model `schedule` answers with, built from what it has in hand — the input and the
 * computed next fire — so the answer and a later list agree byte-for-byte without a read-back.
 *
 * An armed Schedule (`next` defined) is built through the very builders `asScheduleRecord` reads a
 * row through, which is what makes "agree byte-for-byte" a shared fact rather than a coincidence of
 * two hand-written shapes. A spent one (`next` `undefined`) has a `null` `nextFireAt` and, for a
 * `once`, echoes its armed instant from the input since there is no computed fire to state.
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

/** The read model for a row: an armed `once` or `cron`, reconstructed from its stored columns. */
export function asScheduleRecord(row: typeof schedules.$inferSelect): ScheduleRecord {
  const at = row.at;
  if (row.kind === "once" && at !== null) {
    return onceRecord(row.name, at, row.data);
  }
  if (row.kind === "cron" && at !== null && row.cronExpr !== null && row.tz !== null) {
    return cronRecord(row.name, row.cronExpr, row.tz, row.until, at, row.data);
  }
  // A row that is neither shape is a database in a state this part does not write; surface it rather
  // than answer a half-formed record.
  throw new Error(`Schedule ${row.name} has an unsupported kind ${JSON.stringify(row.kind)}`);
}
