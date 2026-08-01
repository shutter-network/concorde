/**
 * How `migrations/signals` is generated. Run `npm run migrations:generate` after
 * changing `src/signals/schema.ts`, then commit what it wrote: the SQL ships inside
 * the package and an Operator never runs a schema generation tool (ADR-0022).
 *
 * One config per part, because `out` is one folder and each part owns its own
 * migration folder and tracking table. A second part adds its own config file and
 * passes it with `--config`; they must not share this one, or its migrations land
 * in the Signal Worker's folder and are applied into the Signal Worker's schema.
 *
 * **Two things must be checked by hand after generating**, neither of which
 * `drizzle-kit` can know:
 *
 *  - A generated first migration begins `CREATE SCHEMA "saf_signals";`, which has to
 *    go. `db.migrate` creates the descriptor's schema before applying the
 *    folder, because the tracking table lives in it — so the generated line
 *    always fails on a schema that already exists.
 *    `src/signals/migrations.test.ts` scans every shipped folder and fails on one
 *    left in.
 *  - `drizzle-kit` has no connection here and never inspects a database. It
 *    diffs the schema file against the folder's own snapshots, so the folder is
 *    the only record of what has been applied and a hand-edited migration must be
 *    matched by a hand-edited snapshot.
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/signals/schema.ts",
  out: "./migrations/signals",
});
