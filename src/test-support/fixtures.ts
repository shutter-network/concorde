/**
 * Two migration descriptors standing in for two parts of the Gateway.
 *
 * Their folder timestamps are **deliberately reversed**: `beta`'s single
 * migration is older than either of `alpha`'s. That is the shape that loses
 * migrations silently when two parts share one tracking table, so it is the
 * shape the tests in `db/migrate.test.ts` use.
 *
 * The folders live here rather than under the repository's `migrations/`
 * directory because that directory ships. These are fixtures; `src/test-support`
 * is excluded from the build.
 */

import { pgSchema, serial, text } from "drizzle-orm/pg-core";
import type { MigrationDescriptor } from "../db/index.ts";

export const alphaMigrations: MigrationDescriptor = {
  folder: new URL("./migrations/alpha", import.meta.url),
  schema: "test_alpha",
  table: "__migrations",
};

export const betaMigrations: MigrationDescriptor = {
  folder: new URL("./migrations/beta", import.meta.url),
  schema: "test_beta",
  table: "__migrations",
};

const alpha = pgSchema(alphaMigrations.schema);
const beta = pgSchema(betaMigrations.schema);

/** Created by `alpha`'s first migration; the `note` column by its second. */
export const widgets = alpha.table("widgets", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  note: text("note"),
});

/** Created by `beta`'s only migration. */
export const gadgets = beta.table("gadgets", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
});
