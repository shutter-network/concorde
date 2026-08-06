/**
 * How `migrations/http-messages` is generated. Run
 *
 * ```sh
 * npm run migrations:generate -- --config drizzle.http-messages.config.ts
 * ```
 *
 * after changing `src/http-messenger/schema.ts`, then commit what it wrote: the SQL ships
 * inside the package and an Operator never runs a schema generation tool (ADR-0022).
 *
 * A file of its own rather than a second entry in another config, because `out` is one
 * folder: the configs must not be merged, or this part's migrations land in another part's
 * folder and are applied into its schema under its tracking table.
 *
 * **Three things must be checked by hand after generating.** The first two are the ones
 * every part has, recorded in `drizzle.config.ts` and `drizzle.users.config.ts`; the third
 * is this part's alone and is the dangerous one:
 *
 *  - A generated first migration begins `CREATE SCHEMA "saf_http_messages";`, which has to
 *    go. `db.migrate` creates the descriptor's schema before applying the folder, because
 *    the tracking table lives in it, so the generated line always arrives at a schema that
 *    already exists. `src/signals/migrations.test.ts` scans every shipped folder and fails
 *    on one left in.
 *  - `drizzle-kit` has no connection here and never inspects a database. It diffs the schema
 *    file against the folder's own snapshots, so the folder is the only record of what has
 *    been applied and a hand-edited migration must be matched by a hand-edited snapshot.
 *  - **The foreign key on `user_id` must be put back**, in the SQL *and* in the snapshot.
 *    `messages.user_id` references `saf_users.users.id` (ADR-0036) and `src/http-messenger/
 *    schema.ts` cannot say so: a schema file importing `../users/schema.ts` makes the
 *    generator emit `CREATE TABLE saf_users.users` into this folder. So the constraint is
 *    added by hand, and unlike the `CREATE SCHEMA` removal a **forgotten addition is
 *    silent** — every test passes against a database that simply does not enforce it. It is
 *    pinned by a scan in `src/http-messenger/migrations.test.ts`.
 *
 *    The snapshot is what the database looks like after the folder is applied, so the
 *    constraint belongs in it. The cost of that is the shape of every regeneration: the
 *    snapshot has a constraint the schema file does not, so `drizzle-kit` proposes
 *    `ALTER TABLE … DROP CONSTRAINT "messages_user_id_users_id_fk"`. Delete that statement
 *    from the generated migration and copy the constraint's entry into the new snapshot's
 *    `foreignKeys` — the `tokens_user_id_users_id_fk` entry in `migrations/users` is the
 *    same shape, plus a `schemaTo` naming the other part's schema.
 *
 * **Do not run this config.** The third item above is now false, and running it would
 * write `CREATE TABLE saf_users.users` into this folder: `src/http-messenger/schema.ts`
 * declares the foreign key in code and openly imports `../users/schema.ts`, which
 * [ADR-0046](./docs/adr/0046-the-operator-owns-migrations.md) permits because a deployment
 * generates one barrelled schema graph into one folder rather than a folder per part.
 * `migrations/http-messages` already carries the identical constraint by hand, so it is
 * correct as shipped and needs no regeneration; this file and the folder both go when the
 * framework stops shipping migrations.
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/http-messenger/schema.ts",
  out: "./migrations/http-messages",
});
