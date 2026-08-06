/**
 * The Scheduler's one table, in the part's own PostgreSQL schema
 * ([`data-model.md`](../../docs/data-model.md)).
 *
 * **Public API, on `shared-agent-framework/scheduler/schema` and nowhere else**, for the
 * reason the other parts' schemas are: an Operator barrels this module into their own
 * `schema.ts` and generates from it
 * ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md)). That reverses
 * ADR-0021/0022's "deliberately absent from the `/scheduler` subpath" — `/scheduler` is
 * still the part's API and these objects are still not on it. No part reading another's
 * tables remains a discipline rather than something the objects being private enforces.
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
 *
 * `at` is the **next fire** for both kinds — for a `once` it is the caller's chosen instant, and
 * for a `cron` it is the next occurrence materialised forward from now, recomputed on every fire.
 * That is what lets `selectDue` and `earliestFireAt` order and select both kinds off one column
 * (ADR-0018). The cron arm's own columns — `cron_expr`, `tz`, and an optional `until` — are added
 * additively over ticket 01's shape: the discriminant was already here and `at` was already
 * nullable, so the arm is an `ALTER` that adds columns and a check rather than a rethink of the
 * table.
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
 * expression in a named time zone, parsed by `cron-parser`. Ticket 01 put `cron` in this domain
 * before anything wrote it, so that its arm was additive: this array is unchanged, and the cron
 * arm arrived as a migration that adds columns rather than one that widens the discriminant.
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
     * Which recurrence shape this row is, the discriminant `at`, the cron columns, and the read
     * model branch on. Both `once` and `cron` are written; the check constraints below hold each
     * kind to the columns it requires.
     */
    kind: text("kind").$type<ScheduleKind>().notNull(),
    /**
     * The next fire instant, for **both** kinds: a `once`'s chosen instant, or a `cron`'s next
     * occurrence materialised forward from now and recomputed on every fire. Nullable at the column
     * level because ticket 01 left it so for the cron arm to grow into, but a persisted row of
     * either kind always has one — the two checks below require it — so `selectDue` and
     * `earliestFireAt` read a fire off this column for every row.
     */
    at: timestamp("at", { withTimezone: true }),
    /**
     * The cron expression, for a `cron` Schedule. Null for a `once` one. Parsed and validated by
     * `cron-parser` at creation, never by the database, so this column only stores the text the
     * Scheduler already accepted.
     */
    cronExpr: text("cron_expr"),
    /**
     * The IANA time zone the cron expression is evaluated in, for a `cron` Schedule. Null for a
     * `once` one, whose instant is absolute. Stored resolved — a caller who omits it gets `UTC`,
     * never the server's local zone — so the read model shows the zone that is actually in force.
     */
    tz: text("tz"),
    /**
     * The optional end instant of a `cron` Schedule: after its last occurrence at or before this,
     * the Schedule is retired (deleted). Null for an unbounded cron and for every `once`, which
     * bounds itself by firing once.
     */
    until: timestamp("until", { withTimezone: true }),
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
    // `at`" so that a `cron` row is judged by its own check below rather than this one.
    check("schedules_once_has_at", sql`${table.kind} <> 'once' or ${table.at} is not null`),
    // A `cron` Schedule carries its expression, its zone, and a materialised next fire — the three
    // a fire and a re-arm read. Written as "not cron, or has all three" so that a `once` row, whose
    // `cron_expr` and `tz` are legitimately null, is unaffected. `until` is deliberately absent: an
    // unbounded cron has none, and the row is deleted the moment its next fire would pass `until`,
    // so a persisted cron always has a future `at` regardless.
    check(
      "schedules_cron_has_fields",
      sql`${table.kind} <> 'cron' or (${table.cronExpr} is not null and ${table.tz} is not null and ${table.at} is not null)`,
    ),
  ],
);

/**
 * Everything the Scheduler keeps, as `db.handle` wants it: one object, so every module of this
 * part asks for the same handle by the same name.
 */
export const schedulerTables = { schedules };
