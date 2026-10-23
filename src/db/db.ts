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

export type Transaction = PgTransaction<
  PgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

export type ChannelListener = {
  notified(payload: string): void;
  connected?(): void;
  lost?(error: unknown): void;
};

export type Listening = {
  close(): Promise<void>;
};

export type Db = Component & {
  start(): Promise<void>;

  stop(): Promise<void>;

  handle<TSchema extends Record<string, unknown>>(schema: TSchema): Handle<TSchema>;

  /**
   * Opens a dedicated connection immediately and reconnects after disconnection.
   * Notifications during a connection gap are lost; use `connected` to reconcile durable state.
   * `Db.stop()` closes all listeners, including those not explicitly closed by the caller.
   */
  listen(channel: string, listener: ChannelListener): Listening;

  /** Commits when the callback resolves and rolls back when it throws. The callback is not retried. */
  tx<T>(body: (tx: Transaction) => Promise<T>): Promise<T>;
};

/** Creates a connection pool without applying schema changes. `start()` checks connectivity. */
export function openDb(url: string): Db {
  const pool = new Pool({ connectionString: url });

  const bare = drizzle(pool);

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
      const client = await pool.connect();
      client.release();
    },

    async stop() {
      await Promise.all([...listeners].map((listening) => listening.close()));
      await pool.end();
    },
  };
}

export const listenApplicationName = "concorde listen";

const firstRetryMs = 100;
const maxRetryMs = 5_000;

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
      if (lost) return;
      lost = true;
      if (connected === client) connected = undefined;
      if (closed) return;
      void client.end().catch(() => {});
      listener.lost?.(error);
      scheduleRetry();
    };

    client.on("error", lose);
    client.on("end", () => lose(new Error(`the connection listening on ${channel} ended`)));
    client.on("notification", (message) => {
      if (!closed) listener.notified(message.payload ?? "");
    });

    try {
      await client.connect();
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
      await attempting;
      const client = connected;
      connected = undefined;
      if (client !== undefined) await client.end();
    },
  };
}
