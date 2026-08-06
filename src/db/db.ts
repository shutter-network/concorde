import type { ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { Client, Pool } from "pg";
import type { Component } from "../components.ts";

/**
 * A Drizzle handle over the pool, or inside a transaction, typed to the schema it carries.
 *
 * One type for both. A cross-component signature widens `TSchema` rather than naming one
 * component's schema. A transaction carries the schema of the handle it started on.
 */
export type Handle<TSchema extends Record<string, unknown> = Record<string, never>> = PgDatabase<
  PgQueryResultHKT,
  TSchema
>;

/**
 * What `db.tx` hands its callback: a `Handle`, plus `rollback()`.
 *
 * `rollback()` throws `TransactionRollbackError` rather than returning, so code using it as
 * control flow has to catch and filter.
 */
export type Transaction = PgTransaction<
  PgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

/**
 * What `db.listen` reports.
 *
 * `notified` is the point of it. The other two are about the connection underneath, and a caller
 * has to care: PostgreSQL queues nothing for a listener that is not connected. Whatever was sent
 * while the connection was down is gone, and no gap is visible in what does arrive.
 */
export type ChannelListener = {
  /** A notification arrived. `payload` is `NOTIFY`'s, empty when it carried none. */
  notified(payload: string): void;
  /**
   * The registration is in place, on the first connection and again after every loss.
   *
   * A reconnection is exactly where a notification goes missing. So a caller that cannot afford
   * to miss one acts here too.
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
 * The Gateway's PostgreSQL client: the pool, a schema-typed handle per component, transactions
 * and `LISTEN` registrations.
 *
 * **No migrations.** The Operator generates and applies their own DDL. Nothing here creates a
 * schema or tracks what was applied.
 *
 * A Component, and normally the first entry in the Gateway's record. Everything queries it, and
 * the drain queries it on the way down, so it starts first and stops last.
 */
export type Db = Component & {
  /**
   * Opens the pool, and nothing else.
   *
   * Eager, so a URL nothing answers on is a startup failure naming the Db. It is not a surprise
   * at the first query. Nothing about the schema is checked. A database behind the code surfaces
   * as a raw PostgreSQL error at its first query.
   */
  start(): Promise<void>;

  /**
   * Closes the pool and every connection `listen` opened.
   *
   * Listening connections are included because they are the Db's. One left connected keeps the
   * process alive and its database undroppable.
   */
  stop(): Promise<void>;

  /**
   * A handle over the shared pool, typed to `schema`.
   *
   * The pool itself is never handed out, which keeps `pg` out of the public API.
   */
  handle<TSchema extends Record<string, unknown>>(schema: TSchema): Handle<TSchema>;

  /**
   * Registers `listen <channel>` on a connection of the Db's own, outside the pool, and reports
   * what arrives on it.
   *
   * It cannot be a pooled connection. A `LISTEN` registration belongs to a session. A pooled
   * connection goes back to the pool as soon as its query resolves. This is therefore the one
   * place the Db keeps a connection open on a caller's behalf.
   *
   * @returns Immediately, without waiting for the connection, and it never rejects. Failures go
   *   to `listener.lost` and are retried with a backoff until `close`.
   */
  listen(channel: string, listener: ChannelListener): Listening;

  /** Runs `body` in a transaction: commits on return, rolls back on throw. */
  tx<T>(body: (tx: Transaction) => Promise<T>): Promise<T>;
};

/**
 * Opens the Db on a PostgreSQL connection URL.
 *
 * Synchronous, and it connects lazily: the pool opens its first connection when something is
 * asked of it. That is what lets every component be constructed before anything is on the wire.
 * `start` then opens the pool itself, rather than leaving a bad URL to whichever query came
 * first.
 *
 * @param url A PostgreSQL connection URL, such as `postgres://user:pass@host:5432/db`.
 *
 * @example
 * ```ts
 * import { openDb } from "shared-agent-framework";
 * import { users } from "shared-agent-framework/users";
 *
 * const db = openDb(process.env.DATABASE_URL ?? "");
 * await db.start();
 *
 * const handle = db.handle({ users });
 * const rows = await handle.select().from(users).limit(10);
 *
 * await db.stop();
 * ```
 */
export function openDb(url: string): Db {
  const pool = new Pool({ connectionString: url });

  // One schema-less handle for everything that does not belong to a component:
  // transactions and raw statements. Every handle shares the pool.
  const bare = drizzle(pool);

  // Every registration still open, so `stop` can take them with it.
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

    tx(body) {
      return bare.transaction((tx) => body(tx));
    },

    async start() {
      // Taken and given straight back, which is the whole of "open the pool". There is nothing
      // to hold, and a URL nothing answers on fails here.
      const client = await pool.connect();
      client.release();
    },

    async stop() {
      // Copied, because closing removes each from the set as it goes.
      await Promise.all([...listeners].map((listening) => listening.close()));
      await pool.end();
    },
  };
}

/**
 * How a listening connection names itself in `pg_stat_activity`.
 *
 * An Operator did not ask for this connection and cannot see it in the Db's surface. So it names
 * itself where they will look. The tests find and cut it by the same name.
 */
export const listenApplicationName = "saf listen";

/** How long before the first reconnection attempt, and the ceiling it doubles to. */
const firstRetryMs = 100;
const maxRetryMs = 5_000;

/**
 * Holds one connection open with a `LISTEN` on it, and puts it back whenever it is lost.
 *
 * A dropped connection is normal operation rather than a failure: PostgreSQL restarts,
 * connections are terminated, networks break. So nothing here throws at a caller. A loss is
 * reported and retried, and the caller's own recovery covers what went missing.
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

    // Attached before connecting. An idle client reports a lost connection as an `error` event.
    // An `error` event with no handler takes the process down.
    client.on("error", lose);
    client.on("end", () => lose(new Error(`the connection listening on ${channel} ended`)));
    client.on("notification", (message) => {
      if (!closed) listener.notified(message.payload ?? "");
    });

    try {
      await client.connect();
      // Through Drizzle for the identifier quoting rather than the query builder. `LISTEN` is a
      // utility statement, so the channel cannot be a bind parameter. It has to be quoted into
      // the statement itself.
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
      // An attempt already in flight sees `closed` and closes its own client. Without waiting
      // for it, `close` can return while a connection is still being made.
      await attempting;
      const client = connected;
      connected = undefined;
      if (client !== undefined) await client.end();
    },
  };
}
