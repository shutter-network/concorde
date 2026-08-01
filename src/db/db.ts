import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyFolder } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { Client, Pool } from "pg";
import type { Component } from "../components.ts";

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
 * part of the Gateway exports one and registers it with the Db it was given, and
 * `db.migrate()` applies whatever registered rather than any part applying its
 * own. It stays exported because the migration entry point registers it directly
 * — a pre-deploy migration job must not have to construct a Signal Worker, and
 * through it a Runtime Adapter and a model credential (ADR-0032).
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
 *
 * A Component, and normally the first entry in the list: everything queries it,
 * the drain queries it on the way down, so it starts first and stops last
 * (ADR-0031).
 */
export type Db = Component & {
  /**
   * Opens the pool, and then refuses to start if any registered schema is behind
   * the migration folder shipped beside it.
   *
   * The pool is opened eagerly so that a URL nothing answers on is a startup
   * failure naming the Db rather than a surprise at the first query. The verify
   * is the other half of that: for each registered descriptor it compares the
   * largest `when` in the folder's `meta/_journal.json` against the newest row of
   * the descriptor's tracking table, and refuses if the table is absent or the
   * database is older, naming the schema. A database that is *ahead* starts, since
   * that is what a rollback looks like.
   *
   * **Migrations are never applied here.** `drizzle-orm`'s PostgreSQL migrator
   * takes no advisory lock — it reads the newest tracker row, then opens a
   * transaction and applies everything newer — so two replicas booting together
   * would both apply the same DDL and one of them would die of it. `migrate` is a
   * call an Operator makes once (ADR-0032).
   */
  start(): Promise<void>;

  /**
   * Closes the pool and every connection `listen` opened.
   *
   * Listening connections are included because they are the Db's, and one left
   * connected keeps the process alive and its database undroppable — a leak whose
   * symptom is a deploy that never exits rather than an error anyone can read.
   */
  stop(): Promise<void>;

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
   * Takes these descriptors as ones `migrate` should apply and `start` should
   * verify. Nothing is applied here; this is bookkeeping a constructor can do.
   *
   * The identical descriptor twice is one registration, because two registrations
   * of it are the normal case: a part registers the descriptor it exports at
   * construction, and the migration entry point registers the same one directly.
   * Two **different** folders naming one tracking table still throws — that is
   * the failure where Drizzle compares folder timestamps against only the newest
   * tracker row, silently skips the older folder's migrations, and resolves
   * successfully (ADR-0022).
   */
  registerMigrations(...descriptors: MigrationDescriptor[]): void;

  /**
   * Applies every registered descriptor into its own schema with its own tracker,
   * in the order it was registered. An explicit call and never a side effect of
   * opening the Db or of starting it, so it can run from a separate entry point
   * before a deploy — which is the ordering that works when the two are separate
   * steps.
   */
  migrate(): Promise<void>;

  /** Runs `body` in a transaction: commits on return, rolls back on throw. */
  tx<T>(body: (tx: Transaction) => Promise<T>): Promise<T>;
};

/**
 * Opens the Db on a PostgreSQL connection URL.
 *
 * Synchronous, and connects lazily: the pool opens its first connection when
 * something is asked of it. That is what lets a part be constructed, and its
 * migrations registered, before anything is on the wire — and it is why `start`
 * opens the pool itself rather than leaving a bad URL to whichever query came
 * first.
 */
export function openDb(url: string): Db {
  const pool = new Pool({ connectionString: url });

  // One schema-less handle for everything that does not belong to a part:
  // migrating, transactions, and raw statements. Every handle shares the pool.
  const bare = drizzle(pool);

  // Every registration still open, so `stop` can take them with it.
  const listeners = new Set<Listening>();

  // What has registered, in registration order, which is the order `migrate`
  // applies in and `start` verifies in.
  const registered: MigrationDescriptor[] = [];

  return {
    // Read only where a Component is named in an error, and there is one Db.
    name: "db",

    handle(schema) {
      return drizzle(pool, { schema });
    },

    listen(channel, listener) {
      const listening = startListening(url, channel, listener, () => listeners.delete(listening));
      listeners.add(listening);
      return listening;
    },

    registerMigrations(...descriptors) {
      for (const descriptor of descriptors) register(registered, descriptor);
    },

    async migrate() {
      for (const descriptor of registered) {
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

    async start() {
      // Taken and given straight back, which is the whole of "open the pool":
      // there is nothing to hold, and a URL nothing answers on fails here.
      const client = await pool.connect();
      client.release();

      for (const descriptor of registered) await assertUpToDate(bare, descriptor);
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
 * Adds one descriptor to what `migrate` applies and `start` verifies, or refuses
 * it.
 *
 * Two descriptors naming one tracker is the failure ADR-0022 describes, and it
 * reports success, so it is refused where it is expressible rather than left to
 * be discovered as missing tables. The identical descriptor is not that failure:
 * it is a part registering what it exports and the migration entry point
 * registering the same thing, so it is one registration and no complaint.
 */
function register(registered: MigrationDescriptor[], descriptor: MigrationDescriptor): void {
  const tracker = `${descriptor.schema}.${descriptor.table}`;
  const already = registered.find((other) => `${other.schema}.${other.table}` === tracker);
  if (already === undefined) {
    registered.push(descriptor);
    return;
  }
  if (already.folder.href === descriptor.folder.href) return;
  throw new Error(
    `two migration descriptors would share the tracking table ${tracker}. Drizzle compares folder timestamps against only the newest row of a tracker, so a shared one skips the older folder's migrations and still resolves successfully. Give each part its own schema and tracking table.`,
  );
}

/** One line of a migration folder's `meta/_journal.json`. */
type JournalEntry = {
  /** When `drizzle-kit` generated it, in milliseconds. */
  readonly when: number;
  /** The `.sql` file's name without its extension, which is what to name in an error. */
  readonly tag: string;
};

/**
 * What a registered schema must have applied before the Gateway may serve
 * requests against it.
 *
 * The comparison is between the folder's journal and the tracking table because
 * those two hold the same number: Drizzle writes each entry's `when` into
 * `created_at` as it applies it. Nothing here reads the `.sql` files, and nothing
 * here writes anything — a database that is *ahead* is a rollback and starts.
 */
async function assertUpToDate(
  bare: NodePgDatabase,
  descriptor: MigrationDescriptor,
): Promise<void> {
  const newest = await newestInFolder(descriptor.folder);
  // A folder shipping nothing asks nothing of the database.
  if (newest === undefined) return;

  const tracker = `${descriptor.schema}.${descriptor.table}`;
  const applied = await newestApplied(bare, descriptor);
  if (applied === undefined) {
    throw new Error(
      `nothing has been applied to schema ${descriptor.schema}: its migration tracking table ${tracker} is absent or empty, and its folder ships ${newest.tag} from ${asTime(newest.when)}. Run migrations before starting; starting never applies them.`,
    );
  }
  if (applied < newest.when) {
    throw new Error(
      `the database is behind schema ${descriptor.schema}: the newest migration applied there is from ${asTime(applied)}, and its folder ships ${newest.tag} from ${asTime(newest.when)}. Run migrations before starting; starting never applies them.`,
    );
  }
}

/** The newest migration a folder ships, or nothing if it ships none. */
async function newestInFolder(folder: URL): Promise<JournalEntry | undefined> {
  // The same file Drizzle reads, and by the same plain path concatenation: the
  // folder URL has no trailing slash, so resolving a relative URL against it
  // would climb out of the folder.
  const file = path.join(fileURLToPath(folder), "meta", "_journal.json");
  const journal = JSON.parse(await readFile(file, "utf8")) as {
    readonly entries?: readonly JournalEntry[];
  };

  let newest: JournalEntry | undefined;
  for (const entry of journal.entries ?? []) {
    if (newest === undefined || entry.when > newest.when) newest = entry;
  }
  return newest;
}

/**
 * When the newest migration recorded in a descriptor's tracking table was
 * generated, or nothing when the table holds no row — including because there is
 * no such table, which is what a schema nobody ever migrated looks like.
 */
async function newestApplied(
  bare: NodePgDatabase,
  descriptor: MigrationDescriptor,
): Promise<number | undefined> {
  // Asked for first, because selecting from a table that is not there is an error
  // and not an answer. `quote_ident` rather than interpolation, so a schema whose
  // name needs quoting is looked up as itself.
  const found = await bare.execute<{ relation: string | null }>(
    sql`select to_regclass(quote_ident(${descriptor.schema}) || '.' || quote_ident(${descriptor.table})) as relation`,
  );
  if (found.rows[0]?.relation == null) return undefined;

  const applied = await bare.execute<{ newest: string | null }>(
    sql`select max(created_at) as newest from ${sql.identifier(descriptor.schema)}.${sql.identifier(descriptor.table)}`,
  );
  // `created_at` is a bigint, which arrives as a string.
  const newest = applied.rows[0]?.newest;
  return newest == null ? undefined : Number(newest);
}

/** Milliseconds are what is compared; a date is what an Operator can act on. */
function asTime(when: number): string {
  return new Date(when).toISOString();
}
