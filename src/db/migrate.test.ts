/**
 * `alpha` and `beta` stand in for two parts of the Gateway, and their folder
 * timestamps are reversed: `beta`'s only migration is older than either of
 * `alpha`'s. One tracking table shared across the two would make Drizzle compare
 * `beta`'s timestamp against the newest row `alpha` left, conclude it is already
 * applied, skip it, and resolve successfully — the silent loss that per-part
 * trackers exist to prevent (ADR-0022).
 *
 * Migrating is destructive and these tests assert on what a fresh database ends
 * up containing, so each takes a database of its own.
 */

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createTestDatabase } from "../test-support/database.ts";
import { alphaMigrations, betaMigrations, gadgets, widgets } from "../test-support/fixtures.ts";
import type { Db } from "./index.ts";

async function freshDb(t: TestContext, label: string): Promise<Db> {
  const database = await createTestDatabase(`db_migrate_${label}`);
  t.after(() => database.drop());
  return database.db;
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
  it("creates the descriptor's schema and applies its migrations", async (t) => {
    const db = await freshDb(t, "applies");
    await db.migrate(alphaMigrations);
    await assertAlphaFullyApplied(db);
  });

  it("applies both descriptors fully, newest folder first", async (t) => {
    const db = await freshDb(t, "newest_first");
    await db.migrate(alphaMigrations, betaMigrations);
    await assertBothPartsFullyApplied(db);
  });

  it("applies both descriptors fully, oldest folder first", async (t) => {
    const db = await freshDb(t, "oldest_first");
    await db.migrate(betaMigrations, alphaMigrations);
    await assertBothPartsFullyApplied(db);
  });

  it("is idempotent when re-run with the same descriptors", async (t) => {
    const db = await freshDb(t, "idempotent");
    await db.migrate(alphaMigrations, betaMigrations);
    await db.migrate(alphaMigrations, betaMigrations);
    await db.migrate(alphaMigrations, betaMigrations);

    // A re-applied migration would have thrown on `create table`.
    await assertBothPartsFullyApplied(db);
  });

  it("refuses two descriptors that would share one tracking table", async (t) => {
    const db = await freshDb(t, "shared_tracker");
    await assert.rejects(
      () => db.migrate(alphaMigrations, { ...betaMigrations, schema: alphaMigrations.schema }),
      /tracking table/,
    );
  });
});
