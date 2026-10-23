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
    /** Present only while a runtime call is active, on requests to the agent server. */
    concordeRun: CurrentRun | undefined;
  }
}

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

  /** Waits for the active signal, including its runs and post phase. Pending signals remain queued. */
  stop(): Promise<void>;
};

export const signalChannel = "concorde_signals_signal";

const defaultSweepIntervalMs = 5_000;

const strandedSignal =
  "the worker stopped while this Signal was processing, and it is failed rather than re-run after the restart: its Runs may already have sent Messages, written the Workspace, or called something outside";
const strandedRun = "the worker stopped before this Run finished; Runs are never re-run";

type WakeupReason = "start" | "notification" | "listening" | "sweep";

type QueuedRun = {
  readonly id: string;
  readonly prompt: RunPrompt;
  readonly context: unknown;
};

/**
 * Run only one worker per database. Startup fails interrupted signals and their unfinished runs
 * rather than replaying them. Pending signals are processed in emission order.
 * `createGateway` constructs this component for you.
 */
export function createSignalWorker(options: SignalWorkerOptions): SignalWorker {
  const log = options.logger ?? defaultLogger();
  const runtime = options.runtime;
  const handlers = options.handlers;
  const sweepIntervalMs = options.sweepIntervalMs ?? defaultSweepIntervalMs;

  const handle = options.db.handle(signalsTables);

  let current: CurrentRun | undefined;

  const decorateRun: onRequestHookHandler = (request, _reply, done) => {
    request.concordeRun = current;
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

  async function executeRuns(
    signal: Signal,
    prompts: readonly Prompt[],
  ): Promise<string | undefined> {
    if (prompts.length === 0) {
      return undefined;
    }

    const queued: QueuedRun[] = prompts.map((prompt) => {
      const id = randomUUID();
      return { id, prompt: promptForRun(id, prompt), context: prompt.context ?? null };
    });
    await handle.insert(runs).values(
      queued.map(({ id, prompt, context }) => ({
        id,
        signalId: signal.id,
        session: prompt.session,
        prompt: prompt.text,
        context,
      })),
    );

    const failures: string[] = [];
    for (const run of queued) {
      const outcome = await executeRun(signal, run);
      if (!outcome.ok) failures.push(outcome.error);
    }

    if (failures.length === 0) return undefined;
    const first = failures[0] ?? "";
    return failures.length === 1
      ? `the Run failed: ${first}`
      : `${failures.length} of ${queued.length} Runs failed, the first with: ${first}`;
  }

  async function executeRun(signal: Signal, run: QueuedRun): Promise<RunOutcome> {
    const { id: runId, prompt, context } = run;
    log.info({ runId, signalId: signal.id, session: prompt.session }, "Run started");
    await handle
      .update(runs)
      .set({ state: "running", startedAt: sql`clock_timestamp()` })
      .where(eq(runs.id, runId));

    current = { id: runId, signalId: signal.id, session: prompt.session, context };
    let outcome: RunOutcome;
    try {
      outcome = await runtime.run(prompt);
    } catch (error) {
      outcome = { ok: false, error: describe(error) };
    } finally {
      current = undefined;
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
        "Signal was left processing by a stopped worker: failed, and not re-run after the restart",
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
        log.error({ err: error }, "the Signal worker stopped short, and retries when next woken");
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
        throw new Error("emitting a Signal inserted no row");
      }

      await tx.execute(sql`select pg_notify(${signalChannel}, '')`);
      return inserted.id;
    },

    async start() {
      if (started) {
        throw new Error(
          "worker.start has already been called. One Signal Worker drains one queue, because Runs are serial across the whole Gateway; construct a second Signal Worker if a second queue is really what you want.",
        );
      }
      started = true;

      listening = options.db.listen(signalChannel, {
        notified: () => wakeup("notification"),
        connected: () => {
          log.debug({ channel: signalChannel }, "listening for Signal notifications");
          wakeup("listening");
        },
        lost: (error) => {
          log.warn(
            { err: error },
            "the Signal notification connection dropped; reconnecting, and the sweep covers the gap",
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
    },
  };
}

function promptForRun(runId: string, prompt: Prompt): RunPrompt {
  return { session: prompt.session ?? `run_${runId}`, text: prompt.text };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
