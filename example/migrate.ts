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
 * Every part of the Gateway with tables of its own exports a migration descriptor, which
 * is inert data: a folder, a PostgreSQL schema, a tracking table. They are registered
 * here **directly**, rather than by constructing the parts that own them, and that is
 * the whole reason they stay exported: a migration job that had to build a Signal Worker
 * would need a Runtime, and in this deployment a model credential and an agent
 * image (ADR-0032). So this file constructs nothing but a Db, and that is the property
 * to keep when you add a part — a migration job that needs the things `gateway.ts` needs
 * is a broken migration job.
 *
 * This deployment has two such parts, the Signal Worker and the User Directory, so there
 * are two descriptors. A deployment with its own tables registers its own beside them,
 * through the same call and with no privilege attached to ours.
 *
 * `gateway.ts` registers the same two — by construction rather than by hand, which is one
 * registration and not two — and then *verifies* them: `db.start()` refuses to serve
 * against a schema this file has not been run for.
 */

import { defaultLogger, openDb, signalsMigrations } from "shared-agent-framework";
import { usersMigrations } from "shared-agent-framework/users";

const log = defaultLogger();
const db = openDb(process.env.DATABASE_URL ?? "postgres://saf:saf@localhost:5433/saf");

const descriptors = [signalsMigrations, usersMigrations];
db.registerMigrations(...descriptors);
await db.migrate();
log.info({ schemas: descriptors.map((descriptor) => descriptor.schema) }, "migrations applied");

// Nothing else opened a connection, so this is the whole of shutdown here.
await db.stop();
