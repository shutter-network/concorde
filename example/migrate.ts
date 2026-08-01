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
 * folder, a PostgreSQL schema, a tracking table. They are registered here directly,
 * rather than by constructing the parts that own them, and that is the whole reason
 * they stay exported: a migration job that had to build a Signal Worker would need a
 * Runtime Adapter, and in this deployment a model credential and an agent image
 * (ADR-0032). This deployment has one part, the Signal Worker, so there is one
 * descriptor. A deployment with its own tables registers its own beside it.
 *
 * `gateway.ts` registers the same descriptor and then *verifies* it: `db.start()`
 * refuses to serve against a schema this file has not been run for.
 */

import { defaultLogger, openDb, signalsMigrations } from "shared-agent-framework";

const log = defaultLogger();
const db = openDb(process.env.DATABASE_URL ?? "postgres://saf:saf@localhost:5433/saf");

db.registerMigrations(signalsMigrations);
await db.migrate();
log.info({ schema: signalsMigrations.schema }, "migrations applied");

// Nothing else opened a connection, so this is the whole of shutdown here.
await db.stop();
