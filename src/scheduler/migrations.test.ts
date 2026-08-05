/**
 * What a fresh database ends up containing when the Scheduler's descriptor is applied, and that
 * the shipped folder carries no stray `CREATE SCHEMA`.
 *
 * `src/signals/migrations.test.ts` scans **every** shipped folder for a stray `CREATE SCHEMA`,
 * which is a rule all parts share; the scan below is this part's alone, so it lives with this part
 * and fails legibly here rather than in another part's file. This file takes a database of its own,
 * because its subject is what a fresh one ends up containing.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { schedulerMigrations } from "./migrations.ts";
import { schedules } from "./schema.ts";

let database: TestDatabase;
let db: Db;

before(async () => {
  database = await createTestDatabase("scheduler_migrations");
  db = database.db;
  db.registerMigrations(schedulerMigrations);
  await db.migrate();
});

after(() => database.drop());

describe("the Scheduler's migrations", () => {
  it("creates schedules in the Scheduler's own schema", async () => {
    const handle = db.handle({ schedules });
    const at = new Date("2030-01-01T09:00:00.000Z");

    const [row] = await handle
      .insert(schedules)
      .values({ name: "digest", kind: "once", at, data: { topic: "daily" } })
      .returning();
    assert.ok(row, "inserting a Schedule should return the row");
    assert.equal(row.name, "digest");
    assert.equal(row.kind, "once");
    assert.equal(row.at?.toISOString(), at.toISOString());
    assert.deepEqual(row.data, { topic: "daily" });
  });

  it("keeps the name unique, since it is the primary key", async () => {
    const handle = db.handle({ schedules });
    const at = new Date("2030-02-01T09:00:00.000Z");
    await handle.insert(schedules).values({ name: "only-one", kind: "once", at });

    const rejection = await handle
      .insert(schedules)
      .values({ name: "only-one", kind: "once", at })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(rejection instanceof Error, "a duplicate name should be refused");
  });

  it("refuses a kind outside the two the discriminant allows", async () => {
    const rejection = await db
      .handle({})
      .execute(
        // A raw insert, so the query builder is out of the way and the database's own check is
        // what refuses it. `cron` is allowed by the constraint though nothing writes it yet, so
        // the value that must fail is a third one.
        sql`insert into "saf_scheduler"."schedules" ("name", "kind", "at") values ('bad', 'weekly', now())`,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(rejection instanceof Error, "an unknown kind should be refused");
    assert.match(String(rejection.cause), /schedules_kind_known/);
  });

  it("refuses a once with no instant to fire at", async () => {
    const rejection = await db
      .handle({})
      .execute(
        sql`insert into "saf_scheduler"."schedules" ("name", "kind", "at") values ('at-nothing', 'once', null)`,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    assert.ok(rejection instanceof Error, "a once with no instant should be refused");
    assert.match(String(rejection.cause), /schedules_once_has_at/);
  });
});

describe("the Scheduler's shipped migration folder", () => {
  /**
   * `drizzle-kit` writes `CREATE SCHEMA` into a part's first migration and it has to be removed by
   * hand, because `db.migrate` creates the descriptor's schema itself — the tracking table lives in
   * it. Left in, it fails the very first migration of a new deployment. The shared scan in
   * `src/signals/migrations.test.ts` covers this folder too; this one localises the failure here.
   */
  it("has no CREATE SCHEMA left in it", () => {
    const folder = fileURLToPath(schedulerMigrations.folder);
    const sqlFiles = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => path.join(folder, entry.name));
    assert.ok(sqlFiles.length > 0, "there should be migration SQL to check");

    for (const file of sqlFiles) {
      const statements = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      assert.ok(
        !/create\s+schema/i.test(statements),
        `${path.basename(file)} contains CREATE SCHEMA; db.migrate creates the descriptor's schema, so remove the line drizzle-kit generated`,
      );
    }
  });
});
