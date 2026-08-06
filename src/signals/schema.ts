/**
 * The Signal Worker's tables: `signals` and `runs`, in the `saf_signals` schema.
 *
 * Public API, re-exported from `shared-agent-framework/signals`. An Operator barrels that subpath
 * into their own `schema.ts` and generates their DDL from it.
 *
 * An Operator's `drizzle-kit` reads this file through that barrel. Keep it to the tables and the
 * values that define them.
 */

import { type SQL, sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  type PgColumn,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The Signal Worker's schema, named for its subject rather than for the component.
 *
 * Prefixed because the framework is installed into a database it does not own. An unprefixed
 * `signals` is a plausible name for a schema an Operator already has. The name is not theirs to
 * change. The tables below are compiled against it, and their generation reads these same objects.
 */
export const workerSchema = pgSchema("saf_signals");

/**
 * A Signal's processing state. One-way: nothing returns to `pending`, and a failed Signal is
 * never re-run.
 */
export const signalStates = ["pending", "processing", "done", "failed"] as const;
/** How far a Signal got. One of `signalStates`. */
export type SignalState = (typeof signalStates)[number];

/** A Run's state. There is no `timed_out`, because there are no timeouts of any kind. */
export const runStates = ["pending", "running", "done", "failed"] as const;
/** How a Run ended, or that it has not. One of `runStates`. */
export type RunState = (typeof runStates)[number];

/**
 * The constraint that keeps a state column to the states above.
 *
 * Derived from the same array the type is, rather than spelled a second time in SQL. Otherwise a
 * state added to one and not the other gives a database that rejects a valid value. The values
 * go in with `sql.raw`, because a CHECK constraint is DDL and has nowhere to bind a parameter.
 */
function stateIsKnown(column: PgColumn, states: readonly string[]): SQL {
  const literals = states.map((state) => `'${state}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * An arrival record, written by a Producer. Immutable but for `state` and `error`.
 *
 * There is no `user_id`. The Signal Worker authenticates nobody, so attribution is not a fact it
 * holds. It travels in the payload, which the Worker takes as fact, because only a trusted
 * Producer can write one.
 */
export const signals = workerSchema.table(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Selects exactly one Signal Handler. An unhandled `kind` fails the Signal. */
    kind: text("kind").notNull(),
    /** Arbitrary JSON. The Signal Worker never interprets it. */
    payload: jsonb("payload").notNull(),
    /**
     * When the row was written. This is a queue, and this column is what orders it.
     *
     * `clock_timestamp()` rather than `now()`, which is the transaction's start time. Two Signals
     * emitted in one transaction would share that exactly, and their arrival order would come
     * down to the tiebreak.
     */
    emittedAt: timestamp("emitted_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    state: text("state").$type<SignalState>().notNull().default("pending"),
    /** Why it failed, in the Operator's words or the framework's. Null unless failed. */
    error: text("error"),
  },
  (table) => [
    check("signals_state_known", stateIsKnown(table.state, signalStates)),
    // The worker's claim query, run on every wakeup for the life of the process.
    index("signals_pending_idx").on(table.state, table.emittedAt),
  ],
);

/**
 * One Prompt executed in one Session.
 *
 * `session` is a plain name and not a foreign key. Sessions live in the Agent Implementation, and
 * the Signal Worker stores only the name it routed to.
 *
 * The Worker always writes it, a fresh Session included: it names that one `run_<the Run's id>`.
 * The column stays nullable all the same, because rows written before the Worker did that still
 * hold `null`.
 */
export const runs = workerSchema.table(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id),
    session: text("session"),
    /** The text delivered to the agent, as delivered. */
    prompt: text("prompt").notNull(),
    state: text("state").$type<RunState>().notNull().default("pending"),
    /** The Runtime's failure message. Null unless failed. */
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    check("runs_state_known", stateIsKnown(table.state, runStates)),
    // PostgreSQL indexes the primary key and not the referencing side, and every
    // read of a Signal's Runs goes this way.
    index("runs_signal_idx").on(table.signalId),
  ],
);

/**
 * Everything the Signal Worker keeps, as `db.handle` wants it.
 *
 * One object, so the worker and its Agent server routes ask for the same handle by the same name.
 */
export const workerTables = { signals, runs };
