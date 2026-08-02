/**
 * What the HTTP Messenger's shipped migration folder contains, and what applying it
 * out of order does.
 *
 * Both subjects are the folder rather than the part, and both exist because the foreign
 * key onto `saf_users.users.id` is hand-written (ADR-0036). `src/signals/migrations.test.ts`
 * scans **every** shipped folder for a stray `CREATE SCHEMA`, which is a rule all parts
 * share; the scan below is this part's alone, so it lives with this part — and it matters
 * more than the shared one, because a forgotten `CREATE SCHEMA` removal fails loudly on the
 * first migration of a new deployment while a forgotten foreign key is silent: every other
 * test in this directory passes against a database that does not enforce it.
 *
 * The ordering test takes a database of its own, because its subject is what a fresh one
 * ends up containing when only this part is registered.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestDatabase } from "../test-support/database.ts";
import { httpMessagesMigrations } from "./migrations.ts";

describe("the HTTP Messenger's shipped migration folder", () => {
  it("contains the foreign key onto the User Directory's Users", () => {
    const folder = fileURLToPath(httpMessagesMigrations.folder);
    const sqlFiles = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => path.join(folder, entry.name));
    assert.ok(sqlFiles.length > 0, "there should be migration SQL to check");

    const statements = sqlFiles
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
      .split("\n")
      // Comments are stripped, so the paragraph in the file explaining the constraint
      // cannot be what satisfies this test.
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    assert.match(
      statements,
      /foreign key\s*\("user_id"\)\s*references\s*"saf_users"\."users"\s*\("id"\)/i,
      'no shipped statement makes "user_id" a foreign key onto "saf_users"."users"("id"). drizzle-kit cannot generate it — a schema file importing the User Directory\'s would emit its table into this folder — so it is added by hand on every regeneration, and a forgotten addition leaves the constraint silently unenforced (ADR-0036)',
    );
  });
});

describe("migrating the HTTP Messenger before the User Directory", () => {
  it("fails, and names the table that is not there", async () => {
    const database = await createTestDatabase("http_messages_ordering");
    try {
      // The one descriptor, alone, which is what an entry point that constructed this part
      // before the User Directory would have registered. Nothing checks the order; this is
      // what the failure looks like, recorded so that it is not a surprise (ADR-0036).
      database.db.registerMigrations(httpMessagesMigrations);
      const failure = await database.db.migrate().then(
        () => undefined,
        (error: unknown) => error,
      );

      assert.ok(failure instanceof Error, "the migration should have failed");
      // `schema "saf_users" does not exist` on a database nothing has migrated at all, and
      // `relation "saf_users.users" does not exist` on one where the schema is there and
      // the table is not. Either names the missing thing, which is the whole claim: the
      // ordering constraint needs no check of ours because the failure explains itself.
      assert.match(
        `${failure.message} ${String(failure.cause)}`,
        /(schema "saf_users"|relation "saf_users\.users") does not exist/,
        "the failure should name the missing schema or table plainly enough to act on",
      );
    } finally {
      await database.drop();
    }
  });
});
