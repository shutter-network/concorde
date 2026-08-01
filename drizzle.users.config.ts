/**
 * How `migrations/users` is generated. Run
 *
 * ```sh
 * npm run migrations:generate -- --config drizzle.users.config.ts
 * ```
 *
 * after changing `src/users/schema.ts`, then commit what it wrote: the SQL ships
 * inside the package and an Operator never runs a schema generation tool (ADR-0022).
 *
 * A file of its own rather than a second entry in `drizzle.config.ts`, because `out`
 * is one folder: the two configs must not be merged, or the User Directory's
 * migrations land in the Signal Worker's folder and are applied into its schema under
 * its tracking table.
 *
 * **Two things must be checked by hand after generating**, neither of which
 * `drizzle-kit` can know — they are the same two `drizzle.config.ts` records, and
 * they apply to every part:
 *
 *  - A generated first migration begins `CREATE SCHEMA "saf_users";`, which has to
 *    go. `db.migrate` creates the descriptor's schema before applying the folder,
 *    because the tracking table lives in it, so the generated line always arrives at
 *    a schema that already exists. `src/signals/migrations.test.ts` scans every
 *    shipped folder and fails on one left in.
 *  - `drizzle-kit` has no connection here and never inspects a database. It diffs the
 *    schema file against the folder's own snapshots, so the folder is the only record
 *    of what has been applied and a hand-edited migration must be matched by a
 *    hand-edited snapshot.
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/users/schema.ts",
  out: "./migrations/users",
});
