/**
 * The schema applier, exercised the way every other test will use it.
 *
 * The subject is a database that ends up with the tables a part declares, so the
 * assertions are writes and reads back through Drizzle rather than inspections of
 * `information_schema`: a table that accepts a row and returns it is the whole of
 * what a test needs from `applySchema`, and it also proves the column defaults came
 * across, which a catalogue count would not.
 *
 * The parts here are the two that stand alone. The HTTP Messenger's schema
 * references the User Manager's, so pushing that one is the whole-set question and
 * belongs to the test that asks it, not to this one.
 *
 * A database per test rather than per file, because `applySchema` is for a fresh
 * database and two pushes into one would be a different question.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as decisions from "../decisions/schema.ts";
import * as users from "../users/schema.ts";
import { applySchema } from "./apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

describe("applySchema", () => {
  it("creates a part's tables, so a row written to one reads back", async () => {
    await onFreshDatabase("apply_schema_one", async ({ db }) => {
      await applySchema(db, users);

      const handle = db.handle(users.usersTables);
      const [written] = await handle
        .insert(users.users)
        .values({ attributes: { greeting: "hello" } })
        .returning();
      assert.ok(written !== undefined);

      const read = await handle.select().from(users.users);
      assert.deepEqual(read, [written]);
      assert.deepEqual(written.attributes, { greeting: "hello" });
    });
  });

  it("applies several parts in one call, each into its own schema", async () => {
    await onFreshDatabase("apply_schema_several", async ({ db }) => {
      await applySchema(db, users, decisions);

      const handle = db.handle({ ...users.usersTables, ...decisions.decisionsTables });
      const [user] = await handle.insert(users.users).values({}).returning();
      const [decision] = await handle
        .insert(decisions.decisions)
        .values({ statement: "the agent decided", jws: "not-a-real-jws", createdAt: new Date() })
        .returning();

      assert.ok(user !== undefined);
      assert.equal(decision?.statement, "the agent decided");
    });
  });
});

/** A throwaway database, dropped whether the body passed or threw. */
async function onFreshDatabase(
  name: string,
  body: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  const database = await createTestDatabase(name);
  try {
    await body(database);
  } finally {
    await database.drop();
  }
}
