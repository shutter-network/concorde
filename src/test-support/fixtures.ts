/**
 * One schema and one table standing in for a part of the Gateway, for the tests whose
 * subject is the Db itself rather than any part's data.
 *
 * `alpha` is exported alongside `widgets` for the same reason every part's `schema.ts`
 * exports its `pgSchema`: a push reads top-level values and creates a schema only if it
 * is handed one, so `applySchema(db, { widgets })` gets `schema "test_alpha" does not
 * exist`.
 *
 * `src/test-support` is excluded from the build, so none of this ships.
 */

import { pgSchema, serial, text } from "drizzle-orm/pg-core";

export const alpha = pgSchema("test_alpha");

export const widgets = alpha.table("widgets", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  note: text("note"),
});
