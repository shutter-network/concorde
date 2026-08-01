/**
 * Migrations, as an entry point of their own.
 *
 *     node example/migrate.ts
 *
 * `gateway.ts` makes the same call at boot, and this file exists because that must not
 * be the only way to make it. Applying migrations is an explicit call and never a side
 * effect of opening the Db, so a deploy can run this against the new schema *before*
 * anything starts serving the new code — which is the only ordering that works when the
 * two are separate steps.
 *
 * Every part of the Gateway exports a migration descriptor, which is inert data: a
 * folder, a PostgreSQL schema, a tracking table. This deployment has one part, the
 * Signal Worker, so there is one descriptor. A deployment with its own tables adds its
 * own to the same call — and to nothing else, because `db.migrate` is the only place
 * the per-part tracking tables can be checked for collisions.
 */

import { defaultLogger, openDb, signalsMigrations } from "shared-agent-framework";

const log = defaultLogger();
const db = openDb(process.env.DATABASE_URL ?? "postgres://saf:saf@localhost:5433/saf");

await db.migrate(signalsMigrations);
log.info({ schema: signalsMigrations.schema }, "migrations applied");

// Nothing else opened a connection, so this is the whole of shutdown here.
await db.close();
