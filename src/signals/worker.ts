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
    /**
     * The Run the request is attributed to, on requests to the agent server: the in-flight Run
     * whose `Prompt.tag` the `concorde-run-tag` header names, carrying the Run id, its Signal
     * id, its Session and its Context. `undefined` when the header is absent, names no in-flight
     * Run's tag, or names the tag of a Run that has ended, however many Runs are in flight.
     */
    concordeRun: CurrentRun | undefined;
  }
}

/**
 * The request header an agent sends a Run tag in. Fixed here so that agent instructions and
 * agent server hooks agree without choosing a name.
 */
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

  /**
   * The onRequest hook that sets `request.concordeRun`: the in-flight Run whose `Prompt.tag` the
   * `concorde-run-tag` header names, or `undefined`. Installed on the agent server handed to the
   * constructor; exported so a server the worker was not handed installs it at its own root.
   * There is no fallback to the only Run in flight, because a heuristic kept beside an exact
   * mechanism is what gets relied on by accident.
   */
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

  /**
   * Waits for every claimed signal, including runs that had not yet started and every post
   * phase. Pending signals remain queued.
   */
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
  /**
   * What the Run must have to itself besides its Session; see `conflicts`. Empty until a Prompt
   * names some. The Session is never in it, so a Handler's name can never collide with a
   * Session's.
   */
  readonly resources: ReadonlySet<string>;
  /** The Run tag the Handler wrote, if any; held in `inFlight` while the Run is. */
  readonly tag: string | undefined;
  started: boolean;
  readonly outcome: PromiseWithResolvers<RunOutcome>;
};

/**
 * The one scheduling rule: two Runs conflict when they name the same Session or share a
 * Resource, and nothing else conflicts. Symmetric; which of the two is earlier in the queue is
 * the caller's to know.
 */
function conflicts(one: QueuedRun, other: QueuedRun): boolean {
  if (one.prompt.session === other.prompt.session) return true;
  for (const resource of one.resources) {
    if (other.resources.has(resource)) return true;
  }
  return false;
}

/**
 * Run only one worker per database. Startup fails interrupted signals and their unfinished runs
 * rather than replaying them. `createGateway` constructs this component for you.
 *
 * Signals are claimed one at a time, oldest first, and each Handler's `handle` is awaited before
 * the next claim, so a Handler sees Signals in emission order. Runs are queued in the order their
 * Signals were claimed and their Prompts returned, and a queued Run starts as soon as no earlier
 * unfinished Run, running or still waiting, names its Session or shares a Resource with it. Runs
 * for different Sessions therefore overlap, while Runs in one Session keep their order. The next
 * Signal is claimed only once every queued Run has started, so a crash strands the Signals whose
 * Runs are in flight plus one, never the backlog. A Signal's post phase runs once all of its Runs
 * have ended, and Signals settle in whatever order their Runs finish.
 *
 * `stop` ends claiming, lets every queued Run start as the Runs before it end and run to its
 * outcome, runs every post phase and settles every claimed Signal before it returns. Pending
 * Signals remain queued.
 */
export function createSignalWorker(options: SignalWorkerOptions): SignalWorker {
  const log = options.logger ?? defaultLogger();
  const runtime = options.runtime;
  const handlers = options.handlers;
  const usage = createUsage({ db: options.db });
  const sweepIntervalMs = options.sweepIntervalMs ?? defaultSweepIntervalMs;

  const handle = options.db.handle(signalsTables);

  // Every unfinished Run, in the order its Signal was claimed and its Prompt returned. A Run
  // starts when nothing before it in this list, started or not, `conflicts` with it, so a Run
  // never overtakes an earlier one it conflicts with.
  const queue: QueuedRun[] = [];

  // Every Run in flight that has a tag, by that tag. Added when the Run starts and removed when
  // it ends, whichever way it ends, so a held tag is a live one. Never overwritten: a Run whose
  // tag is already held fails before it starts, so an entry is only ever its own Run's.
  const inFlight = new Map<string, CurrentRun>();

  // A request is attributed by its header and by nothing else: no header, an unknown tag or a
  // dead one all resolve to nothing, even while exactly one Run is in flight. Node joins a
  // repeated custom header into one comma-separated string, which is no Run's tag, so it names
  // nothing too; the array branch is there because the header typing still allows one.
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
  // One per claimed Signal whose Runs, post phase or settlement are still to come.
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
      // The lookahead is one Signal: the next is claimed only once every queued Run has started.
      await allStarted();
    }
  }

  // Claims through `handle` and the queueing of the Runs; the rest of the Signal is detached so
  // that the next claim does not wait for this Signal's Runs to end.
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

    const queuedRuns = prompts === undefined ? [] : await enqueue(signal, prompts);
    const finished: Promise<void> = finishSignal(signal, handler, queuedRuns, failure).finally(() =>
      finishing.delete(finished),
    );
    finishing.add(finished);
  }

  async function enqueue(signal: Signal, prompts: readonly Prompt[]): Promise<QueuedRun[]> {
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

  // Never rejects: a Signal it cannot settle stays processing, which the next start recovers.
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
    }
  }

  // Waits for every Run of the Signal to end, whichever ends first, before judging the Signal.
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

  function startable(): QueuedRun | undefined {
    for (const [index, run] of queue.entries()) {
      if (run.started) continue;
      if (queue.slice(0, index).some((earlier) => conflicts(earlier, run))) continue;
      return run;
    }
    return undefined;
  }

  // Rescans the queue from its head and starts every Run it may, one at a time, so "Run started"
  // and the runs table's startedAt keep queue order; only the Runtime calls overlap. Called when
  // Runs are queued and whenever one ends, and harmless while a scan is already under way,
  // because that scan starts over after each Run it starts.
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
        // Nothing below throws by design, and a throw must not leave `allStarted` waiting.
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
    const index = queue.indexOf(run);
    // A Run ends once; an index of -1 would splice the last Run of the queue away in silence.
    if (index !== -1) queue.splice(index, 1);
    schedule();
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
      // Two Prompts minting one tag fail loudly: setting the entry anyway would attribute the
      // first Run's requests to this one for as long as both were in flight.
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
      // Nothing is claimed after `working` ends, so this is every Signal there will be.
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
