import { defineConfig } from "drizzle-kit";
import { is } from "drizzle-orm";
import { PgSchema } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("set DATABASE_URL to the database this deployment applies its schema to");
}

// Derived from the barrel rather than listed. Without it `drizzle-kit` filters both sides of the
// diff down to `public`, finds no difference, creates no table and exits 0.
const schemaFilter = Object.values(schema)
  .filter((exported) => is(exported, PgSchema))
  .map((pgSchema) => pgSchema.schemaName);

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  schemaFilter,
  dbCredentials: { url: databaseUrl },
});
