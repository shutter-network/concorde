import { and, eq, like, ne, sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { listenApplicationName } from "../db/db.ts";
import type { Db } from "../db/index.ts";

const backends = pgTable("pg_stat_activity", {
  pid: integer("pid").notNull(),
  applicationName: text("application_name").notNull(),
  databaseName: text("datname"),
});

const listeners = and(
  like(backends.applicationName, `${listenApplicationName}%`),
  eq(backends.databaseName, sql`current_database()`),
  ne(backends.pid, sql`pg_backend_pid()`),
);

export async function listeningBackends(db: Db): Promise<number> {
  const rows = await db
    .handle({ backends })
    .select({ pid: backends.pid })
    .from(backends)
    .where(listeners);
  return rows.length;
}

export async function cutListeningBackends(db: Db): Promise<void> {
  await db
    .handle({ backends })
    .select({ terminated: sql<boolean>`pg_terminate_backend(${backends.pid})` })
    .from(backends)
    .where(listeners);
}
