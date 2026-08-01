/**
 * The Core: the Signal queue, Signal Handler dispatch, and Run execution.
 *
 * It holds no identity and knows nothing about messaging (ADR-0020). What it does
 * hold is the one worker, and the worker is **serial globally** — one Run at a
 * time regardless of Session, which is the only reason a Workspace shared by every
 * Signal Handler and the agent is safe to have at all (ADR-0012).
 *
 * Wakeup here is a plain interval. Ticket 04 replaces it with a PostgreSQL
 * `NOTIFY` issued inside the emitting transaction, and keeps an interval alongside
 * as the slow sweep; nothing outside this file needs to change when it does.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { defaultLogger, type Logger } from "../logging.ts";
import type { Db, Store } from "../store/index.ts";
import { assertSessionName, type Prompt, type Signal, type SignalHandlers } from "./handlers.ts";
import type { RunOutcome, RuntimeAdapter } from "./runtime.ts";
import { runs, signals } from "./schema.ts";

/** What a Producer hands to `core.emit`. */
export type EmittedSignal = {
  /** Selects exactly one Signal Handler. A `kind` with no Handler fails the Signal. */
  readonly kind: string;
  /**
   * Arbitrary JSON, taken as fact. Whatever a Producer writes here the Core
   * believes, including any claim about who the Signal came from — which is
   * precisely why Producers are parts of the Gateway rather than peers outside it
   * (ADR-0020).
   */
  readonly payload: unknown;
};

export type CoreOptions = {
  readonly store: Store;
  /** Drives the Agent Runtime. One Run at a time; never called concurrently. */
  readonly runtime: RuntimeAdapter;
  /** Defaults to a `pino` instance on stdout. */
  readonly logger?: Logger;
  /**
   * How often the worker looks for pending Signals, in milliseconds.
   *
   * The only wakeup mechanism in this slice, so it is also the worst-case latency
   * of a Signal. Ticket 04 makes the emitting transaction wake the worker directly
   * and demotes this to the sweep that covers a lost notification.
   */
  readonly wakeupIntervalMs?: number;
};

export type Core = {
  /**
   * Records a Signal as `pending` and returns its id.
   *
   * Takes the caller's transaction rather than finding one (ADR-0023), so a
   * Producer that records something and tells the agent about it cannot have the
   * two come apart: the Messenger writes the inbound Message and emits in one
   * transaction, and a rollback loses both. Ambient enlistment is not available —
   * a transaction started on one handle takes its own connection from the pool, so
   * a second handle's writes survive its rollback with nothing reported.
   *
   * The schema parameter is widened rather than named, because the transaction
   * carries the schema of the handle it was started on and that handle belongs to
   * the caller.
   */
  emit<TSchema extends Record<string, unknown>>(
    tx: Db<TSchema>,
    signal: EmittedSignal,
  ): Promise<string>;

  /**
   * Starts the worker with the `kind`-to-Handler map.
   *
   * The map is a parameter and not a registration call, so a Core started with no
   * Handlers is unrepresentable — which matters because an unhandled Signal fails
   * permanently and is never retried (ADR-0017, ADR-0021). A Handler may close
   * over this Core: it is constructed, then Handlers are built against it, then it
   * is started with them (ADR-0024).
   */
  start(handlers: SignalHandlers): void;

  /**
   * Stops looking for Signals and waits for the one in flight to finish.
   *
   * Not a shutdown protocol — ordering is the Operator's and the framework ships
   * no signal handling (ADR-0021). There is no cancellation: a Run in flight runs
   * to completion, because abandoning it would leave partial effects that nothing
   * retries (ADR-0017).
   */
  stop(): Promise<void>;
};

/** The Core's worst-case Signal latency in this slice; see `wakeupIntervalMs`. */
const defaultWakeupIntervalMs = 200;

export function createCore(options: CoreOptions): Core {
  const log = options.logger ?? defaultLogger();
  const runtime = options.runtime;
  const wakeupIntervalMs = options.wakeupIntervalMs ?? defaultWakeupIntervalMs;

  // The Core's own handle, typed to the Core's own schema. `pg` never leaves the
  // Store (ADR-0022).
  const db = options.store.handle({ signals, runs });

  let handlers: SignalHandlers | undefined;
  let ticker: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;
  let stopping = false;

  /**
   * Takes the oldest pending Signal and marks it `processing`, or reports that
   * there is none.
   *
   * The update is guarded on the state it read, so two Gateways pointed at one
   * database cannot both claim a Signal — they would still break the serial
   * guarantee in every other respect, but not by running the same Signal twice.
   */
  async function claim(): Promise<typeof signals.$inferSelect | undefined> {
    while (!stopping) {
      const [next] = await db
        .select()
        .from(signals)
        .where(eq(signals.state, "pending"))
        .orderBy(asc(signals.emittedAt), asc(signals.id))
        .limit(1);
      if (next === undefined) return undefined;

      const [claimed] = await db
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
   * Draining rather than handling one Signal per wakeup is what makes a spurious
   * or duplicated wakeup harmless, and what keeps a burst from waiting on the
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

    const handler = handlers?.[signal.kind];
    if (handler === undefined) {
      // A typo in a `kind` is visible rather than silent, and permanent: there is
      // no Handler to run a post phase on, and nothing re-runs it (ADR-0017).
      const failure = `no Signal Handler is registered for kind ${JSON.stringify(signal.kind)}`;
      log.error({ signalId: signal.id, kind: signal.kind }, failure);
      await settle(signal, failure);
      return;
    }

    let prompts: readonly Prompt[] | undefined;
    let failure: string | undefined;
    try {
      prompts = await handler.handle(signal);
      // Every Session name is checked before any Run exists, so an invalid one
      // fails where the Handler wrote it rather than partway through a Run.
      for (const prompt of prompts) assertSessionName(prompt);
    } catch (error) {
      // A Handler is the Operator's own code and may do anything, including
      // throw. It fails its own Signal and nothing else: the worker carries on,
      // and the post phase still runs.
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
   * Executes one Run per Prompt, in the order the Handler returned them, and
   * reports why the Signal failed if any of them did.
   *
   * Every Prompt runs even after one fails. A Handler that fanned out to three
   * Sessions asked for three Runs, and the post phase is told that one failed —
   * that, and nothing more, is the framework's failure handling (ADR-0017).
   */
  async function executeRuns(
    signal: Signal,
    prompts: readonly Prompt[],
  ): Promise<string | undefined> {
    if (prompts.length === 0) {
      // Declining is not a special case: the Signal is `done` with no Runs, and
      // the arrival record survives, which is what makes a refusal auditable.
      return undefined;
    }

    // Ids are generated here rather than by the database so that each Run is
    // paired with the Prompt it came from without depending on the order a
    // multi-row insert returns.
    const queued = prompts.map((prompt) => ({ id: randomUUID(), prompt }));
    await db.insert(runs).values(
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

  async function executeRun(signal: Signal, runId: string, prompt: Prompt): Promise<RunOutcome> {
    log.info({ runId, signalId: signal.id, session: prompt.session }, "Run started");
    await db
      .update(runs)
      .set({ state: "running", startedAt: sql`clock_timestamp()` })
      .where(eq(runs.id, runId));

    let outcome: RunOutcome;
    try {
      outcome = await runtime.run(prompt, runId);
    } catch (error) {
      // An adapter that throws is a failed Run, not a dead worker.
      outcome = { ok: false, error: describe(error) };
    }

    await db
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
    await db
      .update(signals)
      .set({ state, error: failure ?? null })
      .where(eq(signals.id, signal.id));
    log.info({ signalId: signal.id, kind: signal.kind, state }, "Signal finished");
  }

  /**
   * Starts a drain unless one is already running, so overlapping wakeups cannot
   * produce a second worker and break the serial guarantee.
   */
  function wakeup(): void {
    if (draining !== undefined) return;
    draining = (async () => {
      try {
        await drain();
      } catch (error) {
        // Only the Store can get here: Handler and adapter failures are handled
        // per Signal. The Signal stays `processing` and ticket 04's restart
        // recovery resolves it; the worker tries again on the next wakeup rather
        // than dying quietly.
        log.error({ err: error }, "the Signal worker stopped draining");
      } finally {
        draining = undefined;
      }
    })();
  }

  return {
    async emit(tx, signal) {
      // The query-builder form, not the relational one: it generates SQL from the
      // table object and so works on a transaction carrying any part's schema,
      // which is what a cross-part write is handed (ADR-0023).
      const [inserted] = await tx
        .insert(signals)
        .values({ kind: signal.kind, payload: signal.payload })
        .returning({ id: signals.id });
      if (inserted === undefined) {
        throw new Error("emitting a Signal inserted no row");
      }
      return inserted.id;
    },

    start(registered) {
      if (handlers !== undefined) {
        throw new Error(
          "core.start has already been called. One Core runs one worker, because Runs are serial globally (ADR-0012); construct a second Core if a second queue is really what you want.",
        );
      }
      handlers = registered;
      // Deliberately not unref'd: the worker is what keeps a Gateway alive, and a
      // process whose only job is to run Signals should not exit because the queue
      // happens to be empty.
      ticker = setInterval(wakeup, wakeupIntervalMs);
      wakeup();
    },

    async stop() {
      stopping = true;
      if (ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
      await draining;
    },
  };
}

/** What goes in an `error` column: the message alone. The stack goes to the log. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
