import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyPluginAsync, onRequestHookHandler } from "fastify";
import type { Db, Handle, Listening } from "../db/index.ts";
import type { Component } from "../gateway/components.ts";
import { defaultLogger, type Logger } from "../logging/logging.ts";
import type { Prompt, Signal, SignalHandlers } from "./handlers.ts";
import { agentReadRoutes } from "./routes.ts";
import type { RunOutcome, RunPrompt, Runtime } from "./runtime.ts";
import { runs, signals, signalsTables } from "./schema/index.ts";
import { createUsage } from "./usage.ts";

export type EmittedSignal = {
  readonly kind: string;
  readonly payload: unknown;
};

export type CurrentRun = {
  readonly id: string;
  readonly signalId: string;
  readonly session: string;
  readonly context: unknown;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Active Run identified by the `concorde-run-tag` header, or undefined. */
    concordeRun: CurrentRun | undefined;
  }
}

export const runTagHeader = "concorde-run-tag";

export type SignalWorkerOptions = {
  readonly db: Db;
  readonly runtime: Runtime;
  readonly handlers: SignalHandlers;
  readonly agentServer?: {
    readonly fastify: FastifyInstance;
  };
  readonly logger?: Logger;
  readonly sweepIntervalMs?: number;
};

export type SignalWorker = Component & {
  readonly agentRoutes: FastifyPluginAsync;

  /** Install at the server root when constructing an Agent server outside the Gateway. */
  readonly decorateRun: onRequestHookHandler;

  /**
   * Use a transaction to commit the signal with the change that caused it.
   * The worker is notified only after commit; rollback discards both the signal and notification.
   */
  emit<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    signal: EmittedSignal,
  ): Promise<string>;

  start(): Promise<void>;

  /** Drain claimed Signals, including queued Runs and post phases; leave pending Signals queued. */
  stop(): Promise<void>;
};

export const signalChannel = "concorde_signals_signal";

const defaultSweepIntervalMs = 5_000;

const strandedSignal =
  "Worker restart interrupted this signal. It was not retried because its runs may already have produced effects.";
const strandedRun = "Worker restart interrupted this run. Runs are not automatically retried.";
const tagAlreadyLive = "Run tag already live on another Run";

type WakeupReason = "start" | "notification" | "listening" | "sweep";

type QueuedRun = {
  readonly id: string;
  readonly signal: Signal;
  readonly prompt: RunPrompt;
  readonly context: unknown;
  readonly userId: string | null;

  readonly resources: ReadonlySet<string>;

  readonly tag: string | undefined;
  started: boolean;
  ended: boolean;
  /** Stay queued after ending, until the Signal's post phase has returned. */
  readonly heldThroughPost: boolean;
  readonly outcome: PromiseWithResolvers<RunOutcome>;
};

// A Run held through its Signal's post phase blocks a later Signal's Run until that phase
// returns, and never a Run of its own Signal, which the post phase is waiting for.
function blocks(earlier: QueuedRun, run: QueuedRun): boolean {
  if (earlier.ended && earlier.signal.id === run.signal.id) return false;
  return conflicts(earlier, run);
}

function conflicts(one: QueuedRun, other: QueuedRun): boolean {
  if (one.prompt.session === other.prompt.session) return true;
  for (const resource of one.resources) {
    if (other.resources.has(resource)) return true;
  }
  return false;
}

/** One worker per database. Claims and handles Signals in emission order.
 * A Run starts when no earlier unfinished Run shares its Session or a resource, counting a Run
 * as unfinished until its Signal's post phase returns, where the Handler has one.
 * Claiming pauses until every queued Run has started, bounding crash recovery to active Signals
 * plus one waiting Signal. Interrupted work fails on restart without replay.
 */
export function createSignalWorker(options: SignalWorkerOptions): SignalWorker {
  const log = options.logger ?? defaultLogger();
  const runtime = options.runtime;
  const handlers = options.handlers;
  const usage = createUsage({ db: options.db });
  const sweepIntervalMs = options.sweepIntervalMs ?? defaultSweepIntervalMs;

  const handle = options.db.handle(signalsTables);

  const queue: QueuedRun[] = [];

  const inFlight = new Map<string, CurrentRun>();

  const decorateRun: onRequestHookHandler = (request, _reply, done) => {
    const tag = request.headers[runTagHeader];
    request.concordeRun = typeof tag === "string" ? inFlight.get(tag) : undefined;
    done();
  };

  const agentRoutes = agentReadRoutes(handle);
  options.agentServer?.fastify.register(agentRoutes);
  options.agentServer?.fastify.addHook("onRequest", decorateRun);

  let started = false;
  let ticker: NodeJS.Timeout | undefined;
  let listening: Listening | undefined;
  let working: Promise<void> | undefined;
  let woken = false;
  let recovered = false;
  let stopping = false;

  let scheduling = false;
  let startWaiters: (() => void)[] = [];

  const finishing = new Set<Promise<void>>();

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

  async function drain(): Promise<void> {
    for (;;) {
      const claimed = await claim();
      if (claimed === undefined) return;
      await processSignal(claimed);

      await allStarted();
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
      const failure = `No signal handler registered for kind ${JSON.stringify(signal.kind)}`;
      log.error({ signalId: signal.id, kind: signal.kind }, failure);
      await settle(signal, failure);
      return;
    }

    let prompts: readonly Prompt[] | undefined;
    let failure: string | undefined;
    try {
      prompts = await handler.handle(signal);
    } catch (error) {
      prompts = undefined;
      failure = describe(error);
      log.error({ signalId: signal.id, kind: signal.kind, err: error }, "Signal handler failed");
    }

    const queuedRuns =
      prompts === undefined ? [] : await enqueue(signal, prompts, handler.post !== undefined);
    const finished: Promise<void> = finishSignal(signal, handler, queuedRuns, failure).finally(() =>
      finishing.delete(finished),
    );
    finishing.add(finished);
  }

  async function enqueue(
    signal: Signal,
    prompts: readonly Prompt[],
    heldThroughPost: boolean,
  ): Promise<QueuedRun[]> {
    if (prompts.length === 0) return [];

    const queuedRuns: QueuedRun[] = prompts.map((prompt) => {
      const id = randomUUID();
      return {
        id,
        signal,
        prompt: promptForRun(id, prompt),
        context: prompt.context ?? null,
        userId: prompt.userId ?? null,
        resources: new Set(prompt.resources ?? []),
        tag: prompt.tag,
        started: false,
        ended: false,
        heldThroughPost,
        outcome: Promise.withResolvers<RunOutcome>(),
      };
    });
    await handle.insert(runs).values(
      queuedRuns.map(({ id, prompt, context, userId }) => ({
        id,
        signalId: signal.id,
        session: prompt.session,
        prompt: prompt.text,
        context,
        userId,
      })),
    );

    queue.push(...queuedRuns);
    schedule();
    return queuedRuns;
  }

  async function finishSignal(
    signal: Signal,
    handler: SignalHandlers[string],
    queuedRuns: readonly QueuedRun[],
    handleFailure: string | undefined,
  ): Promise<void> {
    try {
      let failure = handleFailure;
      let limited = false;
      if (queuedRuns.length > 0) {
        ({ failure, limited } = await outcomesOf(queuedRuns));
      }

      if (handler.post !== undefined) {
        try {
          await handler.post(signal, { failed: failure !== undefined, limited });
        } catch (error) {
          log.error(
            { signalId: signal.id, kind: signal.kind, err: error },
            "Signal handler post phase failed",
          );
          const postFailure = `Post phase failed: ${describe(error)}`;
          failure = failure === undefined ? postFailure : `${failure}; ${postFailure}`;
        }
      }

      await settle(signal, failure);
    } catch (error) {
      log.error(
        { signalId: signal.id, kind: signal.kind, err: error },
        "Signal could not be finished; it stays processing until the next worker start",
      );
    } finally {
      for (const run of queuedRuns) dequeue(run);
      schedule();
    }
  }

  async function outcomesOf(
    queuedRuns: readonly QueuedRun[],
  ): Promise<{ failure: string | undefined; limited: boolean }> {
    const results = await Promise.allSettled(queuedRuns.map((run) => run.outcome.promise));

    const failures: string[] = [];
    let limited = false;
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      if (!result.value.ok) {
        failures.push(result.value.error);
        limited ||= result.value.limited === true;
      }
    }

    if (failures.length === 0) return { failure: undefined, limited };
    const first = failures[0] ?? "";
    const failure =
      failures.length === 1
        ? `Run failed: ${first}`
        : `${failures.length} of ${queuedRuns.length} runs failed. First error: ${first}`;
    return { failure, limited };
  }

  // Include waiting Runs so a later Run cannot overtake an earlier conflicting Run.
  function startable(): QueuedRun | undefined {
    for (const [index, run] of queue.entries()) {
      if (run.started) continue;
      if (queue.slice(0, index).some((earlier) => blocks(earlier, run))) continue;
      return run;
    }
    return undefined;
  }

  function schedule(): void {
    if (scheduling) return;
    scheduling = true;
    void (async () => {
      try {
        for (;;) {
          const next = startable();
          if (next === undefined) break;
          next.started = true;
          await startRun(next);
        }
      } catch (error) {
        log.error({ err: error }, "Scheduling scan failed; resumed when a Run is queued or ends");
      } finally {
        scheduling = false;
        if (!queue.some((run) => !run.started)) {
          const waiters = startWaiters;
          startWaiters = [];
          for (const wake of waiters) wake();
        }
      }
    })();
  }

  function allStarted(): Promise<void> {
    if (!queue.some((run) => !run.started)) return Promise.resolve();
    return new Promise((resolve) => startWaiters.push(resolve));
  }

  async function startRun(run: QueuedRun): Promise<void> {
    const { id: runId, signal, prompt } = run;
    log.info({ runId, signalId: signal.id, session: prompt.session }, "Run started");
    try {
      await handle
        .update(runs)
        .set({ state: "running", startedAt: sql`clock_timestamp()` })
        .where(eq(runs.id, runId));
    } catch (error) {
      endRun(run);
      run.outcome.reject(error);
      return;
    }

    void performRun(run).then(
      (outcome) => {
        endRun(run);
        run.outcome.resolve(outcome);
      },
      (error: unknown) => {
        endRun(run);
        run.outcome.reject(error);
      },
    );
  }

  function endRun(run: QueuedRun): void {
    run.ended = true;
    if (!run.heldThroughPost) dequeue(run);
    schedule();
  }

  function dequeue(run: QueuedRun): void {
    const index = queue.indexOf(run);
    if (index !== -1) queue.splice(index, 1);
  }

  async function performRun(run: QueuedRun): Promise<RunOutcome> {
    const { id: runId, signal, prompt, context, tag } = run;

    const current: CurrentRun = {
      id: runId,
      signalId: signal.id,
      session: prompt.session,
      context,
    };
    let outcome: RunOutcome;
    if (tag !== undefined && inFlight.has(tag)) {
      outcome = { ok: false, error: tagAlreadyLive, usage: [] };
    } else {
      if (tag !== undefined) inFlight.set(tag, current);
      try {
        outcome = await runtime.run(prompt);
      } catch (error) {
        outcome = { ok: false, error: describe(error), usage: [] };
      } finally {
        if (tag !== undefined) inFlight.delete(tag);
      }
    }

    try {
      await finishRun(runId, outcome, outcome.usage);
    } catch (error) {
      const unsaved = `Usage of ${outcome.usage.length} model calls was not saved: ${describe(error)}`;
      outcome = {
        ok: false,
        error: outcome.ok ? unsaved : `${outcome.error}. ${unsaved}`,
        usage: outcome.usage,
        ...(!outcome.ok && outcome.limited === true ? { limited: true } : {}),
      };
      await finishRun(runId, outcome, []);
    }

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

  // Usage and the Run's final state are saved together, so a Run's totals are never partial.
  async function finishRun(
    runId: string,
    outcome: RunOutcome,
    reports: RunOutcome["usage"],
  ): Promise<void> {
    await options.db.tx(async (tx) => {
      await usage.record(tx, runId, reports);
      await tx
        .update(runs)
        .set({
          state: outcome.ok ? "done" : "failed",
          error: outcome.ok ? null : outcome.error,
          endedAt: sql`clock_timestamp()`,
        })
        .where(eq(runs.id, runId));
    });
  }

  async function settle(signal: Signal, failure: string | undefined): Promise<void> {
    const state = failure === undefined ? "done" : "failed";
    await handle
      .update(signals)
      .set({ state, error: failure ?? null })
      .where(eq(signals.id, signal.id));
    log.info({ signalId: signal.id, kind: signal.kind, state }, "Signal finished");
  }

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
        "Interrupted signal marked failed after restart; not retried",
      );
    }
  }

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
        log.error({ err: error }, "Signal worker drain failed; retrying on the next wakeup");
      } finally {
        working = undefined;
      }
    })();
  }

  return {
    agentRoutes,
    decorateRun,

    async emit(tx, signal) {
      const [inserted] = await tx
        .insert(signals)
        .values({ kind: signal.kind, payload: signal.payload })
        .returning({ id: signals.id });
      if (inserted === undefined) {
        throw new Error("Signal insert returned no row");
      }

      await tx.execute(sql`select pg_notify(${signalChannel}, '')`);
      return inserted.id;
    },

    async start() {
      if (started) {
        throw new Error(
          "worker.start has already been called. Run one signal worker per database.",
        );
      }
      started = true;

      listening = options.db.listen(signalChannel, {
        notified: () => wakeup("notification"),
        connected: () => {
          log.debug({ channel: signalChannel }, "Listening for signal notifications");
          wakeup("listening");
        },
        lost: (error) => {
          log.warn(
            { err: error },
            "Signal notification connection lost; reconnecting. Periodic polling covers the gap.",
          );
        },
      });

      ticker = setInterval(() => wakeup("sweep"), sweepIntervalMs);
      wakeup("start");
    },

    async stop() {
      stopping = true;
      if (ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
      if (listening !== undefined) {
        await listening.close();
        listening = undefined;
      }
      await working;

      await Promise.all(finishing);
    },
  };
}

function promptForRun(runId: string, prompt: Prompt): RunPrompt {
  const session = prompt.session ?? `run_${runId}`;
  return prompt.usageLimit === undefined
    ? { session, text: prompt.text }
    : { session, text: prompt.text, usageLimit: prompt.usageLimit };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
