/**
 * This is the only module in the framework that imports `pg`, and it must stay so. Every other part
 * obtains a handle with `handle(schema)`, and the one thing needing a connection to itself, a
 * `LISTEN` registration, gets it with `listen(channel, listener)` rather than a pool of its own. A
 * second importer would be a second lifetime nothing closes at `stop`, and the confinement is
 * asserted by `src/import-confinement.test.ts` rather than left to review.
 *
 * `startListening` cannot use the pool: a `LISTEN` belongs to a session, and a pooled connection
 * goes back the moment its query resolves. It also cannot throw at a caller. A dropped connection
 * is ordinary operation rather than a failure, so every loss is reported and retried with a
 * doubling backoff, and the recovery a missed notification needs is the caller's.
 *
 * `listen` returns before the connection exists, which is what lets a component register in its
 * constructor. So `close` has to await the attempt in flight; without that it can return while a
 * connection is still being opened, and the process stays alive holding it.
 */

import type { ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { Client, Pool } from "pg";
import type { Component } from "../gateway/components.ts";

export type Handle<TSchema extends Record<string, unknown> = Record<string, never>> = PgDatabase<
  PgQueryResultHKT,
  TSchema
>;

/**
 * What `tx` hands its callback: a {@link Handle}, plus `rollback()`.
 *
 * `rollback()` throws `TransactionRollbackError` rather than returning, so code that uses it as
 * control flow has to catch and then filter for it.
 */
export type Transaction = PgTransaction<
  PgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

/**
 * What `listen` reports.
 *
 * `notified` is the point of it. The other two are about the connection underneath, and a caller
 * has to care: PostgreSQL queues nothing for a listener that is not connected. Whatever was sent
 * while the connection was down is gone, and no gap is visible in what does arrive.
 */
export type ChannelListener = {
  /** A notification arrived. `payload` is `NOTIFY`'s, and is empty when it carried none. */
  notified(payload: string): void;
  /**
   * The registration is in place: once on the first connection, and again after every loss.
   *
   * A reconnection is exactly where a notification goes missing, so a caller that cannot afford to
   * miss one does its own catching-up from here.
   */
  connected?(): void;
  /** The connection was lost, or an attempt to open one failed. Another attempt follows. */
  lost?(error: unknown): void;
};

export type Listening = {
  /**
   * Stops listening and closes the connection. Idempotent, and safe to call while a reconnection is
   * pending.
   */
  close(): Promise<void>;
};

/**
 * The one PostgreSQL client in a Gateway: the pool, a schema-typed handle per component,
 * transactions, and `LISTEN` registrations.
 *
 * **No migrations, and no DDL of any kind.** Nothing here creates a schema, applies a change or
 * tracks what was applied. The Operator lists the `/schema` subpaths of the components they run
 * and pushes them with their own `drizzle-kit` before the Gateway starts.
 */
export type Db = Component & {
  /**
   * Opens the pool, and nothing else.
   *
   * Eager, so a URL nothing answers on fails here, named as the Db, rather than at whichever query
   * came first. Nothing about the schema is looked at: a database behind the code starts cleanly
   * and raises a raw PostgreSQL error at its first query.
   */
  start(): Promise<void>;

  /**
   * Closes the pool and every connection `listen` opened.
   *
   * The listening connections are included because they are the Db's own. One left connected keeps
   * the process alive and its database undroppable.
   */
  stop(): Promise<void>;

  /**
   * A handle over the shared pool, typed to `schema` and to nothing else.
   *
   * The pool is never handed out, so `pg` reaches nothing in a deployment's own code. Call this
   * once per component with that component's tables.
   */
  handle<TSchema extends Record<string, unknown>>(schema: TSchema): Handle<TSchema>;

  /**
   * Registers `listen <channel>` on a connection of the Db's own, outside the pool, and reports
   * what arrives on it. This is the one place the Db holds a connection open on a caller's behalf.
   *
   * It answers before that connection exists and never rejects, so a component registers in its
   * own constructor. A failure to connect reaches `lost` and is retried with a growing backoff
   * until `close`, which means a registration that has never once succeeded looks the same from
   * here as a healthy one.
   */
  listen(channel: string, listener: ChannelListener): Listening;

  /**
   * Runs `body` in a transaction: commits when it returns, rolls back when it throws.
   *
   * Only writes made through the handle `body` is given are in it. A component's own handle takes
   * its own connection, so a write through one inside `body` commits on its own and survives the
   * rollback. That is why a method meant to join a caller's transaction takes the handle as an
   * argument instead of finding one.
   */
  tx<T>(body: (tx: Transaction) => Promise<T>): Promise<T>;
};

/**
 * Opens the Db on a PostgreSQL connection URL, such as `postgres://user:pass@host:5432/db`.
 *
 * Synchronous, and nothing is on the wire yet: the pool opens its first connection when something
 * is asked of it, which is what lets every component be constructed before the database has to be
 * there. `start` is what opens the pool deliberately.
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
 * How a listening connection names itself in `pg_stat_activity`. An Operator never asked for this
 * connection and cannot see it anywhere in the Db's surface, so it says what it is where they will
 * look, and the tests find and terminate it by the same name.
 */
export const listenApplicationName = "concorde listen";

/** How long before the first reconnection attempt, and the ceiling it doubles to. */
const firstRetryMs = 100;
const maxRetryMs = 5_000;

/** Holds one connection open with a `LISTEN` on it, and puts it back whenever it is lost. */
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
