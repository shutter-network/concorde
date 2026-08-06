/**
 * `alpha` and `beta` stand in for two parts of the Gateway, and their folder
 * timestamps are reversed: `beta`'s only migration is older than either of
 * `alpha`'s. One tracking table shared across the two would make Drizzle compare
 * `beta`'s timestamp against the newest row `alpha` left, conclude it is already
 * applied, skip it, and resolve successfully — the silent loss that per-part
 * trackers exist to prevent (ADR-0022).
 *
 * `db.start` is not among the subjects here. It opens the pool and verifies nothing
 * about the schema: applying migrations and confirming they applied is the
 * Operator's, whole, and the framework does not half-own it with a check
 * ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md)).
 *
 * Migrating is destructive and these tests assert on what a fresh database ends
 * up containing, so each takes a database of its own.
 */

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { alphaMigrations, betaMigrations, gadgets, widgets } from "../test-support/fixtures.ts";
import type { Db } from "./index.ts";

async function freshDatabase(t: TestContext, label: string): Promise<TestDatabase> {
  const database = await createTestDatabase(`db_migrate_${label}`);
  t.after(() => database.drop());
  return database;
}

async function freshDb(t: TestContext, label: string): Promise<Db> {
  return (await freshDatabase(t, label)).db;
}

/**
 * Writing `note` is what makes this *fully applied*: the column arrives in
 * `alpha`'s second migration, so a run that stopped after the first would still
 * accept a row without it. The insert also proves nothing but `migrate` had to
 * create the schema.
 */
async function assertAlphaFullyApplied(db: Db): Promise<void> {
  const alpha = db.handle({ widgets });
  await alpha.insert(widgets).values({ label: "alpha", note: "added by 0001" });
  assert.deepEqual(await alpha.select({ label: widgets.label, note: widgets.note }).from(widgets), [
    { label: "alpha", note: "added by 0001" },
  ]);
}

async function assertBetaFullyApplied(db: Db): Promise<void> {
  const beta = db.handle({ gadgets });
  await beta.insert(gadgets).values({ label: "beta" });
  assert.deepEqual(await beta.select({ label: gadgets.label }).from(gadgets), [{ label: "beta" }]);
}

async function assertBothPartsFullyApplied(db: Db): Promise<void> {
  await assertAlphaFullyApplied(db);
  await assertBetaFullyApplied(db);
}

describe("db.migrate", () => {
  it("creates the registered descriptor's schema and applies its migrations", async (t) => {
    const db = await freshDb(t, "applies");
    db.registerMigrations(alphaMigrations);
    await db.migrate();
    await assertAlphaFullyApplied(db);
  });

  it("applies everything registered, newest folder registered first", async (t) => {
    const db = await freshDb(t, "newest_first");
    // Two calls, because two parts register themselves separately.
    db.registerMigrations(alphaMigrations);
    db.registerMigrations(betaMigrations);
    await db.migrate();
    await assertBothPartsFullyApplied(db);
  });

  it("applies everything registered, oldest folder registered first", async (t) => {
    const db = await freshDb(t, "oldest_first");
    db.registerMigrations(betaMigrations, alphaMigrations);
    await db.migrate();
    await assertBothPartsFullyApplied(db);
  });

  it("is idempotent when re-run", async (t) => {
    const db = await freshDb(t, "idempotent");
    db.registerMigrations(alphaMigrations, betaMigrations);
    await db.migrate();
    await db.migrate();
    await db.migrate();

    // A re-applied migration would have thrown on `create table`.
    await assertBothPartsFullyApplied(db);
  });
});

describe("db.registerMigrations", () => {
  it("takes the identical descriptor twice as one registration", async (t) => {
    // The case an Operator meets: a pre-deploy migration step registers the descriptor
    // a part exports, and the part registers the same one at construction.
    const db = await freshDb(t, "registered_twice");
    db.registerMigrations(alphaMigrations);
    db.registerMigrations(alphaMigrations);
    await db.migrate();
    await assertAlphaFullyApplied(db);
  });

  it("refuses two different folders that would share one tracking table", async (t) => {
    const db = await freshDb(t, "shared_tracker");
    db.registerMigrations(alphaMigrations);
    assert.throws(
      () => db.registerMigrations({ ...betaMigrations, schema: alphaMigrations.schema }),
      /tracking table/,
    );
  });
});
