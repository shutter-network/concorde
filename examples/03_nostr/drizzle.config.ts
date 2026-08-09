import { defineConfig } from "drizzle-kit";
import { is } from "drizzle-orm";
import { PgSchema } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("set DATABASE_URL to the database this deployment applies its schema to");
}

const schemaFilter = Object.values(schema)
  .filter((exported) => is(exported, PgSchema))
  .map((pgSchema) => pgSchema.schemaName);

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  schemaFilter,
  dbCredentials: { url: databaseUrl },
});
