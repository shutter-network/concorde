/**
 * Serial globally, and that is load-bearing rather than a simplification: one Run at a time,
 * whatever Session it is in, is what makes a Workspace shared by every Signal Handler and the agent
 * safe to have (ADR-0012). Per-Session parallelism was weighed and lost, and reopening it means
 * scoping the Workspace per Session first. `pi`'s own session store has no locking either, so two
 * live writers on one Session would clobber each other in silence.
 *
 * Three things wake the worker: the notification `emit` sends inside the caller's transaction, the
 * sweep interval, and the `LISTEN` registration going in on the first connection and after each
 * reconnection. None of them says how much there is to do, so the worker drains until the queue is
 * empty. That is what makes a duplicated or spurious wakeup harmless and a burst one wakeup, and it
 * is why the notification carries no payload for anybody to act on.
 *
 * `recover` has to finish before anything is claimed. A drain running alongside it would mark its
 * own Signal `processing` and have recovery fail it underneath. What recovery must never do is
 * re-run: a Run may already have sent Messages, written the Workspace and called something outside,
 * and its Prompt is already appended to the Session on disk (ADR-0017).
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Db, Handle, Listening } from "../db/index.ts";
import type { Component } from "../gateway/components.ts";
import { defaultLogger, type Logger } from "../logging/logging.ts";
import type { Prompt, Signal, SignalHandlers } from "./handlers.ts";
import { agentReadRoutes } from "./routes.ts";
import type { RunOutcome, RunPrompt, Runtime } from "./runtime.ts";
import { runs, signals, signalsTables } from "./schema/index.ts";

/** What a Producer hands to {@link SignalWorker}'s `emit`. */
export type EmittedSignal = {
  /**
   * Selects exactly one Signal Handler, and is the whole of what dispatch looks at.
   *
   * One `kind` never reaches two Handlers. Fanning out is one Handler answering with several
   * Prompts, so there is no second mechanism for it here.
   */
  readonly kind: string;
  /**
   * Arbitrary JSON, taken as fact and never interpreted.
   *
   * The Signal Worker believes whatever a Producer writes, including any claim about who the Signal
   * came from. That is why a Producer is a part of the Gateway rather than a peer outside it, and
   * why attribution is a term in a Producer's payload contract rather than a column here.
   */
  readonly payload: unknown;
};

export type SignalWorkerOptions = {
  readonly db: Db;
  /**
   * What a Prompt is handed to. `createPiRuntime`, on `shared-agent-framework/pi`, builds the one
   * this framework ships.
   */
  readonly runtime: Runtime;
  /**
   * The `kind`-to-Handler map: what this Gateway can act on, and the whole of it.
   *
   * A construction option rather than an argument to `start`, so a Signal Worker with no Handlers
   * is unconstructable rather than merely unstartable.
   *
   * Held rather than copied. The Worker looks a `kind` up in this same object at dispatch, so an
   * entry written into it before `start` is dispatched on, and that is the way out of the knot a
   * Handler that emits back into this Worker ties: it cannot close over an object that does not
   * exist yet, so it is built after construction and assigned in.
   */
  readonly handlers: SignalHandlers;
  /**
   * The Agent server, if the agent is to read prior Signals and Runs.
   *
   * Given one, the constructor registers `agentRoutes` on its Fastify instance at no prefix:
   * `/signals`, `/signals/:id`, `/runs` and `/runs/:id`. Omit it and nothing is registered
   * anywhere, which is how the group is switched off.
   *
   * Structural: anything carrying a Fastify instance satisfies it. A server built on http2 does
   * not, and takes the `agentRoutes` plugin instead.
   */
  readonly agentServer?: {
    readonly fastify: FastifyInstance;
  };
  /**
   * Defaults to a `pino` instance on stdout.
   *
   * One info line as each Signal is claimed and as it finishes, one as each Run starts and ends
   * carrying the Session it ran in, and a debug line for every wakeup saying what caused it. A
   * Signal Handler's failure and a Run's are logged at error whether or not anything else notices
   * them, and a Signal a stopped worker left behind at warn. No Prompt text and no payload is ever
   * written.
   */
  readonly logger?: Logger;
  /**
   * How often the worker looks for pending Signals regardless of notifications, in milliseconds.
   * Defaults to 5000.
   *
   * Not the latency of a Signal: emitting one wakes the worker at once. This is the safety net for
   * a notification sent while the listening connection was down, so what the number bounds is how
   * long a Signal can sit unnoticed after a database restart. There is no correctness in it, and
   * the cost of lowering it is a query per interval forever.
   */
  readonly sweepIntervalMs?: number;
};

/**
 * The Signal queue as a Component: something for a Producer to emit into, a Run loop, and a read of
 * both that the agent reaches over HTTP.
 *
 * A Signal is a durable row with a processing state rather than an event, so the queue survives the
 * process and a Gateway that stops mid-queue starts again with the pending ones still in it.
 * Nothing in flight survives. A Signal left `processing` by a stopped worker is failed at the next
 * `start` and never re-run, because its Runs may already have sent Messages, written the Workspace
 * or called something outside, and its Prompt is already in the Session on disk. Its Runs are
 * failed with it, a `running` row with nothing running being a lie.
 *
 * It holds no identity and knows nothing about messaging. No method takes a User, and nothing here
 * is scoped by one.
 *
 * There is nothing that cancels, retries, reprioritises or removes a Signal, and no way to ask
 * whether the queue is empty. A failed Signal is failed for good, and doing the work after all
 * means emitting another.
 */
export type SignalWorker = Component & {
  /**
   * The Agent server routes, as a Fastify plugin to register yourself.
   *
   * Register it under a prefix of your own, or inside your own encapsulated plugin, or behind a
   * hook you share with your own routes. Passing no server and never registering this is how the
   * group is switched off.
   *
   * The routes read these two tables and no other component's, and the whole surface is read-only
   * and unscoped: every Signal and every Run, whatever Session the reading Run is in.
   */
  readonly agentRoutes: FastifyPluginAsync;

  /**
   * Records a Signal as pending, wakes the worker when the caller's transaction commits, and
   * answers with the new Signal's id.
   *
   * It takes that transaction rather than opening one, so recording something and telling the agent
   * about it cannot come apart: a rollback loses both, and no wakeup is sent for a Signal that never
   * existed. The transaction may carry any component's schema, this write naming its own table.
   *
   * It waits for nothing beyond the insert. The Signal is queued, not run, and the id is for
   * reading the outcome back later rather than for awaiting it.
   */
  emit<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    signal: EmittedSignal,
  ): Promise<string>;

  /**
   * Starts looking for Signals, with the Handlers this Worker was constructed with.
   *
   * It resolves immediately, and the first thing the worker does after that is fail whatever a
   * previous worker left `processing`. Nothing an Operator does next waits on that: a Signal
   * emitted meanwhile is a row in a queue, drained once the recovery is done.
   *
   * @throws If it has already been called. One Signal Worker drains one queue, Runs being serial
   *   across the whole Gateway.
   */
  start(): Promise<void>;

  /**
   * Stops looking for Signals and waits for the Run in flight to finish.
   *
   * Not a shutdown protocol: the framework installs no `SIGTERM` handling of its own. There is no
   * cancellation either. The Run in flight runs to completion, because abandoning it would leave
   * partial effects nothing retries, so this takes as long as the slowest Run the agent can have
   * started.
   *
   * Whatever is still pending stays pending, for the next worker over this database to drain.
   */
  stop(): Promise<void>;
};

/**
 * The channel the worker notifies and listens on. Prefixed for the reason the schema is:
 * notification channels are per database, and this is installed into one it does not own.
 *
 * Not an option. A worker notifying a channel a different one listens on looks healthy and runs
 * nothing until the sweep.
 */
export const signalChannel = "saf_signals_signal";

/** How long a Signal can sit unnoticed if its notification was lost. */
const defaultSweepIntervalMs = 5_000;

/**
 * What a Signal and its Runs are failed with when a previous worker left them behind.
 *
 * Written for whoever finds the row, so it says what will not happen next as well as what happened.
 * The word "restart" is what `worker.test.ts` matches on.
 */
const strandedSignal =
  "the worker stopped while this Signal was processing, and it is failed rather than re-run after the restart: its Runs may already have sent Messages, written the Workspace, or called something outside";
const strandedRun = "the worker stopped before this Run finished; Runs are never re-run";

/**
 * Why the worker woke, for the debug line.
 *
 * `listening` covers the first registration and every reconnection. Both mean the worker can now
 * be notified, and a moment ago it was not.
 */
type WakeupReason = "start" | "notification" | "listening" | "sweep";

/**
 * Builds a Signal Worker over a Db, a Runtime and a map of Signal Handlers, and registers the read
 * routes on the Agent server if one was passed.
 *
 * `createGateway` builds a Worker already. Reach for this only when assembling a Gateway by hand
 * with `createBareGateway`.
 */
export function createSignalWorker(options: SignalWorkerOptions): SignalWorker {
  const log = options.logger ?? defaultLogger();
  const runtime = options.runtime;
  const handlers = options.handlers;
  const sweepIntervalMs = options.sweepIntervalMs ?? defaultSweepIntervalMs;

  // The Signal Worker's own handle, typed to its own schema. `pg` never leaves the Db.
  const handle = options.db.handle(signalsTables);

  // The one act of wiring, here so that an Operator's entry point does not do it.
  const agentRoutes = agentReadRoutes(handle);
  // At no prefix, and not awaited. Fastify defers a plugin until the server is ready. So this is
  // a registration made at construction and loaded at `listen`. That is also why a server which
  // is already listening refuses one.
  options.agentServer?.fastify.register(agentRoutes);

  let started = false;
  let ticker: NodeJS.Timeout | undefined;
  let listening: Listening | undefined;
  // The drain in progress, while there is one. Never two, or the queue is not serial.
  let working: Promise<void> | undefined;
  // Something asked for a look. Only the drain that acts on it clears it, never the wakeup.
  let woken = false;
  let recovered = false;
  let stopping = false;

  /**
   * Takes the oldest pending Signal and marks it `processing`, or reports that there is none.
   *
   * The update repeats the state it read in its `where`, so two Gateways over one database cannot
   * both claim a Signal. They would break the serial guarantee in every other respect, so this buys
   * consistency of the row and nothing about the design.
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
   * Runs every pending Signal in arrival order and returns once none is left.
   *
   * Emptying the queue rather than taking one Signal per wakeup is what makes a spurious wakeup
   * cost nothing, and it keeps a burst of Signals off the sweep interval.
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
   * Executes one Run per Prompt, in the order the Handler answered with, and reports why the Signal
   * failed if any of them did.
   *
   * A failure stops nothing. A Handler that fanned out over three Sessions asked for three Runs,
   * and the two after the failure are still wanted.
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

  /** The Signal's last state write, and the only one after it was claimed. */
  async function settle(signal: Signal, failure: string | undefined): Promise<void> {
    const state = failure === undefined ? "done" : "failed";
    await handle
      .update(signals)
      .set({ state, error: failure ?? null })
      .where(eq(signals.id, signal.id));
    log.info({ signalId: signal.id, kind: signal.kind, state }, "Signal finished");
  }

  /**
   * Fails every Signal a previous worker left `processing`, and settles the Runs beneath them.
   *
   * Nothing is re-run, for the reason in the file header. The Runs go with the Signal, the ones
   * only recorded included: a row saying `running` with nothing running is a lie, and it is the row
   * an Operator reads while looking for what is stuck.
   *
   * It runs before the first claim, and the flag makes it once per process rather than once per
   * wakeup. A Signal a drain abandoned to a Db error is left `processing` too, so this is what
   * resolves that as well, at the next start.
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
   * A wakeup arriving during a drain raises the flag and starts nothing: a second drain would break
   * the serial guarantee, and ignoring the wakeup would strand a Signal that committed just after
   * the drain's last look. So the loop below re-reads the flag before it settles.
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
          "worker.start has already been called. One Signal Worker drains one queue, because Runs are serial across the whole Gateway; construct a second Signal Worker if a second queue is really what you want.",
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
 * `session: null` is a question, and this is the only place in the framework that answers it. The
 * answer is `run_<the Run's id>`, so a transcript on disk traces back to the Run that wrote it.
 *
 * Here and not in each Runtime, because the Worker owns the Run row and already holds the id before
 * the row is written. The name therefore reaches `runs.session` in the same statement, and a second
 * Agent Implementation inherits the convention instead of inventing one.
 */
function promptForRun(runId: string, prompt: Prompt): RunPrompt {
  return { ...prompt, session: prompt.session ?? `run_${runId}` };
}

/** What an `error` column holds: the message alone. The stack belongs in the log. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
