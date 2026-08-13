/**
 * Every component's schema, pushed together into one database.
 *
 * This is the assembled question, and it is asked here rather than left to whichever
 * test happens to construct the most parts. An Operator lists the `/schema` subpaths
 * of the parts they run in one `drizzle.config.ts` and gets a single generation graph
 * ([ADR-0046](../docs/adr/0046-the-operator-owns-migrations.md),
 * [ADR-0055](../docs/adr/0055-a-components-tables-are-a-subpath-of-their-own.md)), so
 * the only place a *set* of parts can be wrong is that list, and the longest list
 * anyone can write is this one.
 *
 * Two ways a set can be wrong, and they fail differently enough to need a test each.
 *
 * **A cross-schema foreign key names a part outside the set** is the loud one.
 * `messages.user_id`, `pubkeys.user_id`, `outbox.user_id`, Password Auth's two columns and Nostr
 * Auth's `grants.user_id` all reference
 * `concorde_users.users.id` in code (ADR-0036, ADR-0046, ADR-0049, ADR-0052, ADR-0053), so
 * the set is coherent only while Users is in it, and a set without it throws
 * on the `ADD CONSTRAINT` — `schema "concorde_users" does not exist`. Pushing is enough to
 * catch that, and the first test pushes. What that test cannot do by itself is keep
 * "the set" equal to "every part", which is the last test's job.
 *
 * **Two parts declaring one table** is the silent one, and it stays silent past the
 * push: `drizzle-kit` keys tables by qualified name and keeps the last one it sees, so
 * the push succeeds, one table is created, and the losing part's columns are simply
 * absent until its first query. Worse, comparing the database against the parts'
 * declarations cannot see it either — that comparison keys by qualified name too, so
 * both sides collapse the same way and agree. So the second test asks it of the schema
 * objects instead, and asks the stronger form: every part has a `concorde_<part>` schema of
 * its own (ADR-0022), which two parts cannot collide on a table without first breaking.
 *
 * The first test therefore compares **what the database ends up holding against what
 * the parts declare** for a different silent failure, the wrapper trap. `drizzle-kit`
 * reads `Object.values` and keeps what passes `is(x, PgTable)` without ever looking
 * inside a plain object, so a table reachable only through a part's `*Tables` wrapper
 * is dropped in silence and generated as nothing — the failure ADR-0046 names as the
 * reason this file exists. The expectation is built from the wrappers *and* the flat
 * exports, so a table the part queries but never flat-exports is a table this test
 * asks the database for and does not find.
 *
 * The last test is about this file rather than about the schemas: a part added later
 * whose schema nobody lists here is a part nothing above covers, and it would be
 * uncovered in silence, so the list is held against the source tree.
 *
 * **Every part is reached by file path here, and that is why this file survived the tables
 * moving onto the component subpaths and off them again**
 * ([ADR-0047](../docs/adr/0047-a-component-is-one-subpath.md),
 * [ADR-0055](../docs/adr/0055-a-components-tables-are-a-subpath-of-their-own.md)).
 * `src/<part>/schema/` is where a table is declared; the file inside it has been named twice
 * and the specifier an Operator imports it through has moved once. The last test scans for
 * those directories, so it keeps covering every part without knowing anything about the
 * export map.
 */

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

/**
 * Every part that has a schema, keyed by the directory it lives in — which is what lets
 * the last test hold this list against the source tree.
 */
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

/** One declared table: where it lives, what it holds, and whose it is. */
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
    // One call, because one call is what an Operator's own run is. A cross-schema
    // foreign key resolves only inside a single push, so splitting this per part
    // would be asking an easier question than the one an Operator asks.
    await applySchema(db, ...Object.values(parts));

    assert.deepEqual(await columnsInDatabase(db), columnsDeclared());
  });

  it("gives every part a schema of its own, so no part's table can be another's", () => {
    // Asked of the schemas and not of the tables, because it is the stronger question
    // and the shorter one: ADR-0022's `concorde_<part>` per part held as a fact rather than
    // a naming habit. Two parts cannot collide on a table without first sharing the
    // schema it is in, and a part declaring one table into another part's schema — the
    // collision in its less obvious spelling — is caught here and nowhere else.
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

/**
 * What the parts say the database should hold, as `concorde_x.y` -> its column names.
 *
 * Keyed by qualified name, so two parts claiming one table collapse into a single entry
 * here exactly as they do in the push — which is the whole reason the collision is a
 * question asked of the declarations rather than of this comparison.
 */
function columnsDeclared(): Record<string, readonly string[]> {
  return Object.fromEntries(
    declared.map(({ schema, name, columns }) => [`${schema}.${name}`, columns]),
  );
}

/**
 * What the database holds, in the same shape.
 *
 * Narrowed to the schemas the parts name, so `public` and whatever an Operator's own
 * database already has stay out of it — but *not* narrowed to the tables, because a
 * table created inside a part's schema that no part declares is also a wrong answer.
 */
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
  // Sorted here and not by the query, so the two sides are ordered by one rule.
  // PostgreSQL's collation ignores an underscore where JavaScript's `sort` does not,
  // and a comparison that agrees only until some part adds a column named `run_a`
  // beside `run_id` would fail on the collation rather than on the schema.
  return Object.fromEntries(Object.entries(held).map(([table, names]) => [table, names.sort()]));
}

/**
 * PostgreSQL's own catalogue of columns, described just enough to select three of them.
 *
 * The database is asked what it holds rather than the push asked what it did, because
 * what the push believes it created is the thing under test.
 */
const catalogue = pgSchema("information_schema").table("columns", {
  tableSchema: text("table_schema").notNull(),
  tableName: text("table_name").notNull(),
  columnName: text("column_name").notNull(),
});

/** Every part's tables, flat exports and `*Tables` wrappers alike. */
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

/**
 * The tables a part has, reached the way the part itself reaches them.
 *
 * One level into a plain object, which `drizzle-kit` pointedly does not do: the `*Tables`
 * wrapper is what the part hands `db.handle`, so a table in there is a table the part
 * queries, whether or not the push ever saw it. Deduplicated by identity, since every
 * table is normally both a flat export and a member of the wrapper.
 */
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
