import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { alphaMigrations, widgets } from "../test-support/fixtures.ts";
import type { Db, Store } from "./index.ts";

let database: TestDatabase;
let store: Store;

before(async () => {
  database = await createTestDatabase("store");
  store = database.store;
  await store.migrate(alphaMigrations);
});

after(() => database.drop());

/**
 * Shaped like a write one part of the Gateway performs on behalf of another: it
 * takes the transaction rather than finding one, and widens the schema parameter
 * instead of naming a part's schema, so a handle and a transaction from anywhere
 * both satisfy it (ADR-0023). The call sites below are what prove it compiles
 * against both; `npm run typecheck` is the assertion.
 */
async function record<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  label: string,
): Promise<void> {
  await db.insert(widgets).values({ label });
}

async function labels(): Promise<string[]> {
  const rows = await store.handle({ widgets }).select({ label: widgets.label }).from(widgets);
  return rows.map((row) => row.label).sort();
}

describe("store.handle", () => {
  it("returns a handle scoped to the schema it was given", async () => {
    const alpha = store.handle({ widgets });
    await alpha.insert(widgets).values({ label: "handle-typed" });

    // The relational form is only available on a handle carrying the schema, so
    // reading back through it is what distinguishes this from a bare handle.
    const found = await alpha.query.widgets.findMany({
      where: (w, { eq }) => eq(w.label, "handle-typed"),
    });
    assert.deepEqual(
      found.map((row) => row.label),
      ["handle-typed"],
    );
  });
});

describe("store.tx", () => {
  it("commits when the callback returns, and returns its value", async () => {
    const returned = await store.tx(async (tx) => {
      await record(tx, "committed");
      return "value";
    });

    assert.equal(returned, "value");
    assert.ok((await labels()).includes("committed"));
  });

  it("rolls back when the callback throws, and rethrows", async () => {
    await assert.rejects(
      () =>
        store.tx(async (tx) => {
          await record(tx, "rolled-back");
          throw new Error("deliberate");
        }),
      /deliberate/,
    );

    assert.ok(!(await labels()).includes("rolled-back"));
  });

  it("makes a function taking a handle or a transaction join the caller's transaction", async () => {
    // The same function, called with a plain handle, writes immediately.
    await record(store.handle({ widgets }), "via-handle");
    assert.ok((await labels()).includes("via-handle"));

    // Called with the transaction, its write is undone with everything else.
    await assert.rejects(
      () =>
        store.tx(async (tx) => {
          await record(tx, "via-transaction");
          // Visible inside the transaction before it is abandoned.
          const inside = await tx.select({ label: widgets.label }).from(widgets);
          assert.ok(inside.some((row) => row.label === "via-transaction"));
          throw new Error("abandon");
        }),
      /abandon/,
    );

    assert.ok(!(await labels()).includes("via-transaction"));
  });
});
