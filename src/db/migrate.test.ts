/**
 * `alpha` and `beta` stand in for two parts of the Gateway, and their folder
 * timestamps are reversed: `beta`'s only migration is older than either of
 * `alpha`'s. One tracking table shared across the two would make Drizzle compare
 * `beta`'s timestamp against the newest row `alpha` left, conclude it is already
 * applied, skip it, and resolve successfully — the silent loss that per-part
 * trackers exist to prevent (ADR-0022).
 *
 * That same reversal is what the `db.start` tests below pair a folder with the
 * *other* part's schema and tracking table for. A tracker holding `beta`'s
 * 1600000000000 under a folder whose journal maxes at 1800000060000 is a database
 * one migration behind the code, and the pairing inverted is a database ahead of
 * it. No rows are written by hand anywhere here.
 *
 * Migrating is destructive and these tests assert on what a fresh database ends
 * up containing, so each takes a database of its own.
 */

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { alphaMigrations, betaMigrations, gadgets, widgets } from "../test-support/fixtures.ts";
import type { Db } from "./index.ts";
import { openDb } from "./index.ts";

async function freshDatabase(t: TestContext, label: string): Promise<TestDatabase> {
  const database = await createTestDatabase(`db_migrate_${label}`);
  t.after(() => database.drop());
  return database;
}

async function freshDb(t: TestContext, label: string): Promise<Db> {
  return (await freshDatabase(t, label)).db;
}

/**
 * A second Db on the same database, which is what drift is: the entry point that
 * migrates and the one that starts are two processes with two registrations, and
 * `start` verifies only its own. One Db could not hold both registrations below
 * anyway, since they name one tracking table on purpose.
 *
 * Stopped here rather than in an `after` hook, because the database is dropped in
 * one and a pool still holding a connection would make that fail.
 */
async function withSecondDb(
  database: TestDatabase,
  body: (db: Db) => Promise<void>,
): Promise<void> {
  const db = openDb(database.url);
  try {
    await body(db);
  } finally {
    await db.stop();
  }
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

describe("db.start", () => {
  it("refuses a registered schema that was never migrated, naming it", async (t) => {
    const db = await freshDb(t, "start_unmigrated");
    db.registerMigrations(alphaMigrations);
    await assert.rejects(() => db.start(), /nothing has been applied to schema test_alpha/);
  });

  it("refuses a registered schema whose newest applied migration is older", async (t) => {
    const database = await freshDatabase(t, "start_behind");
    database.db.registerMigrations(betaMigrations);
    await database.db.migrate();

    // `beta`'s schema and tracker, holding 1600000000000, under `alpha`'s folder,
    // whose journal maxes at 1800000060000: code that moved on from what was
    // applied.
    await withSecondDb(database, async (db) => {
      db.registerMigrations({ ...alphaMigrations, ...trackerOf(betaMigrations) });
      await assert.rejects(() => db.start(), /the database is behind schema test_beta/);
    });
  });

  it("starts against a database that is ahead of the folder", async (t) => {
    const database = await freshDatabase(t, "start_ahead");
    database.db.registerMigrations(alphaMigrations);
    await database.db.migrate();

    // The pairing above inverted, which is what a rolled-back release looks like:
    // the tracker holds 1800000060000 and this folder's journal maxes at
    // 1600000000000.
    await withSecondDb(database, async (db) => {
      db.registerMigrations({ ...betaMigrations, ...trackerOf(alphaMigrations) });
      await db.start();
    });
  });

  it("starts when every registered schema is up to date", async (t) => {
    const db = await freshDb(t, "start_current");
    db.registerMigrations(alphaMigrations, betaMigrations);
    await db.migrate();
    await db.start();
    // Started, so the pool is open and the schemas are the ones start verified.
    await assertBothPartsFullyApplied(db);
  });
});

/** Where a descriptor's applied migrations are recorded, without its folder. */
function trackerOf({ schema, table }: { schema: string; table: string }): {
  schema: string;
  table: string;
} {
  return { schema, table };
}
