/**
 * The Scheduler's types and the statements the firing core is made of: the read model every
 * surface answers with, the Signal payload a matured Schedule emits, and the upsert/list/delete
 * over this part's one table.
 *
 * Kept beside the Component the way `messages.ts` sits beside the HTTP Messenger: the record
 * shapes here are not only the wire shapes, they are what the upsert answers with and what a
 * Handler is written against, so they live with the statements rather than in a routes module a
 * later ticket adds.
 */

import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Handle } from "../db/index.ts";
import { type schedulerTables, schedules } from "./schema.ts";

/** A handle typed to this part's own tables, and to no other part's (ADR-0022). */
type SchedulerHandle = Handle<typeof schedulerTables>;

/**
 * How a Schedule recurs: an **extensible tagged union**, with `kind` as the seam a future format
 * is added at rather than a field overloaded to mean several things (ADR-0018).
 *
 * This ticket ships the `once` arm alone — a single absolute instant, which needs no library and
 * is the agent's most ordinary request. The `cron` arm (a recurring expression in a named time
 * zone) is a later ticket, and adding it is a new member of this union rather than a rethink of
 * it: the row's discriminant column already exists, and the persisted state below is shaped for
 * both.
 */
export type ScheduleSpec = { readonly kind: "once"; readonly at: string };

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
 * row's columns, `data` is the creator's opaque payload, and `nextFireAt` is when it will next
 * fire — derived forward from now rather than read from a trusted timestamp, and `null` only for a
 * Schedule that has no future fire and is therefore spent (ADR-0018).
 */
export type ScheduleRecord = {
  readonly name: string;
  readonly spec: ScheduleSpec;
  readonly data: unknown;
  readonly nextFireAt: string | null;
};

/**
 * What a create-or-update takes: the name, the recurrence, and the creator's opaque data.
 *
 * `data` is optional and stored as `null` when omitted. A cron Schedule's optional `until` arrives
 * with the cron arm; there is nothing for a `once` to bound.
 */
export type ScheduleInput = {
  readonly name: string;
  readonly spec: ScheduleSpec;
  readonly data?: unknown;
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
 * The next instant a spec fires strictly after `now`, or `undefined` when it has none.
 *
 * This is the whole of "the next fire is derived forward from now": for a `once`, the sole
 * occurrence is its instant, which counts only if it is still in the future — an instant at or
 * before `now` is not a future occurrence, so the Schedule is spent and never enumerated
 * (ADR-0018). A malformed instant has no occurrence either, and is treated as spent rather than
 * stored as a Schedule that could never fire; the HTTP layer refuses it at the door in a later
 * ticket, where there is a caller to answer.
 */
export function nextFireOf(spec: ScheduleSpec, now: Date): Date | undefined {
  const at = new Date(spec.at);
  const atMs = at.getTime();
  if (Number.isNaN(atMs) || atMs <= now.getTime()) return undefined;
  return at;
}

/** The columns a row is written from, derived once from an input and a computed next fire. */
type ScheduleRow = typeof schedules.$inferInsert;

/**
 * Writes a Schedule by name, updating in place when the name already exists.
 *
 * `on conflict (name) do update` is the upsert the spec asks for: re-creating a name never adds a
 * second row and never silently drops the change (ADR-0018). Whether this inserted or updated is
 * read from PostgreSQL's `xmax`, which is zero on a freshly inserted row and non-zero on one an
 * update touched — so the create/update distinction comes from the write itself rather than a
 * read racing in front of it.
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
      set: { kind: row.kind, at: row.at, data: row.data ?? null },
    })
    .returning({ created: sql<boolean>`(xmax = 0)` });
  if (written === undefined) {
    throw new Error("upserting a Schedule wrote no row");
  }
  return { created: written.created };
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
 * Ordered by `at` because for a `once` that is its next fire, and by `name` to break the tie
 * deterministically. On the part's own handle: a read takes no transaction (ADR-0023).
 */
export async function selectSchedules(
  handle: SchedulerHandle,
): Promise<(typeof schedules.$inferSelect)[]> {
  return handle.select().from(schedules).orderBy(asc(schedules.at), asc(schedules.name));
}

/**
 * The Schedules that are due to fire at `now`: a `once` whose instant is at or before it.
 *
 * A row exists only while it is armed — an already-past `once` is never persisted — so a due row
 * is one whose future instant `now` has reached, which is exactly what should fire. The cron arm
 * adds its own due-ness here.
 */
export async function selectDue(
  handle: SchedulerHandle,
  now: Date,
): Promise<(typeof schedules.$inferSelect)[]> {
  return handle
    .select()
    .from(schedules)
    .where(and(eq(schedules.kind, "once"), lte(schedules.at, now)))
    .orderBy(asc(schedules.at), asc(schedules.name));
}

/**
 * The read model of an armed `once` Schedule, built the one way both surfaces that answer with one
 * use it: the upsert response, which has the instant in hand before it reads a row back, and the
 * list, which has the row. A persisted `once` is armed, so its instant is both its `spec.at` and
 * its `nextFireAt` — stated once here so the two callers cannot drift apart.
 */
export function onceRecord(name: string, at: Date, data: unknown): ScheduleRecord {
  const iso = at.toISOString();
  return { name, spec: { kind: "once", at: iso }, data, nextFireAt: iso };
}

/** The read model for a row, given the `now` its next fire is derived against. */
export function asScheduleRecord(row: typeof schedules.$inferSelect): ScheduleRecord {
  // Only `once` is written today, and its check constraint guarantees `at`. The read model's
  // `nextFireAt` is that instant: a persisted `once` is armed, so its next fire is when it fires.
  const at = row.at;
  if (row.kind === "once" && at !== null) {
    return onceRecord(row.name, at, row.data);
  }
  // No other kind is persisted yet; a row that is neither is a database in a shape this ticket
  // does not write. Surface it rather than answer a half-formed record.
  throw new Error(`Schedule ${row.name} has an unsupported kind ${JSON.stringify(row.kind)}`);
}
