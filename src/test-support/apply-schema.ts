/**
 * Creates parts' tables in a test database the way an Operator does: by pushing
 * schema objects, not by applying a folder.
 *
 * This is the test suite's whole setup story for DDL. An Operator assembles the
 * parts they run into a barrel `schema.ts`, points a `drizzle.config.ts` at it and
 * runs `drizzle-kit push` or `generate` + `migrate`
 * ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md)); a test hands
 * the same objects to `applySchema` and gets the same tables. Pushing rather than
 * applying reviewed SQL is the prototype flow, and a database created and dropped
 * inside one test file is exactly a prototype.
 *
 * `drizzle-kit` is a devDependency and `src/test-support/` never ships, so reaching
 * for it here costs the package nothing.
 */

import { pushSchema } from "drizzle-kit/api";
import type { Db } from "../db/index.ts";

/**
 * A part's schema as `drizzle-kit` reads one: the module's exports, flat.
 *
 * `import * as users from "../users/schema.ts"` is the intended argument, and it is
 * the same object shape an Operator's `export *` barrel produces. `drizzle-kit`
 * takes `Object.values` and keeps whatever passes `is(x, PgTable)` or
 * `is(x, PgSchema)`, so a wrapper like `usersTables` riding along in the namespace
 * is ignored rather than harmful — and a table reachable *only* through such a
 * wrapper would be invisible, here exactly as it would be to the Operator.
 */
export type PartSchema = Record<string, unknown>;

/**
 * Pushes every given part's schema into `db`'s database in one operation.
 *
 * One operation and not one per part, because that is the shape an Operator's
 * barrel has: `drizzle-kit` sees a single graph, so a cross-schema foreign key
 * resolves and the statements are ordered for it. Passing the parts separately
 * across several calls would be a different question with a different answer.
 *
 * For a **fresh** database, which every caller has from `createTestDatabase`.
 * Nothing here is a migration: the push introspects `public` alone, so it never
 * sees a `saf_*` schema as already there and only ever emits creates. A second call
 * against the same database therefore fails on `CREATE SCHEMA`, rather than
 * dropping what the first call made — which is the safer of the two ways to be
 * wrong, and the reason no tracking table appears.
 */
export async function applySchema(db: Db, ...parts: readonly PartSchema[]): Promise<void> {
  const { apply } = await pushSchema(exportsOf(parts), db.handle({}));
  await apply();
}

/**
 * The parts' exports as one record.
 *
 * Keys are prefixed by position because two parts may well export the same name and
 * a plain merge would drop one of them in silence. `drizzle-kit` reads values and
 * never keys, so the prefix is invisible to it.
 */
function exportsOf(parts: readonly PartSchema[]): Record<string, unknown> {
  const all: Record<string, unknown> = {};
  for (const [index, part] of parts.entries()) {
    for (const [name, value] of Object.entries(part)) all[`${index}:${name}`] = value;
  }
  return all;
}
