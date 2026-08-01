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
import type { Store } from "./index.ts";

async function freshStore(t: TestContext, label: string): Promise<Store> {
  const database = await createTestDatabase(`store_migrate_${label}`);
  t.after(() => database.drop());
  return database.store;
}

/**
 * Writing `note` is what makes this *fully applied*: the column arrives in
 * `alpha`'s second migration, so a run that stopped after the first would still
 * accept a row without it. The insert also proves nothing but `migrate` had to
 * create the schema.
 */
async function assertAlphaFullyApplied(store: Store): Promise<void> {
  const alpha = store.handle({ widgets });
  await alpha.insert(widgets).values({ label: "alpha", note: "added by 0001" });
  assert.deepEqual(await alpha.select({ label: widgets.label, note: widgets.note }).from(widgets), [
    { label: "alpha", note: "added by 0001" },
  ]);
}

async function assertBetaFullyApplied(store: Store): Promise<void> {
  const beta = store.handle({ gadgets });
  await beta.insert(gadgets).values({ label: "beta" });
  assert.deepEqual(await beta.select({ label: gadgets.label }).from(gadgets), [{ label: "beta" }]);
}

async function assertBothPartsFullyApplied(store: Store): Promise<void> {
  await assertAlphaFullyApplied(store);
  await assertBetaFullyApplied(store);
}

describe("store.migrate", () => {
  it("creates the descriptor's schema and applies its migrations", async (t) => {
    const store = await freshStore(t, "applies");
    await store.migrate(alphaMigrations);
    await assertAlphaFullyApplied(store);
  });

  it("applies both descriptors fully, newest folder first", async (t) => {
    const store = await freshStore(t, "newest_first");
    await store.migrate(alphaMigrations, betaMigrations);
    await assertBothPartsFullyApplied(store);
  });

  it("applies both descriptors fully, oldest folder first", async (t) => {
    const store = await freshStore(t, "oldest_first");
    await store.migrate(betaMigrations, alphaMigrations);
    await assertBothPartsFullyApplied(store);
  });

  it("is idempotent when re-run with the same descriptors", async (t) => {
    const store = await freshStore(t, "idempotent");
    await store.migrate(alphaMigrations, betaMigrations);
    await store.migrate(alphaMigrations, betaMigrations);
    await store.migrate(alphaMigrations, betaMigrations);

    // A re-applied migration would have thrown on `create table`.
    await assertBothPartsFullyApplied(store);
  });

  it("refuses two descriptors that would share one tracking table", async (t) => {
    const store = await freshStore(t, "shared_tracker");
    await assert.rejects(
      () => store.migrate(alphaMigrations, { ...betaMigrations, schema: alphaMigrations.schema }),
      /tracking table/,
    );
  });
});
