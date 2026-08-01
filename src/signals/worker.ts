/**
 * The Signal Worker: the Signal queue, Signal Handler dispatch, and Run execution.
 *
 * It holds no identity and knows nothing about messaging (ADR-0020). What it does
 * hold is the one worker, and the worker is **serial globally** — one Run at a
 * time regardless of Session, which is the only reason a Workspace shared by every
 * Signal Handler and the agent is safe to have at all (ADR-0012).
 *
 * Three things wake it, and the difference between them is the whole of this file's
 * subtlety:
 *
 *  - **a notification**, sent by `emit` inside the caller's transaction. Because
 *    PostgreSQL notifications are transactional, the wakeup and the row becoming
 *    visible are one event: neither can happen without the other, and a Signal from
 *    a transaction that rolled back wakes nobody. Nudging the worker after commit
 *    was the alternative, and it puts that guarantee in every Producer's hands.
 *  - **the sweep**, an interval, because a notification sent while the listening
 *    connection is down is *gone* — PostgreSQL queues nothing for an absent
 *    listener. Without the sweep a dropped connection is a Signal stuck at
 *    `pending` with no error anywhere.
 *  - **the registration going in**, first time and after every reconnection, which
 *    is the same case caught early: a notification sent in the moment before the
 *    worker could hear it is lost exactly like one sent while it was disconnected.
 *
 * None of them says how much there is to do, so the worker **drains**: it runs until
 * the queue is empty. That is what makes a duplicated or spurious wakeup harmless
 * and a burst one wakeup rather than five.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Component } from "../components.ts";
import type { Db, Handle, Listening } from "../db/index.ts";
import { defaultLogger, type Logger } from "../logging.ts";
import type { Prompt, Signal, SignalHandlers } from "./handlers.ts";
import { signalsMigrations } from "./migrations.ts";
import { agentReadRoutes } from "./routes.ts";
import type { RunOutcome, RuntimeAdapter } from "./runtime.ts";
import { runs, signals, workerTables } from "./schema.ts";

/** What a Producer hands to `worker.emit`. */
export type EmittedSignal = {
  /** Selects exactly one Signal Handler. A `kind` with no Handler fails the Signal. */
  readonly kind: string;
  /**
   * Arbitrary JSON, taken as fact. Whatever a Producer writes here the Signal Worker
   * believes, including any claim about who the Signal came from — which is
   * precisely why Producers are parts of the Gateway rather than peers outside it
   * (ADR-0020).
   */
  readonly payload: unknown;
};

export type SignalWorkerOptions = {
  readonly db: Db;
  /** Drives the Agent Runtime. One Run at a time; never called concurrently. */
  readonly runtime: RuntimeAdapter;
  /**
   * The `kind`-to-Handler map: what this Gateway can act on, and the whole of it.
   *
   * A construction option rather than an argument to `start`, so a Signal Worker with
   * no Handlers is *unconstructable* rather than merely unstartable — which matters
   * because a Signal whose `kind` has no Handler fails permanently and is never
   * retried (ADR-0017, ADR-0021).
   *
   * A plain map and not a callback handed the Worker, and that is the one thing this
   * shape costs: a Handler can no longer close over the Signal Worker it runs under
   * (ADR-0024). Nothing in this repository did. A Handler that emits is a `let` in the
   * entry point assigned after construction, which is where ADR-0024 already puts
   * Handler construction.
   */
  readonly handlers: SignalHandlers;
  /**
   * The Agent server, if the agent is to read prior Signals and Runs.
   *
   * Given one, the constructor registers `agentRoutes` on the Fastify instance it
   * carries **at no prefix** — `/signals`, `/signals/:id`, `/runs`, `/runs/:id`, the
   * layout `example/AGENTS.md` already hard-codes into the agent's own instructions
   * (ADR-0032). Omitted, nothing is registered anywhere, and that omission is how the
   * group is switched off (ADR-0010).
   *
   * Structural, and asks for nothing but the Fastify instance: what satisfies it is
   * what `serverComponent` returns, and the `name`, `start` and `stop` beside it are
   * the Operator's list's business rather than ours. A server built with
   * `withTypeProvider` or with a logger of its own satisfies it too; one built on
   * http2 does not, and takes the plugin below instead.
   */
  readonly agentServer?: {
    readonly fastify: FastifyInstance;
  };
  /** Defaults to a `pino` instance on stdout. */
  readonly logger?: Logger;
  /**
   * How often the worker looks for pending Signals regardless of notifications, in
   * milliseconds.
   *
   * Deliberately not the latency of a Signal: emitting one wakes the worker
   * immediately, and this is the safety net for the notification that was sent while
   * the listening connection was down and so was never delivered. Lower it if a
   * Signal waiting this long during a database restart is unacceptable; there is no
   * correctness in the number.
   */
  readonly sweepIntervalMs?: number;
};

export type SignalWorker = Component & {
  /**
   * The Signal Worker's Agent server routes — reading prior Signals and Runs — as a
   * Fastify plugin, for an Operator who wants them somewhere other than where the
   * `agentServer` option puts them.
   *
   * Passing the server is the easy path and the plugin is the door out (ADR-0032):
   * hold it and you can register the routes under a prefix of your own, inside your
   * own encapsulated plugin, or behind a hook you share with your own routes — which
   * is Fastify's plugin system being the extension mechanism, and the reason ADR-0021
   * chose Fastify rather than inventing one. Passing no server and never registering
   * this is still how the group is switched off (ADR-0010).
   *
   * The routes are the Signal Worker's own: they read its tables, and no other part's.
   * The whole surface is read-only and deliberately **unscoped** — every Signal and
   * every Run, whatever Session the Run doing the reading is in (ADR-0011).
   */
  readonly agentRoutes: FastifyPluginAsync;

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
    tx: Handle<TSchema>,
    signal: EmittedSignal,
  ): Promise<string>;

  /**
   * Starts looking for Signals, with the Handlers this Worker was constructed with.
   *
   * Resolves immediately, and the first thing the worker goes on to do is **fail
   * whatever a previous worker left `processing`** (ADR-0017). Nothing an Operator
   * does next depends on that finishing: a Signal emitted in the meantime is a row in
   * a queue, and it is drained once recovery is done. It resolves rather than returns
   * only because a Component's `start` is asynchronous (ADR-0031).
   */
  start(): Promise<void>;

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

/**
 * The channel the Signal Worker notifies and listens on.
 *
 * Prefixed for the same reason the schema is: notification channels are per
 * database, and the framework is installed into one it does not own. Not
 * overridable — a Signal Worker notifying a channel a different one listens on is a
 * Gateway that looks healthy and never runs a Signal until the sweep, and there is
 * nothing an Operator gains by choosing the name. Exported for the tests, which send
 * spurious notifications on it, and not from the package.
 */
export const signalChannel = "saf_signals_signal";

/** How long a Signal can sit unnoticed if its notification was lost. */
const defaultSweepIntervalMs = 5_000;

/** What a Signal and its Runs are failed with when a previous worker left them behind. */
const strandedSignal =
  "the worker stopped while this Signal was processing, and it is failed rather than re-run after the restart: its Runs may already have sent Messages, written the Workspace, or called something outside (ADR-0017)";
const strandedRun = "the worker stopped before this Run finished; Runs are never re-run (ADR-0017)";

/**
 * Why the worker woke, for the debug line — and for the tests that pin them.
 *
 * `listening` covers the first registration and every reconnection alike: both mean
 * the worker can now be notified and could not a moment ago.
 */
type WakeupReason = "start" | "notification" | "listening" | "sweep";

export function createSignalWorker(options: SignalWorkerOptions): SignalWorker {
  const log = options.logger ?? defaultLogger();
  const runtime = options.runtime;
  const handlers = options.handlers;
  const sweepIntervalMs = options.sweepIntervalMs ?? defaultSweepIntervalMs;

  // The Signal Worker's own handle, typed to its own schema. `pg` never leaves the
  // Db (ADR-0022).
  const handle = options.db.handle(workerTables);

  // The two acts of wiring, both of them here so that an Operator's entry point does
  // neither (ADR-0032). Registering the descriptor is bookkeeping the Db does nothing
  // with until `migrate` or `start`, and it is the identical descriptor
  // `example/migrate.ts` registers, which is one registration and not two.
  options.db.registerMigrations(signalsMigrations);
  const agentRoutes = agentReadRoutes(handle);
  // At no prefix, and not awaited: Fastify defers a plugin until the server is ready,
  // so this is a registration made at construction and loaded at `listen` — which is
  // also why a server that is already listening refuses one.
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
   * Takes the oldest pending Signal and marks it `processing`, or reports that
   * there is none.
   *
   * The update is guarded on the state it read, so two Gateways pointed at one
   * database cannot both claim a Signal — they would still break the serial
   * guarantee in every other respect, but not by running the same Signal twice.
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

    const handler = handlers[signal.kind];
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

  async function executeRun(signal: Signal, runId: string, prompt: Prompt): Promise<RunOutcome> {
    log.info({ runId, signalId: signal.id, session: prompt.session }, "Run started");
    await handle
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
   * Fails every Signal a previous worker left `processing`, and resolves the Runs
   * under them.
   *
   * They are **not re-run** (ADR-0017): a Run may already have sent Messages, written
   * the Workspace, or called something outside, and its Prompt is already in the
   * Session on disk. Replaying it duplicates all of that. The Runs are failed too,
   * including ones that were only recorded — a Run row saying `running` with nothing
   * running is a lie an Operator has no way to see through.
   *
   * This is why it must finish before anything is claimed: a drain alongside it would
   * mark its own Signal `processing` and have recovery fail it underneath. It also
   * assumes it is the only worker on this database, which ADR-0012 already requires —
   * two Gateways sharing a queue break the serial guarantee before they get here.
   *
   * A crash is not the only way in. So is a Db error inside a drain, which is
   * exactly the case that convinced us this cannot be startup-only forever; for now
   * the next start resolves it, and the row says why.
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
   * A wakeup during a drain sets the flag rather than starting a second drain: two
   * would break the serial guarantee, and dropping it would lose the Signal that
   * committed just after the drain's last look at the queue — which is precisely the
   * Signal a notification exists to deliver promptly.
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
        // Only the Db can get here: Handler and adapter failures are handled per
        // Signal. Whatever was claimed stays `processing` for the next start to
        // resolve, `woken` is still set, and the worker tries again on the next
        // wakeup rather than dying quietly.
        log.error({ err: error }, "the Signal worker stopped short, and retries when next woken");
      } finally {
        working = undefined;
      }
    })();
  }

  return {
    // Read only where a Component is named in an error, and there is one worker: a
    // second draining the same queue is what ADR-0012 rules out.
    name: "signal worker",

    agentRoutes,

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

      // The wakeup, in the caller's transaction with the row. PostgreSQL delivers a
      // notification at commit and not at all on rollback, so this cannot wake the
      // worker for a Signal that never existed, and cannot fail to wake it for one
      // that does — which is the guarantee a post-commit nudge cannot make, since
      // there is no post-commit hook and the Producer would have to remember.
      //
      // `pg_notify` and not `NOTIFY`, because a utility statement takes no bind
      // parameters. The payload is empty on purpose: the worker drains the whole
      // queue, so a notification means only "look again" and carries nothing worth
      // saying — and identical notifications sent in one transaction are collapsed by
      // PostgreSQL, so a Producer emitting a hundred Signals at once wakes the worker
      // once.
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

      // The connection carrying the notifications is the Db's to hold — a
      // `LISTEN` registration cannot live on a pooled connection, and `pg` does not
      // leave the Db to get one (ADR-0022).
      listening = options.db.listen(signalChannel, {
        notified: () => wakeup("notification"),
        connected: () => {
          log.debug({ channel: signalChannel }, "listening for Signal notifications");
          // Every registration is a reason to look, the first one included. Anything
          // sent before it was in place was never delivered — and the first
          // registration has a gap in front of it just as a reconnection does, because
          // `start` returns before it completes and a Producer may well emit in
          // between. Missing that is a Signal waiting a whole sweep on a Gateway that
          // has only just started, which is exactly when someone is watching.
          wakeup("listening");
        },
        lost: (error) => {
          log.warn(
            { err: error },
            "the Signal notification connection dropped; reconnecting, and the sweep covers the gap",
          );
        },
      });

      // Deliberately not unref'd: the worker is what keeps a Gateway alive, and a
      // process whose only job is to run Signals should not exit because the queue
      // happens to be empty.
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

/** What goes in an `error` column: the message alone. The stack goes to the log. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
