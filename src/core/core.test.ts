/**
 * The worker and Signal Handler dispatch: the heart of the Core.
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
import { asc, eq } from "drizzle-orm";
import type { LogFields, Logger } from "../logging.ts";
import type { Store } from "../store/index.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";
import { type Core, createCore } from "./core.ts";
import type { SignalHandler, SignalHandlers } from "./handlers.ts";
import { coreMigrations } from "./migrations.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { runs, signals } from "./schema.ts";

let database: TestDatabase;
let store: Store;

before(async () => {
  database = await createTestDatabase("core");
  store = database.store;
  await store.migrate(coreMigrations);
});

after(() => database.drop());

/** The Core logs on every Signal; only the logging tests care what it said. */
const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Fast enough that no test waits on the interval. It is the only wakeup mechanism
 * in this slice; ticket 04 makes the emitting transaction wake the worker and
 * leaves this as the sweep behind it.
 */
const wakeupIntervalMs = 5;

/**
 * A Core of its own per test, so each brings its own Handler map — which is what
 * `start` taking the map means in practice. Signals from earlier tests are all in a
 * terminal state, so nothing carries over.
 */
async function withCore(
  handlers: SignalHandlers,
  runtime: RuntimeAdapter,
  body: (core: Core) => Promise<void>,
): Promise<void> {
  const core = createCore({ store, runtime, logger: silent, wakeupIntervalMs });
  core.start(handlers);
  try {
    await body(core);
  } finally {
    await core.stop();
  }
}

/** Emitting as a Producer does: inside a transaction the caller owns (ADR-0023). */
function emit(core: Core, kind: string, payload: unknown = {}): Promise<string> {
  return store.tx((tx) => core.emit(tx, { kind, payload }));
}

async function signalRow(id: string): Promise<typeof signals.$inferSelect | undefined> {
  const [row] = await store.handle({ signals }).select().from(signals).where(eq(signals.id, id));
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
  return store
    .handle({ runs })
    .select()
    .from(runs)
    .where(eq(runs.signalId, signalId))
    .orderBy(asc(runs.startedAt));
}

describe("core.emit", () => {
  it("records a Signal as pending", async () => {
    // No worker started, so what is asserted is what `emit` wrote and nothing else.
    const core = createCore({ store, runtime: fakeRuntime(), logger: silent });
    const id = await emit(core, "recorded.pending", { hello: "world" });

    const row = await signalRow(id);
    assert.equal(row?.state, "pending");
    assert.equal(row?.kind, "recorded.pending");
    assert.deepEqual(row?.payload, { hello: "world" });
    assert.equal(row?.error, null);

    // Nothing would ever claim it, and a later test's Core would fail it as an
    // unhandled kind.
    await store.handle({ signals }).delete(signals).where(eq(signals.id, id));
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

    await withCore({ "rolled-back": handler, marker: handler }, runtime, async (core) => {
      let rolledBackId: string | undefined;
      await assert.rejects(
        () =>
          store.tx(async (tx) => {
            rolledBackId = await core.emit(tx, { kind: "rolled-back", payload: {} });
            throw new Error("the Producer changed its mind");
          }),
        /changed its mind/,
      );
      assert.ok(rolledBackId, "emit should have returned an id before the rollback");

      // A Signal emitted afterwards that does commit is what makes "never
      // processed" a fact rather than a race this test happened to win: the worker
      // demonstrably looked at the queue after the rollback.
      const markerId = await emit(core, "marker");
      assert.equal((await settled(markerId)).state, "done");

      assert.deepEqual(seen, ["marker"]);
      assert.equal(await signalRow(rolledBackId), undefined);
    });
  });
});

describe("core.start", () => {
  it("refuses a second call, because one Core runs one worker", async () => {
    const core = createCore({ store, runtime: fakeRuntime(), logger: silent, wakeupIntervalMs });
    core.start({ started: { handle: () => [] } });
    try {
      assert.throws(() => core.start({ started: { handle: () => [] } }), /already been called/);
    } finally {
      await core.stop();
    }
  });
});

/**
 * The type checker is the assertion: the Handler map is a parameter of `start`, so
 * a Core started with none registered is unrepresentable (ADR-0021). Never called —
 * if `start` ever grew an optional signature, `@ts-expect-error` would fail the
 * typecheck.
 */
export function startingWithoutHandlersDoesNotCompile(core: Core): void {
  // @ts-expect-error start takes the kind-to-Handler map
  core.start();
}

describe("the worker", () => {
  it("dispatches on kind to exactly one Handler", async () => {
    const seenByA: string[] = [];
    const seenByB: string[] = [];

    await withCore(
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
      async (core) => {
        const id = await emit(core, "b.kind");
        await settled(id);

        assert.deepEqual(seenByA, []);
        assert.deepEqual(seenByB, [id]);
      },
    );
  });

  it("leaves a Signal that produced no Prompts done, with no Runs", async () => {
    const runtime = fakeRuntime();
    await withCore({ decline: { handle: () => [] } }, runtime, async (core) => {
      const id = await emit(core, "decline");
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
    await withCore(
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
      async (core) => {
        const id = await emit(core, "fan");
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
    // The Handler also declares the payload it expects. The Core carries payloads
    // as `unknown`, because their shape is the Producer's contract rather than the
    // framework's, and a Handler narrowing it still goes in the map.
    const ordered: SignalHandler<{ n: number }> = {
      handle: (signal) => [
        { session: `user_${signal.payload.n}`, text: `${signal.payload.n}a` },
        { session: null, text: `${signal.payload.n}b` },
      ],
    };

    await withCore({ ordered }, runtime, async (core) => {
      const ids: string[] = [];
      for (const n of [1, 2, 3] as const) {
        ids.push(await emit(core, "ordered", { n }));
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

    await withCore(
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
      async (core) => {
        const id = await emit(core, "posted");
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

    await withCore(
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
      async (core) => {
        const id = await emit(core, "posted");
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
    await withCore(
      {
        "posted.badly": {
          handle: () => [{ session: null, text: "ran fine" }],
          post: () => {
            throw new Error("the cleanup could not cope");
          },
        },
      },
      runtime,
      async (core) => {
        const id = await emit(core, "posted.badly");
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

    await withCore(
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
      async (core) => {
        const boomId = await emit(core, "boom");
        const fineId = await emit(core, "fine");

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
    await withCore({ known: { handle: () => [] } }, runtime, async (core) => {
      const id = await emit(core, "typo.in.kind");
      const row = await settled(id);

      assert.equal(row.state, "failed");
      assert.match(row.error ?? "", /typo\.in\.kind/);
      assert.deepEqual(await runsOf(id), []);
      assert.deepEqual(runtime.recorded, []);
    });
  });

  it("rejects an invalid Session name where the Handler returned it", async () => {
    const runtime = fakeRuntime();
    await withCore(
      {
        colon: {
          handle: () => [
            { session: "user_1", text: "would have worked" },
            { session: "user:2", text: "does not" },
          ],
        },
      },
      runtime,
      async (core) => {
        const id = await emit(core, "colon");
        const row = await settled(id);

        assert.equal(row.state, "failed");
        assert.match(row.error ?? "", /user:2/);
        // Not partway through a Run: the valid Prompt ahead of it never ran either,
        // so the Operator is told about the name and nothing was set in motion.
        assert.deepEqual(await runsOf(id), []);
        assert.deepEqual(runtime.recorded, []);
      },
    );
  });

  it("hands the Runtime Adapter each Prompt with the id of the Run recorded for it", async () => {
    const observed: { runId: string; prompt: string | undefined; state: string | undefined }[] = [];
    // Reading the Run mid-flight is the one intermediate read in this file, and it
    // is here because the id is only useful if it names a Run that already exists —
    // this is what the agent sees over the Agent server while its Run is going.
    const runtime = fakeRuntime(async (_prompt, runId) => {
      const [row] = await store.handle({ runs }).select().from(runs).where(eq(runs.id, runId));
      observed.push({ runId, prompt: row?.prompt, state: row?.state });
      return { ok: true };
    });

    await withCore(
      {
        paired: {
          handle: () => [
            { session: "user_1", text: "first" },
            { session: "user_2", text: "second" },
          ],
        },
      },
      runtime,
      async (core) => {
        const id = await emit(core, "paired");
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
    await withCore(
      { thrown: { handle: () => [{ session: null, text: "attempted" }] } },
      runtime,
      async (core) => {
        const id = await emit(core, "thrown");
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

describe("logging", () => {
  it("logs the Signal claimed, and each Run started and finished", async () => {
    const entries: LogEntry[] = [];
    const core = createCore({
      store,
      runtime: fakeRuntime(),
      logger: recordingLogger(entries),
      wakeupIntervalMs,
    });
    core.start({ logged: { handle: () => [{ session: "user_1", text: "hello" }] } });

    try {
      const id = await emit(core, "logged");
      await settled(id);

      assert.deepEqual(
        entries.filter((entry) => entry.fields.signalId === id).map((entry) => entry.message),
        ["Signal claimed", "Run started", "Run finished", "Signal finished"],
      );
    } finally {
      await core.stop();
    }
  });

  it("carries the Handler's own error on the failure it logs", async () => {
    const entries: LogEntry[] = [];
    const thrown = new Error("the Handler could not cope");
    const core = createCore({
      store,
      runtime: fakeRuntime(),
      logger: recordingLogger(entries),
      wakeupIntervalMs,
    });
    core.start({
      "logged.failure": {
        handle: () => {
          throw thrown;
        },
      },
    });

    try {
      const id = await emit(core, "logged.failure");
      await settled(id);

      const failure = entries.find(
        (entry) => entry.level === "error" && entry.fields.signalId === id,
      );
      assert.ok(failure, "a Handler failure should be logged at error");
      // The Error itself, not its message: a `pino` logger serialises it with the
      // stack, and one the Operator wrote can do as it likes with it.
      assert.equal(failure.fields.err, thrown);
    } finally {
      await core.stop();
    }
  });

  it("works with the default logger when the Operator supplies none", async () => {
    // The only test with no `logger`, and the only one whose evidence is partly in
    // the test output: `pino`'s JSON lines on stdout are the default working.
    const core = createCore({ store, runtime: fakeRuntime(), wakeupIntervalMs });
    core.start({ "default.logger": { handle: () => [{ session: null, text: "logged by pino" }] } });

    try {
      const id = await emit(core, "default.logger");
      assert.equal((await settled(id)).state, "done");
    } finally {
      await core.stop();
    }
  });
});
