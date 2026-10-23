import { type SQL, sql } from "drizzle-orm";
import { check, jsonb, type PgColumn, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const schedulerSchema = pgSchema("concorde_scheduler");

export const scheduleKinds = ["once", "cron"] as const;

export type ScheduleKind = (typeof scheduleKinds)[number];

function kindIsKnown(column: PgColumn, kinds: readonly string[]): SQL {
  const literals = kinds.map((kind) => `'${kind}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

export const schedules = schedulerSchema.table(
  "schedules",
  {
    name: text("name").primaryKey(),
    kind: text("kind").$type<ScheduleKind>().notNull(),
    at: timestamp("at", { withTimezone: true }),
    cronExpr: text("cron_expr"),
    tz: text("tz"),
    until: timestamp("until", { withTimezone: true }),
    data: jsonb("data"),
  },
  (table) => [
    check("schedules_kind_known", kindIsKnown(table.kind, scheduleKinds)),
    check("schedules_once_has_at", sql`${table.kind} <> 'once' or ${table.at} is not null`),
    check(
      "schedules_cron_has_fields",
      sql`${table.kind} <> 'cron' or (${table.cronExpr} is not null and ${table.tz} is not null and ${table.at} is not null)`,
    ),
  ],
);

export const schedulerTables = { schedules };
