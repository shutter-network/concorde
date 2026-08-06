/**
 * The Scheduler's one table: `schedules`, in the `saf_scheduler` schema.
 *
 * Public API, re-exported from `shared-agent-framework/scheduler`. An Operator barrels that subpath
 * into their own `schema.ts` and generates their DDL from it.
 *
 * An Operator's `drizzle-kit` reads this file through that barrel. Keep it to the table and the
 * values that define it. It imports no other Component's schema. A Schedule references nobody, so a
 * barrel carrying it alone generates cleanly.
 *
 * A Schedule is mutable by name, unlike a Message or a Decision. Creation is an upsert. And a
 * Schedule with no future fire is deleted rather than kept in a lifecycle state. So there is no
 * `state` column and nothing sweeps: the row is the arming.
 *
 * `at` is the next fire for both kinds. For a `once` it is the caller's chosen instant. For a
 * `cron` it is the next occurrence materialised forward from now, recomputed on every fire. That is
 * what lets `selectDue` and `earliestFireAt` read both kinds off one column.
 */

import { type SQL, sql } from "drizzle-orm";
import { check, jsonb, type PgColumn, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The Scheduler's schema, named for the Component rather than only its subject.
 *
 * Prefixed because the framework is installed into a database it does not own. The name is not
 * theirs to change: the table below is compiled against it, and their generation reads this object.
 */
export const schedulerSchema = pgSchema("saf_scheduler");

/**
 * The two shapes a Schedule's recurrence takes, and the discriminant the row branches on.
 *
 * `once` is a single absolute instant and needs no library. `cron` is a recurring expression in a
 * named time zone, parsed by `cron-parser`.
 */
export const scheduleKinds = ["once", "cron"] as const;

/** Which of the two shapes a stored Schedule is, as the `kind` column's type. */
export type ScheduleKind = (typeof scheduleKinds)[number];

/**
 * The constraint that keeps `kind` to the discriminants above.
 *
 * Derived from the same array the type is, rather than spelled a second time in SQL. A kind added
 * to one and not the other gives a database that rejects a value the code believes in.
 *
 * The values go in with `sql.raw`, because a CHECK constraint is DDL. A bind parameter has nowhere
 * to be bound. They are our own literals, from a list a few lines up.
 */
function kindIsKnown(column: PgColumn, kinds: readonly string[]): SQL {
  const literals = kinds.map((kind) => `'${kind}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * One Schedule: a named instruction to emit the Scheduler's fixed Signal at future times.
 *
 * `name` is the primary key and the sole identifier. There is no surrogate id. So creation is a
 * `PUT`-shaped upsert on the name, and a cancel is a delete of it.
 */
export const schedules = schedulerSchema.table(
  "schedules",
  {
    /**
     * The creator's chosen name, unique across both creators in one flat namespace.
     *
     * The sole identifier. It addresses the Schedule for reading and cancellation, and each fired
     * Signal carries it.
     */
    name: text("name").primaryKey(),
    /**
     * Which recurrence shape this row is: the discriminant `at`, the cron columns and the read
     * model branch on. The check constraints below hold each kind to the columns it requires.
     */
    kind: text("kind").$type<ScheduleKind>().notNull(),
    /**
     * The next fire instant, for both kinds: a `once`'s chosen instant, or a `cron`'s next
     * occurrence materialised forward from now.
     *
     * Nullable at the column level. But a persisted row of either kind always has one, because the
     * two checks below require it. So `selectDue` and `earliestFireAt` read a fire off this column
     * for every row.
     */
    at: timestamp("at", { withTimezone: true }),
    /**
     * The cron expression, for a `cron` Schedule. Null for a `once` one.
     *
     * `cron-parser` parses and validates it at creation, and the database never does. So this
     * column only stores text the Scheduler already accepted.
     */
    cronExpr: text("cron_expr"),
    /**
     * The IANA time zone the cron expression is evaluated in. Null for a `once`, whose instant is
     * absolute.
     *
     * Stored resolved, so the read model shows the zone actually in force. A caller who omits it
     * gets `UTC`, never the server's local zone.
     */
    tz: text("tz"),
    /**
     * The optional end instant of a `cron` Schedule: after its last occurrence at or before this,
     * the Schedule is retired. Null for an unbounded cron and for every `once`.
     */
    until: timestamp("until", { withTimezone: true }),
    /**
     * The creator's opaque data, emitted verbatim inside the fired Signal's payload.
     *
     * `jsonb` for the reason `signals.payload` is. The Scheduler never interprets it, so what a
     * Schedule carries is the creator's convention. Their Handler is where it is read. Nullable,
     * because a creator may attach none.
     */
    data: jsonb("data"),
  },
  (table) => [
    check("schedules_kind_known", kindIsKnown(table.kind, scheduleKinds)),
    // A `once` with no instant has no fire and could never be enumerated, so the database refuses
    // one. Written as "not once, or has an `at`", so a `cron` row is judged by its own check below.
    check("schedules_once_has_at", sql`${table.kind} <> 'once' or ${table.at} is not null`),
    // A `cron` carries its expression, its zone and a materialised next fire: the three a fire and
    // a re-arm read. Written as "not cron, or has all three", so a `once` row is unaffected. Its
    // `cron_expr` and `tz` are legitimately null. `until` is absent on purpose: an unbounded cron
    // has none, and the row is deleted the moment its next fire would pass one.
    check(
      "schedules_cron_has_fields",
      sql`${table.kind} <> 'cron' or (${table.cronExpr} is not null and ${table.tz} is not null and ${table.at} is not null)`,
    ),
  ],
);

/**
 * Everything the Scheduler keeps, as `db.handle` wants it.
 *
 * One object, so every module of this Component asks for the same handle by the same name.
 */
export const schedulerTables = { schedules };
