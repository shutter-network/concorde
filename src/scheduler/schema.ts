/**
 * An Operator's `drizzle-kit` reads this file, by the path of the `./schema/index.ts` beside it
 * (ADR-0046, ADR-0055). Keep it to the table and the values that define it, and add no import of
 * another component's schema: a Schedule references nobody, so this subpath can be listed on its
 * own.
 *
 * A Schedule is mutable, unlike a Message or a Decision. A create is an upsert on the name, a fire
 * writes the next one back, and a Schedule with no future fire is deleted. So there is no `state`
 * column, no tombstone and nothing that sweeps: the row is the arming.
 *
 * `at` holds the next fire of both kinds, a `cron` materialising its next occurrence into the same
 * column a `once` keeps its instant in. That is what lets the due-check and the timer's re-arm read
 * one column and one comparison. Do not split it in two.
 */

import { type SQL, sql } from "drizzle-orm";
import { check, jsonb, type PgColumn, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The PostgreSQL schema the Scheduler's table lives in, `saf_scheduler`.
 *
 * Prefixed because the framework is installed into a database it does not own, and not
 * configurable: the table is compiled against this object, and the same object is what a generation
 * reads.
 */
export const schedulerSchema = pgSchema("saf_scheduler");

export const scheduleKinds = ["once", "cron"] as const;

export type ScheduleKind = (typeof scheduleKinds)[number];

// Derived from the same array the type is, rather than spelled a second time in SQL. A kind added
// to one and not the other gives a database that refuses a value the code believes in.
//
// The values go in with `sql.raw`, because a CHECK constraint is DDL and a bind parameter has
// nowhere to be bound. They are our own literals, from a list a few lines up.
function kindIsKnown(column: PgColumn, kinds: readonly string[]): SQL {
  const literals = kinds.map((kind) => `'${kind}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * One Schedule: a named instruction to emit the Scheduler's one Signal at future times.
 *
 * `name` is the primary key and the only identifier. There is no surrogate id beside it, so a
 * create is an upsert on the name and a cancel is a delete of it.
 */
export const schedules = schedulerSchema.table(
  "schedules",
  {
    // One flat namespace, shared by the agent and the Operator. Nothing scopes it by creator, so
    // either of them addresses, updates and cancels what the other arranged.
    name: text("name").primaryKey(),
    // The discriminant every read branches on. The two checks below hold each kind to the columns
    // it needs, so a row of either kind is complete by the time it is selected.
    kind: text("kind").$type<ScheduleKind>().notNull(),
    // Nullable at the column level and never null in a persisted row, both checks below requiring
    // it. Nullable because a `once` and a `cron` reach it by different routes and neither check can
    // be written as a plain `NOT NULL`.
    at: timestamp("at", { withTimezone: true }),
    // Only ever text `cron-parser` already accepted. The database validates nothing here, so a
    // write path that skipped the parse would store an expression that throws at fire time.
    cronExpr: text("cron_expr"),
    // Stored resolved rather than as the caller wrote it, so the read model shows the zone actually
    // in force and a caller who named none sees `UTC` instead of a blank.
    tz: text("tz"),
    // A `cron` bound only. A `once` bounds itself by firing once, so the layer above ignores an
    // `until` on one and the Agent route refuses it.
    until: timestamp("until", { withTimezone: true }),
    // `jsonb` for the reason `signals.payload` is. Never interpreted here and copied verbatim into
    // the fired Signal, so nothing about its shape is this component's business.
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

export const schedulerTables = { schedules };
