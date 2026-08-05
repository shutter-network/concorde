/**
 * How `migrations/scheduler` is generated. Run
 *
 * ```sh
 * npm run migrations:generate -- --config drizzle.scheduler.config.ts
 * ```
 *
 * after changing `src/scheduler/schema.ts`, then commit what it wrote: the SQL ships inside the
 * package and an Operator never runs a schema generation tool (ADR-0022).
 *
 * A file of its own rather than a second entry in another config, because `out` is one folder:
 * the configs must not be merged, or this part's migrations land in another part's folder and are
 * applied into its schema under its tracking table.
 *
 * **Two things must be checked by hand after generating**, and they are the two every part has —
 * recorded in `drizzle.config.ts` and `drizzle.users.config.ts` as well. There is no third here:
 * unlike `drizzle.http-messages.config.ts` this part has **no cross-schema foreign key** to add
 * back, because a Schedule references nobody (ADR-0018).
 *
 *  - A generated first migration begins `CREATE SCHEMA "saf_scheduler";`, which has to go.
 *    `db.migrate` creates the descriptor's schema before applying the folder, because the tracking
 *    table lives in it, so the generated line always arrives at a schema that already exists.
 *    `src/signals/migrations.test.ts` scans every shipped folder and fails on one left in, and so
 *    does `src/scheduler/migrations.test.ts` for this folder alone.
 *  - `drizzle-kit` has no connection here and never inspects a database. It diffs the schema file
 *    against the folder's own snapshots, so the folder is the only record of what has been applied
 *    and a hand-edited migration must be matched by a hand-edited snapshot.
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/scheduler/schema.ts",
  out: "./migrations/scheduler",
});
