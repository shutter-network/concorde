import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { type Db, openDb } from "../db/index.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import * as signalsSchema from "./schema/index.ts";
import { runs, signals, signalsTables, usage } from "./schema/index.ts";
import { createUsage } from "./usage.ts";

let database: TestDatabase;
let db: Db;

const monday = new Date("2026-10-26T00:00:00Z");
const tuesday = new Date("2026-10-27T00:00:00Z");
const wednesday = new Date("2026-10-28T00:00:00Z");

before(async () => {
  database = await createTestDatabase("usage");
  db = database.db;
  await applySchema(db, signalsSchema);

  const handle = db.handle(signalsTables);
  const [signal] = await handle
    .insert(signals)
    .values({ kind: "spent", payload: {} })
    .returning({ id: signals.id });
  assert.ok(signal);
  const runId = randomUUID();
  await handle.insert(runs).values({ id: runId, signalId: signal.id, prompt: "spend" });

  const call = (recordedAt: Date, input: number, output: number, cost: number) => ({
    runId,
    userId: null,
    provider: "mock",
    model: "mock-1",
    input,
    output,
    cacheRead: 1000,
    cacheWrite: 10,
    totalTokens: input + output + 1010,
    cost,
    recordedAt,
  });
  await handle
    .insert(usage)
    .values([
      call(new Date("2026-10-26T09:00:00Z"), 100, 20, 0.125),
      call(new Date("2026-10-26T23:59:59Z"), 50, 5, 0.25),
      call(new Date("2026-10-27T00:00:00Z"), 7, 3, 0.5),
    ]);

  const alicesRun = randomUUID();
  const bobsRun = randomUUID();
  await handle.insert(runs).values([
    { id: alicesRun, signalId: signal.id, prompt: "alice", userId: "alice" },
    { id: bobsRun, signalId: signal.id, prompt: "bob", userId: "bob" },
  ]);
  const charged = (id: string, userId: string, recordedAt: Date, totalTokens: number) => ({
    runId: id,
    userId,
    provider: "mock",
    model: "mock-1",
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: 0,
    recordedAt,
  });
  await handle
    .insert(usage)
    .values([
      charged(alicesRun, "alice", new Date("2026-10-26T10:00:00Z"), 40_000),
      charged(alicesRun, "alice", new Date("2026-10-27T10:00:00Z"), 15_000),
      charged(alicesRun, "alice", new Date("2026-10-27T11:00:00Z"), 6_000),
      charged(bobsRun, "bob", new Date("2026-10-27T12:00:00Z"), 900),
    ]);
});

after(() => database.drop());

describe("usage.total", () => {
  it("sums every category, the cost and the calls across all records", async () => {
    assert.deepEqual(await createUsage({ db }).total({ userId: null }), {
      input: 157,
      output: 28,
      cacheRead: 3000,
      cacheWrite: 30,
      totalTokens: 3215,
      cost: 0.875,
      calls: 3,
    });
  });

  it("counts since inclusively and until exclusively, which is a day window", async () => {
    const onMonday = await createUsage({ db }).total({
      userId: null,
      since: monday,
      until: tuesday,
    });
    const onTuesday = await createUsage({ db }).total({
      userId: null,
      since: tuesday,
      until: wednesday,
    });

    assert.deepEqual([onMonday.calls, onMonday.totalTokens], [2, 2195]);
    assert.deepEqual([onTuesday.calls, onTuesday.totalTokens], [1, 1020]);
  });

  it("starts from nothing again once the window moves past the records, which is a reset", async () => {
    assert.deepEqual(await createUsage({ db }).total({ since: wednesday }), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      calls: 0,
    });
  });

  it("reads the same totals from a fresh component on the same Db, which is a restart", async () => {
    const before = await createUsage({ db }).total();
    const again = createUsage({ db });
    await again.start();

    assert.deepEqual(await again.total(), before);
    await again.stop();
  });
});

describe("usage.total for one User", () => {
  const limit = 20_000;

  it("counts that User's records only, so one User spending leaves another untouched", async () => {
    const alice = await createUsage({ db }).total({ userId: "alice", since: tuesday });
    const bob = await createUsage({ db }).total({ userId: "bob", since: tuesday });

    assert.deepEqual([alice.totalTokens, alice.calls], [21_000, 2]);
    assert.deepEqual([bob.totalTokens, bob.calls], [900, 1]);
    assert.ok(alice.totalTokens >= limit && bob.totalTokens < limit);
  });

  it("counts a User with no records as zero", async () => {
    assert.equal((await createUsage({ db }).total({ userId: "carol" })).calls, 0);
  });

  it("counts Runs charged to no User under null and everything when userId is omitted", async () => {
    const reader = createUsage({ db });
    const [nobody, alice, bob, everyone] = await Promise.all([
      reader.total({ userId: null }),
      reader.total({ userId: "alice" }),
      reader.total({ userId: "bob" }),
      reader.total(),
    ]);

    assert.equal(everyone.totalTokens, nobody.totalTokens + alice.totalTokens + bob.totalTokens);
  });

  it("starts the User from zero in a new window, which is the daily reset", async () => {
    const yesterday = await createUsage({ db }).total({
      userId: "alice",
      since: monday,
      until: tuesday,
    });

    assert.equal(yesterday.totalTokens, 40_000);
    assert.equal((await createUsage({ db }).total({ userId: "alice", since: wednesday })).calls, 0);
  });

  it("reads the same per-User totals over a new connection pool, which is a restart", async () => {
    const before = await createUsage({ db }).total({ userId: "alice" });
    const reopened = openDb(database.url);
    try {
      assert.deepEqual(await createUsage({ db: reopened }).total({ userId: "alice" }), before);
    } finally {
      await reopened.stop();
    }
  });
});
