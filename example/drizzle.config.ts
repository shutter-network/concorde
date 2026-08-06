/**
 * This deployment's own `drizzle-kit`, pointed at its own barrel and its own database
 * ([ADR-0046](../docs/adr/0046-the-operator-owns-migrations.md)). The framework ships
 * schema definitions and applies nothing, so the config that applies them is here, in
 * the deployment, beside the `compose.yml` that runs it.
 *
 * `migrate/Dockerfile` runs `drizzle-kit push` against this: no committed SQL, the
 * database made to match `schema.ts` in one shot. That is the prototype flow and it is
 * honest here, because this stack's database is a volume that gets thrown away. **A
 * production deployment changes one word** — `push` becomes `generate` at build time and
 * `migrate` at deploy time, against an `out` folder it reviews and commits — and nothing
 * else about this file or the compose wiring changes.
 *
 * `DATABASE_URL` is the same variable `compose.yml` hands the Gateway, pointing at the
 * same database. Nothing here reads it out of the framework: the framework reads no
 * environment ([ADR-0045](../docs/adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)),
 * and neither does `drizzle-kit` unless a config tells it to, which is what this line is.
 */

import { defineConfig } from "drizzle-kit";
import { is } from "drizzle-orm";
import { PgSchema } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("set DATABASE_URL to the database this deployment's schema is applied to");
}

/**
 * The PostgreSQL schemas `push` is allowed to see, taken from the barrel rather than
 * listed again.
 *
 * **Without this line the push does nothing and says nothing.** `drizzle-kit` defaults
 * to `["public"]` and applies the filter to *both* sides of the diff, so every `saf_*`
 * table is dropped from what the barrel declares as well as from what the database
 * holds: the two empties match, it prints `No changes detected`, it creates not one
 * table, and it exits 0. The Gateway then starts on the strength of that success and
 * dies on its first query. Verified, because this repo's whole schema lives behind a
 * prefix and that default is written for the deployment whose schema does not.
 *
 * Derived and not hand-listed, so it cannot fall behind the barrel: a hand-written copy
 * would be a third place this deployment states which parts it runs, and the barrel is
 * already the second one nothing checks (ADR-0046, cost 2).
 */
const schemaFilter = Object.values(schema)
  .filter((exported) => is(exported, PgSchema))
  .map((pgSchema) => pgSchema.schemaName);

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  schemaFilter,
  dbCredentials: { url: databaseUrl },
});
