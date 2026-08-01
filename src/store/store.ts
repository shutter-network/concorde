import { fileURLToPath } from "node:url";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyFolder } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { Pool } from "pg";

/**
 * A database handle or a transaction, whichever schema it carries.
 *
 * This is the type a function takes when it accepts either — and it must be
 * spelled with `PgDatabase` from the dialect package rather than `typeof db`,
 * because `drizzle()` returns a handle intersected with a client property that a
 * transaction does not have (drizzle-orm issue #3175). A cross-part signature
 * widens `TSchema` rather than naming one part's schema, since a transaction
 * carries the schema of the handle it was started on (ADR-0023).
 */
export type Db<TSchema extends Record<string, unknown> = Record<string, never>> = PgDatabase<
  PgQueryResultHKT,
  TSchema
>;

/**
 * What `store.tx` hands its callback. A `Db`, plus `rollback()` — which throws
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
 * all to a single `store.migrate` call rather than any part applying its own.
 */
export type MigrationDescriptor = {
  /**
   * The folder holding the generated `.sql` files and `meta/_journal.json`.
   *
   * A `URL` and not a path, so that `new URL("../../migrations/core",
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

export type Store = {
  /**
   * A handle over the shared pool, typed to `schema`. Keeps `pg` internal: the
   * pool is never handed out, so `pg` does not join Fastify and Drizzle as
   * public API.
   */
  handle<TSchema extends Record<string, unknown>>(schema: TSchema): Db<TSchema>;

  /**
   * Applies each descriptor into its own schema with its own tracker, in the
   * order given. An explicit call and never a side effect of opening the Store,
   * so it can run from a separate entry point before a deploy.
   */
  migrate(...descriptors: MigrationDescriptor[]): Promise<void>;

  /** Runs `body` in a transaction: commits on return, rolls back on throw. */
  tx<T>(body: (tx: Transaction) => Promise<T>): Promise<T>;

  /** Closes the pool. Nothing in the framework calls this; shutdown is the Operator's. */
  close(): Promise<void>;
};

/**
 * Opens the Store on a PostgreSQL connection URL.
 *
 * Synchronous, and connects lazily: the pool opens its first connection when
 * something is asked of it, so a bad URL surfaces at the first call — in
 * practice `migrate`, which the entry point makes before it starts serving.
 */
export function openStore(url: string): Store {
  const pool = new Pool({ connectionString: url });

  // One schema-less handle for everything that does not belong to a part:
  // migrating, transactions, and raw statements. Every handle shares the pool.
  const bare = drizzle(pool);

  return {
    handle(schema) {
      return drizzle(pool, { schema });
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
      await pool.end();
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
