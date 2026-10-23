import { defineConfig } from "drizzle-kit";
import { is } from "drizzle-orm";
import { PgSchema } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("Set DATABASE_URL to the PostgreSQL connection URL.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  schemaFilter: Object.values(schema)
    .filter((exported) => is(exported, PgSchema))
    .map((pgSchema) => pgSchema.schemaName),
  dbCredentials: { url: databaseUrl },
});
