/**
 * A throwaway PostgreSQL database, at least one per test file.
 *
 * PostgreSQL is real in every test (ADR-0022), and a test pushing a part's schema
 * creates whole schemas, so no two test files may share a database: `node --test`
 * runs them in parallel processes and they would push over each other. A file
 * asks for one named after itself and drops it when it is done; a test whose
 * subject is what a *fresh* database ends up containing asks for its own.
 *
 * `DATABASE_URL` names a server and some database on it. That database is only
 * ever connected to in order to create and drop the others.
 */

import { sql } from "drizzle-orm";
import { type Db, type Handle, openDb } from "../db/index.ts";

const defaultUrl = "postgres://postgres:postgres@localhost:5432/postgres";

export const serverUrl = process.env.DATABASE_URL ?? defaultUrl;

export type TestDatabase = {
  /** A Db open on the fresh database. */
  readonly db: Db;
  /** The fresh database's own URL, for opening a second Db on it. */
  readonly url: string;
  /** Stops the Db and drops the database. */
  drop(): Promise<void>;
};

/**
 * Creates a database called `saf_test_<name>`, dropping any leftover of the same
 * name first so an interrupted run does not poison the next one.
 */
export async function createTestDatabase(name: string): Promise<TestDatabase> {
  const database = databaseName(name);
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;

  await onServer(async (server) => {
    await server.execute(sql`drop database if exists ${sql.identifier(database)}`);
    await server.execute(sql`create database ${sql.identifier(database)}`);
  });

  const db = openDb(url.href);

  return {
    db,
    url: url.href,
    async drop() {
      await db.stop();
      await onServer(async (server) => {
        await server.execute(sql`drop database if exists ${sql.identifier(database)}`);
      });
    },
  };
}

/** PostgreSQL truncates identifiers at 63 bytes, which would collide silently. */
function databaseName(name: string): string {
  const prefixed = `saf_test_${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")}`;
  if (prefixed.length > 63) {
    throw new Error(`test database name ${prefixed} exceeds PostgreSQL's 63-byte identifier limit`);
  }
  return prefixed;
}

/** `create database` and `drop database` need a connection to a different database. */
async function onServer(run: (server: Handle) => Promise<void>): Promise<void> {
  const server = openDb(serverUrl);
  try {
    await run(server.handle({}));
  } finally {
    await server.stop();
  }
}
