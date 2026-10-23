import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { inArray, is } from "drizzle-orm";
import { getTableConfig, PgTable, pgSchema, text } from "drizzle-orm/pg-core";
import type { Db } from "./db/index.ts";
import * as decisionsSchema from "./decisions/schema/index.ts";
import * as messengerSchema from "./messenger/schema/index.ts";
import * as nostrAuthSchema from "./nostr-auth/schema/index.ts";
import * as nostrChannelSchema from "./nostr-channel/schema/index.ts";
import * as passwordAuthSchema from "./password-auth/schema/index.ts";
import * as schedulerSchema from "./scheduler/schema/index.ts";
import * as signalsSchema from "./signals/schema/index.ts";
import { applySchema, type PartSchema } from "./test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "./test-support/database.ts";
import * as usersSchema from "./users/schema/index.ts";

const parts: Record<string, PartSchema> = {
  decisions: decisionsSchema,
  messenger: messengerSchema,
  "nostr-auth": nostrAuthSchema,
  "nostr-channel": nostrChannelSchema,
  "password-auth": passwordAuthSchema,
  scheduler: schedulerSchema,
  signals: signalsSchema,
  users: usersSchema,
};

type DeclaredTable = {
  readonly part: string;
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly string[];
};

const declared = declaredTables();

let database: TestDatabase;
let db: Db;

before(async () => {
  database = await createTestDatabase("schemas");
  db = database.db;
});

after(() => database.drop());

describe("every component's schema, pushed as one graph", () => {
  it("leaves the database holding exactly the tables and columns the parts declare", async () => {
    await applySchema(db, ...Object.values(parts));

    assert.deepEqual(await columnsInDatabase(db), columnsDeclared());
  });

  it("gives every part a schema of its own, so no part's table can be another's", () => {
    const owners = new Map<string, Set<string>>();
    for (const { schema, part } of declared) {
      owners.set(schema, (owners.get(schema) ?? new Set()).add(part));
    }

    const shared = [...owners].filter(([, parts]) => parts.size > 1);
    assert.deepEqual(new Map(shared), new Map());
  });

  it("covers every part in the source tree that has a schema", () => {
    const source = fileURLToPath(new URL(".", import.meta.url));
    const withSchema = readdirSync(source, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name === "schema")
      .map((entry) => relative(source, entry.parentPath));

    assert.deepEqual(withSchema.sort(), Object.keys(parts).sort());
  });
});

function columnsDeclared(): Record<string, readonly string[]> {
  return Object.fromEntries(
    declared.map(({ schema, name, columns }) => [`${schema}.${name}`, columns]),
  );
}

async function columnsInDatabase(open: Db): Promise<Record<string, readonly string[]>> {
  const rows = await open
    .handle({ catalogue })
    .select({
      schema: catalogue.tableSchema,
      table: catalogue.tableName,
      column: catalogue.columnName,
    })
    .from(catalogue)
    .where(inArray(catalogue.tableSchema, [...new Set(declared.map(({ schema }) => schema))]));

  const held: Record<string, string[]> = {};
  for (const row of rows) {
    const qualified = `${row.schema}.${row.table}`;
    held[qualified] = [...(held[qualified] ?? []), row.column];
  }
  return Object.fromEntries(Object.entries(held).map(([table, names]) => [table, names.sort()]));
}

const catalogue = pgSchema("information_schema").table("columns", {
  tableSchema: text("table_schema").notNull(),
  tableName: text("table_name").notNull(),
  columnName: text("column_name").notNull(),
});

function declaredTables(): readonly DeclaredTable[] {
  const tables: DeclaredTable[] = [];
  for (const [part, namespace] of Object.entries(parts)) {
    for (const table of tablesIn(namespace)) {
      const { schema, name, columns } = getTableConfig(table);
      tables.push({
        part,
        schema: schema ?? "public",
        name,
        columns: columns.map((column) => column.name).sort(),
      });
    }
  }
  return tables;
}

function tablesIn(namespace: PartSchema): ReadonlySet<PgTable> {
  const tables = new Set<PgTable>();
  for (const exported of Object.values(namespace)) {
    if (is(exported, PgTable)) tables.add(exported);
    else if (isPlainObject(exported)) {
      for (const nested of Object.values(exported)) if (is(nested, PgTable)) tables.add(nested);
    }
  }
  return tables;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
