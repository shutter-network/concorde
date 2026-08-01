import { fileURLToPath } from "node:url";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyFolder } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { Client, Pool } from "pg";

/**
 * A handle over the pool, or a handle inside a transaction, whichever schema it
 * carries.
 *
 * One type for both, and it must be spelled with `PgDatabase` from the dialect
 * package rather than `typeof` a handle, because `drizzle()` returns a handle
 * intersected with a client property that a transaction does not have
 * (drizzle-orm issue #3175). A cross-part signature widens `TSchema` rather than
 * naming one part's schema, since a transaction carries the schema of the handle
 * it was started on (ADR-0023).
 */
export type Handle<TSchema extends Record<string, unknown> = Record<string, never>> = PgDatabase<
  PgQueryResultHKT,
  TSchema
>;

/**
 * What `db.tx` hands its callback. A `Handle`, plus `rollback()` — which throws
 * `TransactionRollbackError` rather than returning, so anything using it as
 * control flow has to catch and filter (ADR-0023).
 */
export type Transaction = PgTransaction<
  PgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

/**
 * Where one part's migrations live and how they are tracked. Inert data: each
 * part of the Gateway exports one, and the Operator's entry point passes them
 * all to a single `db.migrate` call rather than any part applying its own.
 */
export type MigrationDescriptor = {
  /**
   * The folder holding the generated `.sql` files and `meta/_journal.json`.
   *
   * A `URL` and not a path, so that `new URL("../../migrations/signals",
   * import.meta.url)` is the only natural spelling and a working-directory
   * relative path cannot be written by accident. That distinction is invisible
   * in this repository and fatal outside it: the folder ships inside the
   * package, so resolving it against `process.cwd()` passes every test here and
   * breaks for every Operator.
   */
  readonly folder: URL;
  /**
   * The part's PostgreSQL schema. Created if absent, and holds `table` as well
   * as the part's own tables, so dropping the schema removes the part whole.
   */
  readonly schema: string;
  /**
   * The part's own migration tracking table.
   *
   * Per-part tracking is mandatory rather than tidy. Drizzle's guard compares
   * folder timestamps against only the newest row of a tracker, so two parts
   * sharing one make the older part's migrations **silently skipped while
   * `migrate` resolves successfully** (ADR-0022).
   */
  readonly table: string;
};

/**
 * What `db.listen` reports.
 *
 * `notified` is the point of it. The other two are about the connection
 * underneath, which a caller has to care about because **PostgreSQL queues
 * nothing for a listener that is not connected**: whatever was sent while the
 * connection was down is gone, with no gap visible in what does arrive.
 */
export type ChannelListener = {
  /** A notification arrived. `payload` is `NOTIFY`'s, empty when it carried none. */
  notified(payload: string): void;
  /**
   * The registration is in place — on the first connection, and again after every
   * loss. A caller that cannot afford to miss a notification does here whatever it
   * does on one, since a reconnection is exactly where one goes missing.
   */
  connected?(): void;
  /** The connection was lost, or an attempt to open one failed. Another follows. */
  lost?(error: unknown): void;
};

/** A registration made by `db.listen`. */
export type Listening = {
  /**
   * Stops listening and closes the connection. Idempotent, and safe to call while a
   * reconnection is pending.
   */
  close(): Promise<void>;
};

/**
 * The Gateway's PostgreSQL client: the pool, the schema-typed handle each part
 * queries on, transactions, `LISTEN` registrations, and migrations.
 *
 * Named for the client and not for the state it holds. "Store" named the
 * persistent state, and persistent state has nothing to open and nothing to
 * close — while every connection below is one somebody has to hand back
 * (ADR-0022).
 */
export type Db = {
  /**
   * A handle over the shared pool, typed to `schema`. Keeps `pg` internal: the
   * pool is never handed out, so `pg` does not join Fastify and Drizzle as
   * public API.
   */
  handle<TSchema extends Record<string, unknown>>(schema: TSchema): Handle<TSchema>;

  /**
   * Registers `listen <channel>` on a connection of the Db's own, outside the
   * pool, and reports what arrives on it.
   *
   * It cannot be a pooled connection: a `LISTEN` registration belongs to a session,
   * and a pooled connection goes back to the pool as soon as the query using it
   * resolves — so there is nothing left holding the session, and no way to ask for
   * that one back. This is therefore the one place the Db keeps a connection open
   * on a caller's behalf, and it is still the Db that owns it, which is what
   * keeps `pg` out of the public API (ADR-0022).
   *
   * Returns without waiting for the connection, and never rejects. A caller that
   * cannot connect yet is in exactly the position of one whose connection dropped an
   * hour in, and giving both one path means the reconnection path is the one that
   * runs on every start rather than only in an incident. Failures go to
   * `listener.lost` and are retried with a backoff until `close`.
   */
  listen(channel: string, listener: ChannelListener): Listening;

  /**
   * Applies each descriptor into its own schema with its own tracker, in the
   * order given. An explicit call and never a side effect of opening the Db,
   * so it can run from a separate entry point before a deploy.
   */
  migrate(...descriptors: MigrationDescriptor[]): Promise<void>;

  /** Runs `body` in a transaction: commits on return, rolls back on throw. */
  tx<T>(body: (tx: Transaction) => Promise<T>): Promise<T>;

  /**
   * Closes the pool and every connection `listen` opened. Nothing in the framework
   * calls this; shutdown is the Operator's.
   *
   * Listening connections are included because they are the Db's, and one left
   * connected keeps the process alive and its database undroppable — a leak whose
   * symptom is a deploy that never exits rather than an error anyone can read.
   */
  close(): Promise<void>;
};

/**
 * Opens the Db on a PostgreSQL connection URL.
 *
 * Synchronous, and connects lazily: the pool opens its first connection when
 * something is asked of it, so a bad URL surfaces at the first call — in
 * practice `migrate`, which the entry point makes before it starts serving.
 */
export function openDb(url: string): Db {
  const pool = new Pool({ connectionString: url });

  // One schema-less handle for everything that does not belong to a part:
  // migrating, transactions, and raw statements. Every handle shares the pool.
  const bare = drizzle(pool);

  // Every registration still open, so `close` can take them with it.
  const listeners = new Set<Listening>();

  return {
    handle(schema) {
      return drizzle(pool, { schema });
    },

    listen(channel, listener) {
      const listening = startListening(url, channel, listener, () => listeners.delete(listening));
      listeners.add(listening);
      return listening;
    },

    async migrate(...descriptors) {
      assertTrackersDistinct(descriptors);
      for (const descriptor of descriptors) {
        await bare.execute(sql`create schema if not exists ${sql.identifier(descriptor.schema)}`);
        await applyFolder(bare, {
          // Drizzle reads the folder off disk with plain path concatenation, so
          // the URL has to become a path here rather than anywhere later.
          migrationsFolder: fileURLToPath(descriptor.folder),
          migrationsSchema: descriptor.schema,
          migrationsTable: descriptor.table,
        });
      }
    },

    tx(body) {
      return bare.transaction((tx) => body(tx));
    },

    async close() {
      // Copied, because closing removes each from the set as it goes.
      await Promise.all([...listeners].map((listening) => listening.close()));
      await pool.end();
    },
  };
}

/**
 * How a listening connection names itself in `pg_stat_activity`.
 *
 * Not decoration: it is a connection an Operator did not ask for and cannot see in
 * the Db's surface, so it says what it is where they will look for it. The tests
 * find and cut it by the same name.
 */
export const listenApplicationName = "saf listen";

/** How long before the first reconnection attempt, and the ceiling it doubles to. */
const firstRetryMs = 100;
const maxRetryMs = 5_000;

/**
 * Holds one connection open with a `LISTEN` on it, and puts it back whenever it is
 * lost.
 *
 * A dropped connection is normal operation rather than a failure: PostgreSQL
 * restarts, connections are terminated, networks break. So nothing here throws at a
 * caller — a loss is reported and retried, and the caller's own recovery (for the
 * Signal Worker, a sweep of the queue) covers what went missing in the meantime.
 */
function startListening(
  url: string,
  channel: string,
  listener: ChannelListener,
  forget: () => void,
): Listening {
  let closed = false;
  let connected: Client | undefined;
  let attempting: Promise<void> | undefined;
  let retry: NodeJS.Timeout | undefined;
  let retryMs = firstRetryMs;

  function scheduleRetry(): void {
    if (closed || retry !== undefined) return;
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, maxRetryMs);
    retry = setTimeout(() => {
      retry = undefined;
      attempting = attempt();
    }, delay);
  }

  async function attempt(): Promise<void> {
    if (closed) return;
    const client = new Client({
      connectionString: url,
      application_name: `${listenApplicationName} ${channel}`,
    });

    let lost = false;
    const lose = (error: unknown): void => {
      // A terminated connection reports itself twice, as an error and as an end.
      if (lost) return;
      lost = true;
      if (connected === client) connected = undefined;
      if (closed) return;
      void client.end().catch(() => {});
      listener.lost?.(error);
      scheduleRetry();
    };

    // Attached before connecting: an idle client reports a connection it lost as an
    // `error` event, and an `error` event with no handler takes the process down.
    client.on("error", lose);
    client.on("end", () => lose(new Error(`the connection listening on ${channel} ended`)));
    client.on("notification", (message) => {
      if (!closed) listener.notified(message.payload ?? "");
    });

    try {
      await client.connect();
      // Through Drizzle for the identifier quoting rather than the query builder:
      // `LISTEN` is a utility statement, so the channel cannot be a bind parameter
      // and has to be quoted into the statement itself.
      await drizzle(client).execute(sql`listen ${sql.identifier(channel)}`);
    } catch (error) {
      lose(error);
      return;
    }

    if (closed) {
      await client.end().catch(() => {});
      return;
    }
    connected = client;
    retryMs = firstRetryMs;
    listener.connected?.();
  }

  attempting = attempt();

  return {
    async close() {
      if (closed) return;
      closed = true;
      forget();
      if (retry !== undefined) {
        clearTimeout(retry);
        retry = undefined;
      }
      // An attempt already in flight sees `closed` and closes its own client; without
      // waiting for it, `close` could return while a connection is still being made.
      await attempting;
      const client = connected;
      connected = undefined;
      if (client !== undefined) await client.end();
    },
  };
}

/**
 * Two descriptors naming one tracker is the failure ADR-0022 describes, and it
 * reports success, so it is refused where it is expressible rather than left to
 * be discovered as missing tables.
 */
function assertTrackersDistinct(descriptors: readonly MigrationDescriptor[]): void {
  const seen = new Set<string>();
  for (const { schema, table } of descriptors) {
    const tracker = `${schema}.${table}`;
    if (seen.has(tracker)) {
      throw new Error(
        `two migration descriptors would share the tracking table ${tracker}. Drizzle compares folder timestamps against only the newest row of a tracker, so a shared one skips the older folder's migrations and still resolves successfully. Give each part its own schema and tracking table.`,
      );
    }
    seen.add(tracker);
  }
}
