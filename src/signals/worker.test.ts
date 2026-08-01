/**
 * The drain loop and Signal Handler dispatch: the heart of the Signal Worker.
 *
 * PostgreSQL is real (ADR-0022) and the only fake is the Runtime Adapter, which is
 * the seam a container would otherwise sit behind. The Handlers are written inline,
 * because that is exactly what an Operator writes — a plain object closing over
 * whatever the test needs, with no harness from us (ADR-0024).
 *
 * Every assertion here is on something an Operator or the agent could see: what a
 * Signal's state and error end up as, what Runs exist behind it, what the adapter
 * was handed, and in what order. None reads an intermediate row to confirm an
 * internal step, with one deliberate exception noted where it happens.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { asc, eq, sql } from "drizzle-orm";
import type { Db, Listening } from "../db/index.ts";
import type { LogFields, Logger } from "../logging.ts";
import { cutListeningBackends } from "../test-support/backends.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";
import type { SignalHandler, SignalHandlers } from "./handlers.ts";
import { signalsMigrations } from "./migrations.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { runs, signals } from "./schema.ts";
import { createSignalWorker, type SignalWorker, signalChannel } from "./worker.ts";

let database: TestDatabase;
let db: Db;

before(async () => {
  database = await createTestDatabase("worker");
  db = database.db;
  db.registerMigrations(signalsMigrations);
  await db.migrate();
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

/**
 * A sweep fast enough that no test about dispatch waits on a notification arriving,
 * and one far enough away that a test about notifications cannot be rescued by it.
 *
 * The second number is the load-bearing one: it is longer than `waitUntil`'s own
 * patience, so a Signal that only the sweep could have found fails the test.
 */
const sweepingMs = 5;
const sleepingSweepMs = 60_000;

/** What the Signal Worker logs once its notification connection is up. */
const listeningMessage = "listening for Signal notifications";

type WorkerBody = (worker: SignalWorker, entries: readonly LogEntry[]) => Promise<void>;

/**
 * A Signal Worker of its own per test, so each brings its own Handler map — which is
 * what constructing with the map means in practice. Signals from earlier tests are all
 * in a terminal state, so nothing carries over.
 *
 * Every Worker records what it logged, because what woke it is only visible there: a
 * Signal reaching `done` says nothing about which of the two mechanisms found it.
 */
async function withWorker(
  handlers: SignalHandlers,
  runtime: RuntimeAdapter,
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

/**
 * A Signal Worker whose sweep is out of reach, and which is already listening before
 * the body runs — so a notification is the only thing that can wake it, and one sent
 * in the gap before the registration was in place cannot be mistaken for one lost.
 */
function withNotifiedWorker(
  handlers: SignalHandlers,
  runtime: RuntimeAdapter,
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

/** How many times the worker was woken for a given reason. */
function wakeups(entries: readonly LogEntry[], reason: string): number {
  return entries.filter(
    (entry) => entry.message === "worker woken" && entry.fields.reason === reason,
  ).length;
}

/** A notification for the Signal Worker's channel that no Signal is behind. */
function notifyNothing(): Promise<unknown> {
  return db.handle({}).execute(sql`select pg_notify(${signalChannel}, '')`);
}

/** Emitting as a Producer does: inside a transaction the caller owns (ADR-0023). */
function emit(worker: SignalWorker, kind: string, payload: unknown = {}): Promise<string> {
  return db.tx((tx) => worker.emit(tx, { kind, payload }));
}

async function signalRow(id: string): Promise<typeof signals.$inferSelect | undefined> {
  const [row] = await db.handle({ signals }).select().from(signals).where(eq(signals.id, id));
  return row;
}

/** Waits for the worker to finish with a Signal and returns what it recorded. */
async function settled(id: string): Promise<typeof signals.$inferSelect> {
  await waitUntil(`Signal ${id} reaches a terminal state`, async () => {
    const state = (await signalRow(id))?.state;
    return state === "done" || state === "failed";
  });
  const row = await signalRow(id);
  assert.ok(row);
  return row;
}

/** A Signal's Runs, in the order the worker started them. */
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
    // No worker started, so what is asserted is what `emit` wrote and nothing else —
    // and a Handler map with nothing in it, because nothing here dispatches.
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

    // Nothing would ever claim it, and a later test's Signal Worker would fail it as an
    // unhandled kind.
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

        // A Signal emitted afterwards that does commit is what makes "never
        // processed" a fact rather than a race this test happened to win: the worker
        // demonstrably looked at the queue after the rollback.
        const markerId = await emit(worker, "marker");
        assert.equal((await settled(markerId)).state, "done");

        assert.deepEqual(seen, ["marker"]);
        assert.equal(await signalRow(rolledBackId), undefined);

        // And the wakeup went with it. The notification is sent inside the caller's
        // transaction, so the abandoned one was never delivered — exactly one
        // notification arrived, the marker's. Nudging the worker after commit
        // instead would have woken it for a Signal that does not exist.
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

/**
 * The type checker is the assertion: the Handler map is a construction option, so a
 * Signal Worker with none is unconstructable rather than merely unstartable
 * (ADR-0021). Never called — if `handlers` ever became optional, `@ts-expect-error`
 * would fail the typecheck.
 */
export function constructingWithoutHandlersDoesNotCompile(runtime: RuntimeAdapter): SignalWorker {
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

      // Declining is not a special case, and the arrival record survives it —
      // which is what makes a Handler's refusal auditable.
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
        assert.deepEqual(
          rows.map((row) => [row.session, row.prompt, row.state, row.error]),
          [
            ["user_1", "one", "done", null],
            ["user_2", "two", "done", null],
            [null, "three, in a fresh Session", "done", null],
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
    // Two Prompts per Signal, so "one at a time" covers both directions it could
    // be broken in: Runs of one Signal overlapping each other, and Runs of two
    // Signals overlapping. Different Sessions make no difference — the worker is
    // serial globally, and a shared Workspace is safe for no other reason
    // (ADR-0012).
    //
    // The Handler also declares the payload it expects. The Signal Worker carries
    // payloads as `unknown`, because their shape is the Producer's contract rather
    // than the framework's, and a Handler narrowing it still goes in the map.
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

        // The Prompt after the failing one still ran: the Handler asked for both,
        // and nothing here is retried or abandoned (ADR-0017).
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

        // The Runs succeeded and the Signal still failed, because processing it
        // did not finish cleanly and a log line is not somewhere an Operator
        // looks for a Signal's outcome.
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

        // The worker carried on, which is the half of this that matters.
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

  it("hands the Runtime Adapter any Session name, and fails only the Run it rejects", async () => {
    // What makes a name acceptable is the Agent Runtime's to say and nothing here
    // holds a copy of it (ADR-0016), so every Prompt reaches the adapter with the
    // name its Handler wrote — including the two spellings a check of ours would
    // have refused.
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
          runtime.recorded.map((run) => run.prompt.session),
          ["user_1", "user:2", "../escape"],
        );
        // The rejected name is on its own Run's row beside the runtime's own words,
        // and the Prompts around it ran — which is the ordinary shape of a failed
        // Run (ADR-0017) rather than an exception the framework made for names.
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

  it("hands the Runtime Adapter each Prompt with the id of the Run recorded for it", async () => {
    const observed: { runId: string; prompt: string | undefined; state: string | undefined }[] = [];
    // Reading the Run mid-flight is the one intermediate read in this file, and it
    // is here because the id is only useful if it names a Run that already exists —
    // this is what the agent sees over the Agent server while its Run is going.
    const runtime = fakeRuntime(async (_prompt, runId) => {
      const [row] = await db.handle({ runs }).select().from(runs).where(eq(runs.id, runId));
      observed.push({ runId, prompt: row?.prompt, state: row?.state });
      return { ok: true };
    });

    await withWorker(
      {
        paired: {
          handle: () => [
            { session: "user_1", text: "first" },
            { session: "user_2", text: "second" },
          ],
        },
      },
      runtime,
      async (worker) => {
        const id = await emit(worker, "paired");
        await settled(id);

        const rows = await runsOf(id);
        assert.deepEqual(
          observed.map((seen) => [seen.prompt, seen.state]),
          [
            ["first", "running"],
            ["second", "running"],
          ],
        );
        assert.deepEqual(
          observed.map((seen) => seen.runId).sort(),
          rows.map((row) => row.id).sort(),
        );
        assert.deepEqual(
          runtime.recorded.map((run) => [run.prompt.session, run.prompt.text]),
          [
            ["user_1", "first"],
            ["user_2", "second"],
          ],
        );
      },
    );
  });

  it("treats a Runtime Adapter that throws as a failed Run rather than a dead worker", async () => {
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

      // The sweep is a minute away and the test's own patience is ten seconds, so a
      // Signal that arrived here at all arrived on a notification.
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
      // One wakeup for five Signals, from both halves of the design: PostgreSQL
      // collapses identical notifications sent in one transaction, and the worker
      // drains rather than taking one Signal per wakeup.
      assert.equal(wakeups(entries, "notification"), 1);
      assert.equal(wakeups(entries, "sweep"), 0);
    });
  });

  it("finds a Signal that arrived with no notification, on the sweep", async () => {
    const runtime = fakeRuntime();
    await withWorker(one, runtime, async (_core, entries) => {
      // Two sweeps in, so the drain that `start` kicked off is long finished and the
      // row below can only be found by a sweep after it.
      await waitUntil("the worker has swept twice", async () => wakeups(entries, "sweep") >= 2);

      // A row in the queue with nothing sent on the channel: the shape of a
      // notification lost while the listening connection was down, which is the only
      // thing the sweep exists for. Without it this Signal would sit here forever
      // and nothing would say so.
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

      // The worker looked three times, found nothing, and is still working.
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
      // Duplicates while the Run is still in flight, which is when a second drain
      // would break the serial guarantee rather than merely waste a query.
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

      // Cut from the server's side, as a restart or an operator would.
      await cutListeningBackends(db);
      await waitUntil("the Signal Worker is listening again", async () => {
        return entries.filter((entry) => entry.message === listeningMessage).length >= 2;
      });

      const after = await emit(worker, "woken");
      assert.equal((await settled(after)).state, "done");

      // Reported rather than swallowed, and the reconnection is itself a wakeup:
      // anything sent while the connection was down was never delivered.
      assert.ok(
        entries.some((entry) => entry.level === "warn" && /notification/.test(entry.message)),
        "the lost connection should be reported",
      );
      assert.ok(wakeups(entries, "listening") >= 2, "reconnecting should wake the worker");
      assert.equal(wakeups(entries, "sweep"), 0, "the sweep never ran, so the notification did it");
    });
  });

  it("catches a Signal emitted before its registration was in place", async () => {
    // The gap `start` leaves: it returns before the `LISTEN` is registered, and a
    // notification sent in between is lost exactly as one sent while the connection
    // was down is. A Producer emitting immediately is not a contrived case — it is a
    // Gateway's first Signal, when someone is watching.
    //
    // The gap is a few milliseconds wide, so it is held open here instead of raced
    // for: a Db that delays only the registration, and the real one behind it.
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
      // Nothing heard the notification, and the sweep is a minute away, so the only
      // thing that can find this Signal is the registration completing.
      assert.equal((await settled(id)).state, "done");
      assert.equal(wakeups(entries, "notification"), 0, "nothing was listening when it was sent");
      assert.equal(wakeups(entries, "sweep"), 0);
      assert.ok(wakeups(entries, "listening") >= 1);
    } finally {
      await worker.stop();
    }
  });
});

describe("restart recovery", () => {
  it("fails a Signal left processing, resolves its Runs, and never re-runs it", async () => {
    // What a worker that died mid-Signal leaves behind: the Signal it had claimed,
    // one Run it had started, and one it had recorded but not begun.
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
        // Why, in the row rather than only in a log line: this is where an Operator
        // asks what happened to it.
        assert.match(row.error ?? "", /restart/);

        // Not re-run, which is the whole point (ADR-0017): its Runs may already have
        // sent Messages, written the Workspace, or called something outside.
        assert.equal(handled, 0);
        assert.deepEqual(runtime.recorded, []);

        // And nothing is left claiming to be in flight.
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

        // The worker went on to do its actual job, rather than recovery being
        // something that happens instead of working.
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
      // The Error itself, not its message: a `pino` logger serialises it with the
      // stack, and one the Operator wrote can do as it likes with it.
      assert.equal(failure.fields.err, thrown);
    } finally {
      await worker.stop();
    }
  });

  it("works with the default logger when the Operator supplies none", async () => {
    // The only test with no `logger`, and the only one whose evidence is partly in
    // the test output: `pino`'s JSON lines on stdout are the default working.
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
