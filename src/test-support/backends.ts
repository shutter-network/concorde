/**
 * What PostgreSQL says about the connections a Store has open.
 *
 * `store.listen` holds a connection outside the pool, and the only place that is
 * observable from is the server: nothing in the Store's own surface hands the
 * connection out, deliberately. The same view is also the only way to break one
 * the way a network does — `pg_terminate_backend` cuts it from underneath the
 * client, which is what a reconnect has to survive.
 *
 * `pg_stat_activity` is read through an ordinary table object rather than raw SQL
 * so the rows come back typed. It lives in `pg_catalog`, which is always in the
 * search path, so the unqualified name resolves.
 */

import { and, eq, like, ne, sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import type { Store } from "../store/index.ts";
import { listenApplicationName } from "../store/store.ts";

/** Enough of `pg_stat_activity` to find a listening connection in this database. */
const backends = pgTable("pg_stat_activity", {
  pid: integer("pid").notNull(),
  applicationName: text("application_name").notNull(),
  databaseName: text("datname"),
});

/**
 * The listening connections of this database, and never the connection asking —
 * which is a pooled one, so it would not match anyway, but a `select` that could
 * terminate its own backend is not a thing to leave to a `like`.
 */
const listeners = and(
  like(backends.applicationName, `${listenApplicationName}%`),
  eq(backends.databaseName, sql`current_database()`),
  ne(backends.pid, sql`pg_backend_pid()`),
);

/** Every backend that a `store.listen` opened against the Store's own database. */
export async function listeningBackends(store: Store): Promise<number> {
  const rows = await store
    .handle({ backends })
    .select({ pid: backends.pid })
    .from(backends)
    .where(listeners);
  return rows.length;
}

/**
 * Has the server terminate every listening connection, as an operator or a network
 * would.
 */
export async function cutListeningBackends(store: Store): Promise<void> {
  await store
    .handle({ backends })
    .select({ terminated: sql<boolean>`pg_terminate_backend(${backends.pid})` })
    .from(backends)
    .where(listeners);
}
