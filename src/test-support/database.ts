import { sql } from "drizzle-orm";
import { type Db, type Handle, openDb } from "../db/index.ts";

const defaultUrl = "postgres://postgres:postgres@localhost:5432/postgres";

export const serverUrl = process.env.DATABASE_URL ?? defaultUrl;

export type TestDatabase = {
  readonly db: Db;
  readonly url: string;
  drop(): Promise<void>;
};

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

function databaseName(name: string): string {
  const prefixed = `concorde_test_${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")}`;
  if (prefixed.length > 63) {
    throw new Error(`test database name ${prefixed} exceeds PostgreSQL's 63-byte identifier limit`);
  }
  return prefixed;
}

async function onServer(run: (server: Handle) => Promise<void>): Promise<void> {
  const server = openDb(serverUrl);
  try {
    await run(server.handle({}));
  } finally {
    await server.stop();
  }
}
