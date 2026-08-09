import { createRequire } from "node:module";
import { defineConfig } from "drizzle-kit";
import { is } from "drizzle-orm";
import { PgSchema } from "drizzle-orm/pg-core";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("set DATABASE_URL to the database this deployment applies its schema to");
}

const requireFrom = createRequire(import.meta.url);

const specifiers = ["scheduler", "signals"].map(
  (component) => `shared-agent-framework/${component}/schema`,
);

const schema = specifiers.map((specifier) => requireFrom.resolve(specifier));

const schemaFilter = specifiers
  .flatMap((specifier) => Object.values(requireFrom(specifier)))
  .filter((exported) => is(exported, PgSchema))
  .map((pgSchema) => pgSchema.schemaName);

export default defineConfig({
  dialect: "postgresql",
  schema,
  schemaFilter,
  dbCredentials: { url: databaseUrl },
});
