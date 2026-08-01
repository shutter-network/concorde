/**
 * What a fresh database ends up containing when the Signal Worker's descriptor is
 * applied, so this file takes a database of its own.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { signalsMigrations } from "./migrations.ts";
import { runs, signals } from "./schema.ts";

let database: TestDatabase;
let db: Db;

before(async () => {
  database = await createTestDatabase("signals_migrations");
  db = database.db;
  await db.migrate(signalsMigrations);
});

after(() => database.drop());

describe("the Signal Worker's migrations", () => {
  it("creates signals and runs in the Signal Worker's own schema", async () => {
    const handle = db.handle({ signals, runs });

    const [signal] = await handle
      .insert(signals)
      .values({ kind: "message.received", payload: { userId: "u1", body: "hello" } })
      .returning();
    assert.ok(signal, "inserting a Signal should return the row");
    // The defaults are part of the schema: a Producer writes a kind and a payload
    // and the Signal arrives pending, with nothing wrong with it, at a time the
    // database chose.
    assert.equal(signal.state, "pending");
    assert.equal(signal.error, null);
    assert.deepEqual(signal.payload, { userId: "u1", body: "hello" });
    assert.ok(signal.emittedAt instanceof Date);

    const [run] = await handle
      .insert(runs)
      .values({ signalId: signal.id, session: "user_1", prompt: "say hello" })
      .returning();
    assert.ok(run, "inserting a Run should return the row");
    assert.equal(run.signalId, signal.id);
    assert.equal(run.session, "user_1");
    assert.equal(run.state, "pending");
    assert.equal(run.startedAt, null);
    assert.equal(run.endedAt, null);

    // A fresh Session is a Prompt naming no Session, so the column is nullable.
    const [fresh] = await handle
      .insert(runs)
      .values({ signalId: signal.id, session: null, prompt: "start something new" })
      .returning({ session: runs.session });
    assert.equal(fresh?.session, null);
  });

  it("refuses a state outside the four the data model allows", async () => {
    // There is no `timed_out`, because there are no timeouts (ADR-0017). The
    // constraint is what keeps that a fact about the database rather than a claim
    // in a document.
    const rejection = await db
      .handle({})
      .execute(
        sql`insert into "saf_signals"."signals" ("kind", "payload", "state") values ('x', '{}', 'timed_out')`,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    assert.ok(rejection instanceof Error, "an unknown state should be refused");
    // Drizzle reports the statement and puts the driver's error underneath it, so
    // which constraint refused it is on the cause and not in the message.
    assert.match(String(rejection.cause), /signals_state_known/);
  });
});

describe("every shipped migration folder", () => {
  /**
   * `drizzle-kit` writes `CREATE SCHEMA` into a part's first migration and it has
   * to be removed by hand, because `db.migrate` creates the descriptor's schema
   * itself — the tracking table lives in it. Left in, it fails the very first
   * migration of a new deployment and nothing earlier catches it. A comment in the
   * generator's config would not survive the next part; this does.
   */
  it("has no CREATE SCHEMA left in it", () => {
    const root = fileURLToPath(new URL("../../migrations", import.meta.url));
    const sqlFiles = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => path.join(entry.parentPath, entry.name));

    assert.ok(sqlFiles.length > 0, "there should be migration SQL to check");
    for (const file of sqlFiles) {
      const statements = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      assert.ok(
        !/create\s+schema/i.test(statements),
        `${path.relative(root, file)} contains CREATE SCHEMA; db.migrate creates the descriptor's schema, so remove the line drizzle-kit generated`,
      );
    }
  });
});
