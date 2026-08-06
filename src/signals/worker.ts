/**
 * The Signal Worker: the Signal queue, Signal Handler dispatch, and Run execution.
 *
 * It holds no identity and knows nothing about messaging. It runs one Run at a time, whatever
 * Session that Run is in. That is the only reason a Workspace shared by every Signal Handler and
 * the agent is safe to have.
 *
 * Three things wake it:
 *
 *  - **a notification**, sent by `emit` inside the caller's transaction. The wakeup and the row
 *    becoming visible are one event, so a Signal from a rolled-back transaction wakes nobody.
 *  - **the sweep**, an interval, because PostgreSQL queues nothing for an absent listener. A
 *    notification sent while the connection was down is gone.
 *  - **the registration going in**, on the first connection and after every reconnection. It is
 *    the same case caught early.
 *
 * None of them says how much there is to do. So the worker drains: it runs until the queue is
 * empty. A duplicated or spurious wakeup is therefore harmless, and a burst is one wakeup.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Component } from "../components.ts";
import type { Db, Handle, Listening } from "../db/index.ts";
import { defaultLogger, type Logger } from "../logging.ts";
import type { Prompt, Signal, SignalHandlers } from "./handlers.ts";
import { agentReadRoutes } from "./routes.ts";
import type { RunOutcome, RunPrompt, Runtime } from "./runtime.ts";
import { runs, signals, workerTables } from "./schema.ts";

/** What a Producer hands to `worker.emit`. */
export type EmittedSignal = {
  /** Selects exactly one Signal Handler. A `kind` with no Handler fails the Signal. */
  readonly kind: string;
  /**
   * Arbitrary JSON, taken as fact.
   *
   * The Signal Worker believes whatever a Producer writes here, including any claim about who the
   * Signal came from. That is why Producers are parts of the Gateway rather than peers outside it.
   */
  readonly payload: unknown;
};

/** Everything `createSignalWorker` needs. Three required values, and three with defaults. */
export type SignalWorkerOptions = {
  readonly db: Db;
  /** Drives the Agent Implementation. One Run at a time, never concurrently. */
  readonly runtime: Runtime;
  /**
   * The `kind`-to-Handler map: what this Gateway can act on, and the whole of it.
   *
   * A construction option rather than an argument to `start`. So a Signal Worker with no Handlers
   * is unconstructable, not merely unstartable. A Signal whose `kind` has no Handler fails
   * permanently.
   *
   * A Handler cannot close over the Worker it runs under. A Handler that emits is a `let` in the
   * entry point, assigned after construction.
   */
  readonly handlers: SignalHandlers;
  /**
   * The Agent server, if the agent is to read prior Signals and Runs.
   *
   * Given one, the constructor registers `agentRoutes` on its Fastify instance at no prefix:
   * `/signals`, `/signals/:id`, `/runs`, `/runs/:id`. Omit it and nothing is registered anywhere,
   * which is how the group is switched off.
   *
   * Structural, and it asks for nothing but the Fastify instance. What `serverComponent` returns
   * satisfies it. A server built on http2 does not, and takes the `agentRoutes` plugin instead.
   */
  readonly agentServer?: {
    readonly fastify: FastifyInstance;
  };
  /** Defaults to a `pino` instance on stdout. */
  readonly logger?: Logger;
  /**
   * How often the worker looks for pending Signals regardless of notifications, in milliseconds.
   *
   * Not the latency of a Signal: emitting one wakes the worker immediately. This is the safety net
   * for a notification sent while the listening connection was down. Lower it if a Signal waiting
   * this long during a database restart is unacceptable. There is no correctness in the number.
   */
  readonly sweepIntervalMs?: number;
};

/**
 * The one Signal Worker a Gateway runs: a queue to emit into, and a Component to start and stop.
 */
export type SignalWorker = Component & {
  /**
   * The Signal Worker's Agent server routes, as a Fastify plugin you can register yourself.
   *
   * Register it under a prefix of your own, or inside your own encapsulated plugin. A hook you
   * share with your own routes works too. Passing no server and never registering this is how
   * the group is switched off.
   *
   * The routes read the Signal Worker's tables and no other component's. The whole surface is
   * read-only and unscoped: every Signal and every Run, whatever Session the reading Run is in.
   */
  readonly agentRoutes: FastifyPluginAsync;

  /**
   * Records a Signal as `pending` and returns its id.
   *
   * It takes the caller's transaction rather than finding one. A Producer therefore cannot
   * record something and tell the agent about it separately. The Messenger writes the inbound
   * Message and emits in one transaction, and a rollback loses both.
   *
   * @param tx The caller's own handle or transaction. The schema is widened rather than named,
   *   because the transaction carries the schema of the handle it started on.
   * @returns The new Signal's id.
   */
  emit<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    signal: EmittedSignal,
  ): Promise<string>;

  /**
   * Starts looking for Signals, with the Handlers this Worker was constructed with.
   *
   * It resolves immediately. The first thing the worker then does is fail whatever a previous
   * worker left `processing`. Nothing an Operator does next depends on that finishing. A Signal
   * emitted meanwhile is a row in a queue, drained once recovery is done.
   */
  start(): Promise<void>;

  /**
   * Stops looking for Signals and waits for the one in flight to finish.
   *
   * Not a shutdown protocol. Ordering is the Operator's, and the framework ships no signal
   * handling. There is no cancellation. A Run in flight runs to completion, because abandoning
   * it would leave partial effects nothing retries.
   */
  stop(): Promise<void>;
};

/**
 * The channel the Signal Worker notifies and listens on.
 *
 * Prefixed for the same reason the schema is. Notification channels are per database, and the
 * framework is installed into one it does not own.
 *
 * Not overridable. A Worker notifying a channel a different one listens on looks healthy and
 * runs nothing until the sweep.
 */
export const signalChannel = "saf_signals_signal";

/** How long a Signal can sit unnoticed if its notification was lost. */
const defaultSweepIntervalMs = 5_000;

/** What a Signal and its Runs are failed with when a previous worker left them behind. */
const strandedSignal =
  "the worker stopped while this Signal was processing, and it is failed rather than re-run after the restart: its Runs may already have sent Messages, written the Workspace, or called something outside (ADR-0017)";
const strandedRun = "the worker stopped before this Run finished; Runs are never re-run (ADR-0017)";

/**
 * Why the worker woke, for the debug line.
 *
 * `listening` covers the first registration and every reconnection. Both mean the worker can now
 * be notified, and a moment ago it was not.
 */
type WakeupReason = "start" | "notification" | "listening" | "sweep";

/**
 * Builds a Signal Worker over a Db, a Runtime and a map of Signal Handlers.
 *
 * `createGateway` builds one for you and keys it last, so it drains first. Call this yourself only
 * when you assemble a Gateway with `createBareGateway`.
 *
 * @param options The Db, the Runtime, the Handler map, and optionally the Agent server the read
 *   routes go on.
 *
 * @example
 * ```ts
 * import { openDb } from "shared-agent-framework";
 * import { createSignalWorker } from "shared-agent-framework/signals";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 *
 * const db = openDb(process.env.DATABASE_URL ?? "");
 * const worker = createSignalWorker({
 *   db,
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   handlers: {
 *     "note.written": { handle: (signal) => [{ session: "notes", text: String(signal.payload) }] },
 *   },
 * });
 *
 * await db.start();
 * await worker.start();
 * ```
 */
export function createSignalWorker(options: SignalWorkerOptions): SignalWorker {
  const log = options.logger ?? defaultLogger();
  const runtime = options.runtime;
  const handlers = options.handlers;
  const sweepIntervalMs = options.sweepIntervalMs ?? defaultSweepIntervalMs;

  // The Signal Worker's own handle, typed to its own schema. `pg` never leaves the Db.
  const handle = options.db.handle(workerTables);

  // The one act of wiring, here so that an Operator's entry point does not do it.
  const agentRoutes = agentReadRoutes(handle);
  // At no prefix, and not awaited. Fastify defers a plugin until the server is ready. So this is
  // a registration made at construction and loaded at `listen`. That is also why a server which
  // is already listening refuses one.
  options.agentServer?.fastify.register(agentRoutes);

  let started = false;
  let ticker: NodeJS.Timeout | undefined;
  let listening: Listening | undefined;
  /** The worker, while it is awake. One at a time, or the queue is not serial. */
  let working: Promise<void> | undefined;
  /** A wakeup arrived. Cleared by the drain that acts on it, never by the wakeup. */
  let woken = false;
  let recovered = false;
  let stopping = false;

  /**
   * Takes the oldest pending Signal and marks it `processing`, or reports that there is none.
   *
   * The update is guarded on the state it read, so two Gateways cannot both claim a Signal. They
   * would still break the serial guarantee in every other respect.
   */
  async function claim(): Promise<typeof signals.$inferSelect | undefined> {
    while (!stopping) {
      const [next] = await handle
        .select()
        .from(signals)
        .where(eq(signals.state, "pending"))
        .orderBy(asc(signals.emittedAt), asc(signals.id))
        .limit(1);
      if (next === undefined) return undefined;

      const [claimed] = await handle
        .update(signals)
        .set({ state: "processing" })
        .where(and(eq(signals.id, next.id), eq(signals.state, "pending")))
        .returning();
      if (claimed !== undefined) return claimed;
    }
    return undefined;
  }

  /**
   * Runs every pending Signal in arrival order and returns when none is left.
   *
   * Draining is what makes a spurious wakeup harmless. It also keeps a burst from waiting on the
   * interval once per Signal.
   */
  async function drain(): Promise<void> {
    for (;;) {
      const claimed = await claim();
      if (claimed === undefined) return;
      await processSignal(claimed);
    }
  }

  async function processSignal(row: typeof signals.$inferSelect): Promise<void> {
    const signal: Signal = {
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      emittedAt: row.emittedAt,
    };
    log.info({ signalId: signal.id, kind: signal.kind }, "Signal claimed");

    const handler = handlers[signal.kind];
    if (handler === undefined) {
      // A typo in a `kind` is visible rather than silent, and permanent. There is no Handler to
      // run a post phase on, and nothing re-runs it.
      const failure = `no Signal Handler is registered for kind ${JSON.stringify(signal.kind)}`;
      log.error({ signalId: signal.id, kind: signal.kind }, failure);
      await settle(signal, failure);
      return;
    }

    let prompts: readonly Prompt[] | undefined;
    let failure: string | undefined;
    try {
      prompts = await handler.handle(signal);
    } catch (error) {
      // A Handler is the Operator's own code and may throw. It fails its own Signal and nothing
      // else: the worker carries on, and the post phase still runs.
      prompts = undefined;
      failure = describe(error);
      log.error({ signalId: signal.id, kind: signal.kind, err: error }, "Signal Handler failed");
    }

    if (prompts !== undefined) {
      failure = await executeRuns(signal, prompts);
    }

    if (handler.post !== undefined) {
      try {
        await handler.post(signal, { failed: failure !== undefined });
      } catch (error) {
        log.error(
          { signalId: signal.id, kind: signal.kind, err: error },
          "Signal Handler post phase failed",
        );
        const postFailure = `the post phase failed: ${describe(error)}`;
        failure = failure === undefined ? postFailure : `${failure}; ${postFailure}`;
      }
    }

    await settle(signal, failure);
  }

  /**
   * Executes one Run per Prompt, in the order the Handler returned them. Reports why the Signal
   * failed, if any Run did.
   *
   * Every Prompt runs even after one fails. A Handler that fanned out to three Sessions asked for
   * three Runs.
   */
  async function executeRuns(
    signal: Signal,
    prompts: readonly Prompt[],
  ): Promise<string | undefined> {
    if (prompts.length === 0) {
      // Declining is not a special case. The Signal is `done` with no Runs, and the arrival
      // record survives, which is what makes a refusal auditable.
      return undefined;
    }

    // Ids are generated here rather than by the database, so each Run is paired with its own
    // Prompt. Nothing depends on the order a multi-row insert returns. Having the id in hand
    // before the insert also lets the Session be named from it, in the same row.
    const queued = prompts.map((prompt) => {
      const id = randomUUID();
      return { id, prompt: promptForRun(id, prompt) };
    });
    await handle.insert(runs).values(
      queued.map(({ id, prompt }) => ({
        id,
        signalId: signal.id,
        session: prompt.session,
        prompt: prompt.text,
      })),
    );

    const failures: string[] = [];
    for (const { id, prompt } of queued) {
      const outcome = await executeRun(signal, id, prompt);
      if (!outcome.ok) failures.push(outcome.error);
    }

    if (failures.length === 0) return undefined;
    const first = failures[0] ?? "";
    return failures.length === 1
      ? `the Run failed: ${first}`
      : `${failures.length} of ${queued.length} Runs failed, the first with: ${first}`;
  }

  async function executeRun(signal: Signal, runId: string, prompt: RunPrompt): Promise<RunOutcome> {
    log.info({ runId, signalId: signal.id, session: prompt.session }, "Run started");
    await handle
      .update(runs)
      .set({ state: "running", startedAt: sql`clock_timestamp()` })
      .where(eq(runs.id, runId));

    let outcome: RunOutcome;
    try {
      outcome = await runtime.run(prompt);
    } catch (error) {
      // An adapter that throws is a failed Run, not a dead worker.
      outcome = { ok: false, error: describe(error) };
    }

    await handle
      .update(runs)
      .set({
        state: outcome.ok ? "done" : "failed",
        error: outcome.ok ? null : outcome.error,
        endedAt: sql`clock_timestamp()`,
      })
      .where(eq(runs.id, runId));

    if (outcome.ok) {
      log.info({ runId, signalId: signal.id, session: prompt.session }, "Run finished");
    } else {
      log.error(
        { runId, signalId: signal.id, session: prompt.session, err: outcome.error },
        "Run failed",
      );
    }
    return outcome;
  }

  /** The Signal's one and only state write after `processing`. */
  async function settle(signal: Signal, failure: string | undefined): Promise<void> {
    const state = failure === undefined ? "done" : "failed";
    await handle
      .update(signals)
      .set({ state, error: failure ?? null })
      .where(eq(signals.id, signal.id));
    log.info({ signalId: signal.id, kind: signal.kind, state }, "Signal finished");
  }

  /**
   * Fails every Signal a previous worker left `processing`, and resolves the Runs under them.
   *
   * They are not re-run. A Run can already have sent Messages, written the Workspace, or called
   * something outside. Its Prompt is already in the Session on disk.
   *
   * The Runs are failed too, including ones that were only recorded. A Run row saying `running`
   * with nothing running is a lie.
   *
   * This must finish before anything is claimed. A drain alongside it would mark its own Signal
   * `processing` and have recovery fail it underneath. A Db error inside a drain gets here too, and
   * the next start resolves it.
   */
  async function recover(): Promise<void> {
    const stranded = await options.db.tx(async (tx) => {
      const failed = await tx
        .update(signals)
        .set({ state: "failed", error: strandedSignal })
        .where(eq(signals.state, "processing"))
        .returning({ id: signals.id, kind: signals.kind });
      if (failed.length > 0) {
        await tx
          .update(runs)
          .set({ state: "failed", error: strandedRun, endedAt: sql`clock_timestamp()` })
          .where(
            and(
              inArray(
                runs.signalId,
                failed.map((signal) => signal.id),
              ),
              inArray(runs.state, ["pending", "running"]),
            ),
          );
      }
      return failed;
    });

    for (const signal of stranded) {
      log.warn(
        { signalId: signal.id, kind: signal.kind },
        "Signal was left processing by a stopped worker: failed, and not re-run after the restart",
      );
    }
  }

  /**
   * Notes that there is something to look at, and starts the worker if it is asleep.
   *
   * A wakeup during a drain sets the flag rather than starting a second drain. Two would break the
   * serial guarantee. Dropping the flag would lose a Signal that committed just after the
   * drain's last look.
   */
  function wakeup(reason: WakeupReason): void {
    log.debug({ reason }, "worker woken");
    woken = true;
    if (working !== undefined) return;
    working = (async () => {
      try {
        if (!recovered) {
          await recover();
          recovered = true;
        }
        while (woken && !stopping) {
          woken = false;
          await drain();
        }
      } catch (error) {
        // Only the Db can get here, because Handler and adapter failures are handled per Signal.
        // Whatever was claimed stays `processing` for the next start to resolve. `woken` is still
        // set, so the worker tries again on the next wakeup rather than dying quietly.
        log.error({ err: error }, "the Signal worker stopped short, and retries when next woken");
      } finally {
        working = undefined;
      }
    })();
  }

  return {
    agentRoutes,

    async emit(tx, signal) {
      // The query-builder form, not the relational one. It generates SQL from the table object,
      // so it works on a transaction carrying any component's schema.
      const [inserted] = await tx
        .insert(signals)
        .values({ kind: signal.kind, payload: signal.payload })
        .returning({ id: signals.id });
      if (inserted === undefined) {
        throw new Error("emitting a Signal inserted no row");
      }

      // The wakeup, in the caller's transaction with the row. PostgreSQL delivers a notification
      // at commit and not at all on rollback. So this cannot wake the worker for a Signal that
      // never existed. Nor can it fail to wake it for one that does.
      //
      // `pg_notify` and not `NOTIFY`, because a utility statement takes no bind parameters. The
      // payload is empty on purpose: the worker drains the whole queue, so a notification means
      // only "look again". PostgreSQL collapses identical notifications sent in one transaction.
      // A Producer emitting a hundred Signals at once therefore wakes the worker once.
      await tx.execute(sql`select pg_notify(${signalChannel}, '')`);
      return inserted.id;
    },

    async start() {
      if (started) {
        throw new Error(
          "worker.start has already been called. One Signal Worker drains one queue, because Runs are serial globally (ADR-0012); construct a second Signal Worker if a second queue is really what you want.",
        );
      }
      started = true;

      // The connection carrying the notifications is the Db's to hold. A `LISTEN` registration
      // cannot live on a pooled connection, and `pg` does not leave the Db to get one.
      listening = options.db.listen(signalChannel, {
        notified: () => wakeup("notification"),
        connected: () => {
          log.debug({ channel: signalChannel }, "listening for Signal notifications");
          // Every registration is a reason to look, the first one included. Anything sent before
          // it was in place was never delivered. The first registration has a gap in front of
          // it, just as a reconnection does: `start` returns before it completes.
          wakeup("listening");
        },
        lost: (error) => {
          log.warn(
            { err: error },
            "the Signal notification connection dropped; reconnecting, and the sweep covers the gap",
          );
        },
      });

      // Deliberately not unref'd. The worker is what keeps a Gateway alive. A process whose only
      // job is to run Signals must not exit on an empty queue.
      ticker = setInterval(() => wakeup("sweep"), sweepIntervalMs);
      wakeup("start");
    },

    async stop() {
      stopping = true;
      if (ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
      // Both sources of wakeups are gone before the wait, so nothing new starts
      // while it is going on.
      if (listening !== undefined) {
        await listening.close();
        listening = undefined;
      }
      await working;
    },
  };
}

/**
 * The Prompt a Handler wrote, with its request for a fresh Session answered.
 *
 * `session: null` is a question, and this is the one place in the framework that answers it. A
 * fresh Session is named `run_<runId>`, so its transcript can be traced back to the Run.
 *
 * Here rather than in each Runtime, because the Worker owns the Run row. It has the id before the
 * row is written, so the name goes into `runs.session` in the same statement.
 */
function promptForRun(runId: string, prompt: Prompt): RunPrompt {
  return { ...prompt, session: prompt.session ?? `run_${runId}` };
}

/** What goes in an `error` column: the message alone. The stack goes to the log. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
