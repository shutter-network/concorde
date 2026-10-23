import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { asc, eq, sql } from "drizzle-orm";
import Fastify from "fastify";
import type { Db, Listening } from "../db/index.ts";
import type { LogFields, Logger } from "../logging/logging.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { cutListeningBackends } from "../test-support/backends.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";
import type { SignalHandler, SignalHandlers } from "./handlers.ts";
import type { Runtime } from "./runtime.ts";
import * as signalsSchema from "./schema/index.ts";
import { runs, signals } from "./schema/index.ts";
import { createSignalWorker, type SignalWorker, signalChannel } from "./worker.ts";

let database: TestDatabase;
let db: Db;

before(async () => {
  database = await createTestDatabase("worker");
  db = database.db;
  await applySchema(db, signalsSchema);
});

after(() => database.drop());

type LogEntry = {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly fields: LogFields;
  readonly message: string;
};

function recordingLogger(entries: LogEntry[]): Logger {
  const at =
    (level: LogEntry["level"]) =>
    (fields: LogFields, message: string): void => {
      entries.push({ level, fields, message });
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

const sweepingMs = 5;
const sleepingSweepMs = 60_000;

const listeningMessage = "listening for Signal notifications";

type WorkerBody = (worker: SignalWorker, entries: readonly LogEntry[]) => Promise<void>;

async function withWorker(
  handlers: SignalHandlers,
  runtime: Runtime,
  body: WorkerBody,
  sweepIntervalMs: number = sweepingMs,
): Promise<void> {
  const entries: LogEntry[] = [];
  const worker = createSignalWorker({
    db,
    runtime,
    handlers,
    logger: recordingLogger(entries),
    sweepIntervalMs,
  });
  await worker.start();
  try {
    await body(worker, entries);
  } finally {
    await worker.stop();
  }
}

function withNotifiedWorker(
  handlers: SignalHandlers,
  runtime: Runtime,
  body: WorkerBody,
): Promise<void> {
  return withWorker(
    handlers,
    runtime,
    async (worker, entries) => {
      await waitUntil("the Signal Worker is listening for Signal notifications", async () =>
        entries.some((entry) => entry.message === listeningMessage),
      );
      await body(worker, entries);
    },
    sleepingSweepMs,
  );
}

function wakeups(entries: readonly LogEntry[], reason: string): number {
  return entries.filter(
    (entry) => entry.message === "worker woken" && entry.fields.reason === reason,
  ).length;
}

function notifyNothing(): Promise<unknown> {
  return db.handle({}).execute(sql`select pg_notify(${signalChannel}, '')`);
}

function emit(worker: SignalWorker, kind: string, payload: unknown = {}): Promise<string> {
  return db.tx((tx) => worker.emit(tx, { kind, payload }));
}

async function signalRow(id: string): Promise<typeof signals.$inferSelect | undefined> {
  const [row] = await db.handle({ signals }).select().from(signals).where(eq(signals.id, id));
  return row;
}

async function settled(id: string): Promise<typeof signals.$inferSelect> {
  await waitUntil(`Signal ${id} reaches a terminal state`, async () => {
    const state = (await signalRow(id))?.state;
    return state === "done" || state === "failed";
  });
  const row = await signalRow(id);
  assert.ok(row);
  return row;
}

function runsOf(signalId: string): Promise<(typeof runs.$inferSelect)[]> {
  return db
    .handle({ runs })
    .select()
    .from(runs)
    .where(eq(runs.signalId, signalId))
    .orderBy(asc(runs.startedAt));
}

describe("worker.emit", () => {
  it("records a Signal as pending", async () => {
    const worker = createSignalWorker({
      db,
      runtime: fakeRuntime(),
      handlers: {},
      logger: recordingLogger([]),
    });
    const id = await emit(worker, "recorded.pending", { hello: "world" });

    const row = await signalRow(id);
    assert.equal(row?.state, "pending");
    assert.equal(row?.kind, "recorded.pending");
    assert.deepEqual(row?.payload, { hello: "world" });
    assert.equal(row?.error, null);

    await db.handle({ signals }).delete(signals).where(eq(signals.id, id));
  });

  it("never lets a Signal from a rolled-back transaction be processed", async () => {
    const seen: string[] = [];
    const handler: SignalHandler = {
      handle(signal) {
        seen.push(signal.kind);
        return [];
      },
    };
    const runtime = fakeRuntime();

    await withNotifiedWorker(
      { "rolled-back": handler, marker: handler },
      runtime,
      async (worker, entries) => {
        let rolledBackId: string | undefined;
        await assert.rejects(
          () =>
            db.tx(async (tx) => {
              rolledBackId = await worker.emit(tx, { kind: "rolled-back", payload: {} });
              throw new Error("the Producer changed its mind");
            }),
          /changed its mind/,
        );
        assert.ok(rolledBackId, "emit should have returned an id before the rollback");

        const markerId = await emit(worker, "marker");
        assert.equal((await settled(markerId)).state, "done");

        assert.deepEqual(seen, ["marker"]);
        assert.equal(await signalRow(rolledBackId), undefined);

        assert.equal(wakeups(entries, "notification"), 1);
      },
    );
  });
});

describe("worker.start", () => {
  it("refuses a second call, because one Signal Worker drains one queue", async () => {
    const worker = createSignalWorker({
      db,
      runtime: fakeRuntime(),
      handlers: { started: { handle: () => [] } },
      logger: recordingLogger([]),
      sweepIntervalMs: sweepingMs,
    });
    await worker.start();
    try {
      await assert.rejects(() => worker.start(), /already been called/);
    } finally {
      await worker.stop();
    }
  });
});

export function constructingWithoutHandlersDoesNotCompile(runtime: Runtime): SignalWorker {
  // @ts-expect-error the kind-to-Handler map is a required option
  return createSignalWorker({ db, runtime });
}

describe("the worker", () => {
  it("dispatches on kind to exactly one Handler", async () => {
    const seenByA: string[] = [];
    const seenByB: string[] = [];

    await withWorker(
      {
        "a.kind": {
          handle: (signal) => {
            seenByA.push(signal.id);
            return [];
          },
        },
        "b.kind": {
          handle: (signal) => {
            seenByB.push(signal.id);
            return [];
          },
        },
      },
      fakeRuntime(),
      async (worker) => {
        const id = await emit(worker, "b.kind");
        await settled(id);

        assert.deepEqual(seenByA, []);
        assert.deepEqual(seenByB, [id]);
      },
    );
  });

  it("leaves a Signal that produced no Prompts done, with no Runs", async () => {
    const runtime = fakeRuntime();
    await withWorker({ decline: { handle: () => [] } }, runtime, async (worker) => {
      const id = await emit(worker, "decline");
      const row = await settled(id);

      assert.equal(row.state, "done");
      assert.equal(row.error, null);
      assert.deepEqual(await runsOf(id), []);
      assert.deepEqual(runtime.recorded, []);
    });
  });

  it("produces one Run per Prompt, each carrying its own Session name", async () => {
    const runtime = fakeRuntime();
    await withWorker(
      {
        fan: {
          handle: () => [
            { session: "user_1", text: "one" },
            { session: "user_2", text: "two" },
            { session: null, text: "three, in a fresh Session" },
          ],
        },
      },
      runtime,
      async (worker) => {
        const id = await emit(worker, "fan");
        assert.equal((await settled(id)).state, "done");

        const rows = await runsOf(id);
        const fresh = rows[2];
        assert.ok(fresh !== undefined, "the third Run should exist");
        assert.deepEqual(
          rows.map((row) => [row.session, row.prompt, row.state, row.error]),
          [
            ["user_1", "one", "done", null],
            ["user_2", "two", "done", null],
            [`run_${fresh.id}`, "three, in a fresh Session", "done", null],
          ],
        );
        assert.ok(
          rows.every((row) => row.startedAt instanceof Date && row.endedAt instanceof Date),
          "every Run should be timed",
        );
        assert.deepEqual(runtime.texts(), ["one", "two", "three, in a fresh Session"]);
        assert.equal(runtime.overlapped, false);
      },
    );
  });

  it("processes Signals in arrival order, one Run at a time", async () => {
    const runtime = fakeRuntime();
    const ordered: SignalHandler<{ n: number }> = {
      handle: (signal) => [
        { session: `user_${signal.payload.n}`, text: `${signal.payload.n}a` },
        { session: null, text: `${signal.payload.n}b` },
      ],
    };

    await withWorker({ ordered }, runtime, async (worker) => {
      const ids: string[] = [];
      for (const n of [1, 2, 3] as const) {
        ids.push(await emit(worker, "ordered", { n }));
      }
      for (const id of ids) await settled(id);

      assert.deepEqual(runtime.texts(), ["1a", "1b", "2a", "2b", "3a", "3b"]);
      assert.equal(runtime.overlapped, false, "two Runs were in flight at once");
    });
  });

  it("runs the post phase after every Run, told that none failed", async () => {
    const timeline: string[] = [];
    const runtime = fakeRuntime((prompt) => {
      timeline.push(`run ${prompt.text}`);
      return { ok: true };
    });
    let told: boolean | undefined;

    await withWorker(
      {
        posted: {
          handle: () => [
            { session: null, text: "a" },
            { session: null, text: "b" },
          ],
          post: (_signal, outcome) => {
            timeline.push("post");
            told = outcome.failed;
          },
        },
      },
      runtime,
      async (worker) => {
        const id = await emit(worker, "posted");
        assert.equal((await settled(id)).state, "done");

        assert.deepEqual(timeline, ["run a", "run b", "post"]);
        assert.equal(told, false);
      },
    );
  });

  it("tells the post phase a Run failed, and fails the Signal with the reason", async () => {
    const runtime = fakeRuntime((prompt) =>
      prompt.text === "b" ? { ok: false, error: "the model refused" } : { ok: true },
    );
    let told: boolean | undefined;

    await withWorker(
      {
        posted: {
          handle: () => [
            { session: null, text: "a" },
            { session: null, text: "b" },
          ],
          post: (_signal, outcome) => {
            told = outcome.failed;
          },
        },
      },
      runtime,
      async (worker) => {
        const id = await emit(worker, "posted");
        const row = await settled(id);

        assert.equal(told, true);
        assert.equal(row.state, "failed");
        assert.match(row.error ?? "", /the model refused/);

        assert.deepEqual(
          (await runsOf(id)).map((run) => [run.prompt, run.state, run.error]),
          [
            ["a", "done", null],
            ["b", "failed", "the model refused"],
          ],
        );
      },
    );
  });

  it("fails the Signal when the post phase throws, and says which half went wrong", async () => {
    const runtime = fakeRuntime();
    await withWorker(
      {
        "posted.badly": {
          handle: () => [{ session: null, text: "ran fine" }],
          post: () => {
            throw new Error("the cleanup could not cope");
          },
        },
      },
      runtime,
      async (worker) => {
        const id = await emit(worker, "posted.badly");
        const row = await settled(id);

        assert.equal(row.state, "failed");
        assert.match(row.error ?? "", /post phase failed: the cleanup could not cope/);
        assert.deepEqual(
          (await runsOf(id)).map((run) => run.state),
          ["done"],
        );
      },
    );
  });

  it("fails only the Signal whose Handler threw, and still runs its post phase", async () => {
    const runtime = fakeRuntime();
    let told: boolean | undefined;

    await withWorker(
      {
        boom: {
          handle: () => {
            throw new Error("the Handler could not cope");
          },
          post: (_signal, outcome) => {
            told = outcome.failed;
          },
        },
        fine: { handle: () => [{ session: "user_1", text: "still working" }] },
      },
      runtime,
      async (worker) => {
        const boomId = await emit(worker, "boom");
        const fineId = await emit(worker, "fine");

        const boom = await settled(boomId);
        assert.equal(boom.state, "failed");
        assert.match(boom.error ?? "", /could not cope/);
        assert.deepEqual(await runsOf(boomId), []);
        assert.equal(told, true);

        assert.equal((await settled(fineId)).state, "done");
        assert.deepEqual(runtime.texts(), ["still working"]);
      },
    );
  });

  it("fails a Signal whose kind has no Handler, naming the kind", async () => {
    const runtime = fakeRuntime();
    await withWorker({ known: { handle: () => [] } }, runtime, async (worker) => {
      const id = await emit(worker, "typo.in.kind");
      const row = await settled(id);

      assert.equal(row.state, "failed");
      assert.match(row.error ?? "", /typo\.in\.kind/);
      assert.deepEqual(await runsOf(id), []);
      assert.deepEqual(runtime.recorded, []);
    });
  });

  it("hands the Runtime any Session name, and fails only the Run it rejects", async () => {
    const runtime = fakeRuntime((prompt) =>
      prompt.session === "user:2"
        ? { ok: false, error: "Session id must be alphanumeric" }
        : { ok: true },
    );
    await withWorker(
      {
        names: {
          handle: () => [
            { session: "user_1", text: "runs" },
            { session: "user:2", text: "does not" },
            { session: "../escape", text: "runs, as far as the framework is concerned" },
          ],
        },
      },
      runtime,
      async (worker) => {
        const id = await emit(worker, "names");
        const row = await settled(id);

        assert.equal(row.state, "failed");
        assert.deepEqual(
          runtime.recorded.map((prompt) => prompt.session),
          ["user_1", "user:2", "../escape"],
        );
        assert.deepEqual(
          (await runsOf(id)).map((run) => [run.session, run.state, run.error]),
          [
            ["user_1", "done", null],
            ["user:2", "failed", "Session id must be alphanumeric"],
            ["../escape", "done", null],
          ],
        );
      },
    );
  });

  it("has each Run recorded and running by the time the Runtime is called, and the Agent server carrying it", async () => {
    const fastify = Fastify();
    fastify.get("/whose", async (request) => request.concordeRun ?? null);

    type Observed = {
      found: number;
      prompt: string | undefined;
      state: string | undefined;
      context: unknown;
      carried: unknown;
    };
    const observed: Observed[] = [];
    const runtime = fakeRuntime(async (prompt) => {
      const found = await db
        .handle({ runs })
        .select()
        .from(runs)
        .where(eq(runs.session, prompt.session));
      const carried = await fastify.inject({ method: "GET", url: "/whose" });
      observed.push({
        found: found.length,
        prompt: found[0]?.prompt,
        state: found[0]?.state,
        context: found[0]?.context,
        carried: carried.json(),
      });
      return { ok: true };
    });

    const worker = createSignalWorker({
      db,
      runtime,
      handlers: {
        paired: {
          handle: () => [
            { session: "paired_1", text: "first", context: { for: "one" } },
            { session: "paired_2", text: "second" },
          ],
        },
      },
      agentServer: { fastify },
      logger: recordingLogger([]),
      sweepIntervalMs: sweepingMs,
    });
    await worker.start();
    try {
      const id = await emit(worker, "paired");
      await settled(id);
      assert.equal((await fastify.inject("/whose")).json(), null);

      const [first, second] = await runsOf(id);
      assert.ok(first !== undefined && second !== undefined, "both Runs should exist");
      assert.deepEqual(observed, [
        {
          found: 1,
          prompt: "first",
          state: "running",
          context: { for: "one" },
          carried: { id: first.id, signalId: id, session: "paired_1", context: { for: "one" } },
        },
        {
          found: 1,
          prompt: "second",
          state: "running",
          context: null,
          carried: { id: second.id, signalId: id, session: "paired_2", context: null },
        },
      ]);
      assert.deepEqual(runtime.recorded, [
        { session: "paired_1", text: "first" },
        { session: "paired_2", text: "second" },
      ]);
    } finally {
      await worker.stop();
      await fastify.close();
    }
  });

  it("names a fresh Session after the Run it belongs to, and hands the Runtime that name", async () => {
    const runtime = fakeRuntime();
    await withWorker(
      {
        unnamed: {
          handle: () => [
            { session: null, text: "a fresh Session" },
            { session: null, text: "another, and not the same one" },
            { session: "chosen", text: "a name the Handler wrote" },
          ],
        },
      },
      runtime,
      async (worker) => {
        const id = await emit(worker, "unnamed");
        assert.equal((await settled(id)).state, "done");

        const rows = await runsOf(id);
        assert.deepEqual(
          rows.map((row) => row.session),
          [`run_${rows[0]?.id}`, `run_${rows[1]?.id}`, "chosen"],
        );
        assert.deepEqual(
          runtime.recorded.map((prompt) => prompt.session),
          rows.map((row) => row.session),
        );
        assert.deepEqual(runtime.texts(), [
          "a fresh Session",
          "another, and not the same one",
          "a name the Handler wrote",
        ]);
      },
    );
  });

  it("treats a Runtime that throws as a failed Run rather than a dead worker", async () => {
    const runtime = fakeRuntime(() => {
      throw new Error("the container would not start");
    });
    await withWorker(
      { thrown: { handle: () => [{ session: null, text: "attempted" }] } },
      runtime,
      async (worker) => {
        const id = await emit(worker, "thrown");
        const row = await settled(id);

        assert.equal(row.state, "failed");
        assert.match(row.error ?? "", /would not start/);
        assert.deepEqual(
          (await runsOf(id)).map((run) => [run.state, run.error]),
          [["failed", "the container would not start"]],
        );
      },
    );
  });
});

describe("wakeup", () => {
  const one: SignalHandlers = { woken: { handle: () => [{ session: null, text: "woken" }] } };

  it("reaches a Signal the moment its transaction commits, with no sweep to wait for", async () => {
    const runtime = fakeRuntime();
    await withNotifiedWorker(one, runtime, async (worker, entries) => {
      const id = await emit(worker, "woken");
      assert.equal((await settled(id)).state, "done");

      assert.equal(wakeups(entries, "sweep"), 0);
      assert.ok(wakeups(entries, "notification") >= 1, "the notification should have woken it");
    });
  });

  it("drains a burst emitted together without one wakeup per Signal", async () => {
    const runtime = fakeRuntime();
    const numbered: SignalHandler<{ n: number }> = {
      handle: (signal) => [{ session: null, text: String(signal.payload.n) }],
    };

    await withNotifiedWorker({ burst: numbered }, runtime, async (worker, entries) => {
      const ids = await db.tx(async (tx) => {
        const emitted: string[] = [];
        for (const n of [1, 2, 3, 4, 5]) {
          emitted.push(await worker.emit(tx, { kind: "burst", payload: { n } }));
        }
        return emitted;
      });
      for (const id of ids) assert.equal((await settled(id)).state, "done");

      assert.deepEqual(runtime.texts(), ["1", "2", "3", "4", "5"]);
      assert.equal(runtime.overlapped, false);
      assert.equal(wakeups(entries, "notification"), 1);
      assert.equal(wakeups(entries, "sweep"), 0);
    });
  });

  it("finds a Signal that arrived with no notification, on the sweep", async () => {
    const runtime = fakeRuntime();
    await withWorker(one, runtime, async (_core, entries) => {
      await waitUntil("the worker has swept twice", async () => wakeups(entries, "sweep") >= 2);

      const [inserted] = await db
        .handle({ signals })
        .insert(signals)
        .values({ kind: "woken", payload: {} })
        .returning({ id: signals.id });
      assert.ok(inserted);

      assert.equal((await settled(inserted.id)).state, "done");
      assert.equal(wakeups(entries, "notification"), 0, "no notification was ever sent");
    });
  });

  it("is harmless when a notification arrives with nothing pending", async () => {
    const runtime = fakeRuntime();
    await withNotifiedWorker(one, runtime, async (worker, entries) => {
      for (const _ of [1, 2, 3]) await notifyNothing();
      await waitUntil("all three spurious notifications arrive", async () => {
        return wakeups(entries, "notification") >= 3;
      });

      const id = await emit(worker, "woken");
      assert.equal((await settled(id)).state, "done");
      assert.deepEqual(
        entries.filter((entry) => entry.level === "error"),
        [],
      );
    });
  });

  it("processes a Signal once however many notifications arrive for it", async () => {
    const runtime = fakeRuntime();
    await withNotifiedWorker(one, runtime, async (worker, entries) => {
      const id = await emit(worker, "woken");
      for (const _ of [1, 2, 3]) await notifyNothing();
      assert.equal((await settled(id)).state, "done");

      assert.deepEqual(runtime.texts(), ["woken"]);
      assert.equal(runtime.overlapped, false);
      assert.equal((await runsOf(id)).length, 1);
      assert.equal(
        entries.filter((entry) => entry.message === "Signal claimed").length,
        1,
        "the Signal should have been claimed once",
      );
    });
  });

  it("keeps working when its listening connection is cut", async () => {
    const runtime = fakeRuntime();
    await withNotifiedWorker(one, runtime, async (worker, entries) => {
      const before = await emit(worker, "woken");
      assert.equal((await settled(before)).state, "done");

      await cutListeningBackends(db);
      await waitUntil("the Signal Worker is listening again", async () => {
        return entries.filter((entry) => entry.message === listeningMessage).length >= 2;
      });

      const after = await emit(worker, "woken");
      assert.equal((await settled(after)).state, "done");

      assert.ok(
        entries.some((entry) => entry.level === "warn" && /notification/.test(entry.message)),
        "the lost connection should be reported",
      );
      assert.ok(wakeups(entries, "listening") >= 2, "reconnecting should wake the worker");
      assert.equal(wakeups(entries, "sweep"), 0, "the sweep never ran, so the notification did it");
    });
  });

  it("catches a Signal emitted before its registration was in place", async () => {
    const held = 300;
    const slowToRegister: Db = {
      ...db,
      listen(channel, listener) {
        let real: Listening | undefined;
        let closed = false;
        const timer = setTimeout(() => {
          if (!closed) real = db.listen(channel, listener);
        }, held);
        return {
          async close() {
            closed = true;
            clearTimeout(timer);
            await real?.close();
          },
        };
      },
    };

    const runtime = fakeRuntime();
    const entries: LogEntry[] = [];
    const worker = createSignalWorker({
      db: slowToRegister,
      runtime,
      handlers: one,
      logger: recordingLogger(entries),
      sweepIntervalMs: sleepingSweepMs,
    });
    await worker.start();
    try {
      const id = await emit(worker, "woken");
      assert.equal((await settled(id)).state, "done");
      assert.equal(wakeups(entries, "notification"), 0, "nothing was listening when it was sent");
      assert.equal(wakeups(entries, "sweep"), 0);
      await waitUntil("the Signal Worker's registration is in place", async () =>
        entries.some((entry) => entry.message === listeningMessage),
      );
      assert.ok(
        wakeups(entries, "listening") >= 1,
        "the registration completing should itself be a wakeup",
      );
    } finally {
      await worker.stop();
    }
  });
});

describe("restart recovery", () => {
  it("fails a Signal left processing, resolves its Runs, and never re-runs it", async () => {
    const [stranded] = await db
      .handle({ signals })
      .insert(signals)
      .values({ kind: "stranded", payload: { half: "done" }, state: "processing" })
      .returning({ id: signals.id });
    assert.ok(stranded);
    await db
      .handle({ runs })
      .insert(runs)
      .values([
        {
          signalId: stranded.id,
          session: "user_1",
          prompt: "was running",
          state: "running",
          startedAt: new Date(),
        },
        { signalId: stranded.id, session: "user_2", prompt: "never started", state: "pending" },
      ]);

    const runtime = fakeRuntime();
    let handled = 0;
    await withWorker(
      {
        stranded: {
          handle: () => {
            handled += 1;
            return [];
          },
        },
      },
      runtime,
      async (worker, entries) => {
        const row = await settled(stranded.id);
        assert.equal(row.state, "failed");
        assert.match(row.error ?? "", /restart/);

        assert.equal(handled, 0);
        assert.deepEqual(runtime.recorded, []);

        const rows = await runsOf(stranded.id);
        assert.deepEqual(
          rows.map((run) => [run.prompt, run.state]).sort(),
          [
            ["never started", "failed"],
            ["was running", "failed"],
          ].sort(),
        );
        assert.ok(
          rows.every((run) => run.error !== null && run.endedAt instanceof Date),
          "every Run should carry a reason and an end",
        );
        assert.ok(
          entries.some((entry) => entry.level === "warn" && entry.fields.signalId === stranded.id),
          "the recovery should be reported",
        );

        const next = await emit(worker, "stranded");
        assert.equal((await settled(next)).state, "done");
        assert.equal(handled, 1);
      },
    );
  });
});

describe("logging", () => {
  it("logs the Signal claimed, and each Run started and finished", async () => {
    const entries: LogEntry[] = [];
    const worker = createSignalWorker({
      db,
      runtime: fakeRuntime(),
      handlers: { logged: { handle: () => [{ session: "user_1", text: "hello" }] } },
      logger: recordingLogger(entries),
      sweepIntervalMs: sweepingMs,
    });
    await worker.start();

    try {
      const id = await emit(worker, "logged");
      await settled(id);

      assert.deepEqual(
        entries.filter((entry) => entry.fields.signalId === id).map((entry) => entry.message),
        ["Signal claimed", "Run started", "Run finished", "Signal finished"],
      );
    } finally {
      await worker.stop();
    }
  });

  it("carries the Handler's own error on the failure it logs", async () => {
    const entries: LogEntry[] = [];
    const thrown = new Error("the Handler could not cope");
    const worker = createSignalWorker({
      db,
      runtime: fakeRuntime(),
      handlers: {
        "logged.failure": {
          handle: () => {
            throw thrown;
          },
        },
      },
      logger: recordingLogger(entries),
      sweepIntervalMs: sweepingMs,
    });
    await worker.start();

    try {
      const id = await emit(worker, "logged.failure");
      await settled(id);

      const failure = entries.find(
        (entry) => entry.level === "error" && entry.fields.signalId === id,
      );
      assert.ok(failure, "a Handler failure should be logged at error");
      assert.equal(failure.fields.err, thrown);
    } finally {
      await worker.stop();
    }
  });

  it("works with the default logger when the Operator supplies none", async () => {
    const worker = createSignalWorker({
      db,
      runtime: fakeRuntime(),
      handlers: { "default.logger": { handle: () => [{ session: null, text: "logged by pino" }] } },
      sweepIntervalMs: sweepingMs,
    });
    await worker.start();

    try {
      const id = await emit(worker, "default.logger");
      assert.equal((await settled(id)).state, "done");
    } finally {
      await worker.stop();
    }
  });
});
