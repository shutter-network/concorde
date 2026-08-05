/**
 * The Scheduler's one table, in the part's own PostgreSQL schema
 * ([`data-model.md`](../../docs/data-model.md)).
 *
 * Not public API, for the reason the other parts' schemas are not: every part of the Gateway
 * owns a schema and no part reads another's tables, so these objects are exported for this
 * part's own modules and are deliberately absent from the package's `/scheduler` subpath
 * (ADR-0021, ADR-0022).
 *
 * `drizzle-kit` reads this file to generate `migrations/scheduler`, through a config file of
 * this part's own, so keep it to the table and the values it is defined in terms of. Unlike the
 * HTTP Messenger's there is **no hand-edited foreign key** here and no import of another part's
 * schema to avoid: a Schedule references nobody, so the only hand-edit a regeneration needs is
 * the `CREATE SCHEMA` removal every part needs.
 *
 * A Schedule is **mutable by name**, unlike a Message or a Decision: creation is an upsert, so
 * re-creating a name updates the row in place. And a Schedule with no future fire is **deleted**
 * rather than kept in a lifecycle state — a spent one-shot, a cancellation, a boot-time drop are
 * all the same row's absence — so there is no `state` column and nothing sweeps: the row *is* the
 * arming.
 */

import { type SQL, sql } from "drizzle-orm";
import { check, jsonb, type PgColumn, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The Scheduler's schema, named for the part rather than only its subject, and prefixed for the
 * reason the other parts' are: the framework is installed into a database it does not own, and
 * this name is not an Operator's to change — the table below is compiled against it, so a
 * descriptor naming a different schema would migrate one place and read another.
 */
export const schedulerSchema = pgSchema("saf_scheduler");

/**
 * The two shapes a Schedule's recurrence takes, and the discriminant the row branches on
 * (ADR-0018). `once` is a single absolute instant and needs no library; `cron` is a recurring
 * expression in a named time zone, whose firing arrives in a later ticket. The value is stored so
 * that the cron arm can be added without a fresh rethink of the row: the discriminant is already
 * here, and a cron row is one whose `at` is null and whose own columns a later migration adds.
 *
 * `cron` is in the domain now even though nothing writes it yet, so that adding it is code and
 * data rather than an `ALTER` of this constraint.
 */
export const scheduleKinds = ["once", "cron"] as const;
export type ScheduleKind = (typeof scheduleKinds)[number];

/**
 * The constraint that keeps `kind` to the discriminants above.
 *
 * Derived from the same array the type is, rather than spelled a second time in SQL: a kind added
 * to one and not the other gives a database that rejects a value the code believes in. The values
 * go in with `sql.raw` because a CHECK constraint is DDL — a bind parameter has nowhere to be
 * bound — and they are our own literals, from a list a few lines up. The same shape as
 * `src/signals/schema.ts`'s check helper and the HTTP Messenger's `directionIsKnown`, and a copy
 * rather than an import for the reason those give: a schema file importing another part's makes the
 * generator emit that part's tables into this folder too.
 */
function kindIsKnown(column: PgColumn, kinds: readonly string[]): SQL {
  const literals = kinds.map((kind) => `'${kind}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * One Schedule: a named instruction to emit the Scheduler's fixed Signal at one or more future
 * times, addressed by the `name` a creator chose (ADR-0018).
 *
 * `name` is the primary key and the sole identifier — there is no surrogate id — so creation is a
 * `PUT`-shaped upsert on it and a cancel is a delete of it.
 */
export const schedules = schedulerSchema.table(
  "schedules",
  {
    /**
     * The creator's chosen name, unique across both creators in one flat namespace, and the sole
     * identifier: it addresses the Schedule for reading and cancellation and is the reference
     * carried in each fired Signal (ADR-0018).
     */
    name: text("name").primaryKey(),
    /**
     * Which recurrence shape this row is, the discriminant `at` and the cron columns branch on.
     * Only `once` is written today; `cron` is in the check constraint's domain so that its arm
     * is additive later.
     */
    kind: text("kind").$type<ScheduleKind>().notNull(),
    /**
     * The one-shot instant, for a `once` Schedule. Null for a `cron` one, whose next fire is
     * computed from its expression rather than stored — which is why this column is nullable and
     * the check below only requires it for `once`.
     */
    at: timestamp("at", { withTimezone: true }),
    /**
     * The creator's opaque data, emitted verbatim inside the fired Signal's payload. `jsonb` for
     * the reason `signals.payload` is: the Scheduler never interprets it, so what a given
     * Schedule carries is the creator's convention and their Handler is where it is read. Nullable
     * because a creator may attach none.
     */
    data: jsonb("data"),
  },
  (table) => [
    check("schedules_kind_known", kindIsKnown(table.kind, scheduleKinds)),
    // A `once` Schedule with no instant has no fire and could never be enumerated, so the database
    // refuses one rather than storing a row nothing can act on. Written as "not once, or has an
    // `at`" so that a `cron` row — whose `at` is legitimately null — is unaffected, and so that the
    // cron arm adds its own analogue rather than loosening this one.
    check("schedules_once_has_at", sql`${table.kind} <> 'once' or ${table.at} is not null`),
  ],
);

/**
 * Everything the Scheduler keeps, as `db.handle` wants it: one object, so every module of this
 * part asks for the same handle by the same name.
 */
export const schedulerTables = { schedules };
