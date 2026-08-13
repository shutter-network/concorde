/**
 * What `shared-agent-framework/signals` creates in a database: the `signals` and `runs` tables, and
 * the PostgreSQL schema they live in. Keep it to the tables and the values that define them, and
 * import no other component's schema: these two reference nobody, so this subpath can be listed on
 * its own.
 *
 * There is no `user_id` on either table and there must not be one. The Signal Worker authenticates
 * nobody, so who a Signal came from is not a fact it holds; it travels in the payload, written by a
 * trusted Producer (ADR-0020, superseding ADR-0019's column).
 *
 * Both state columns are one-way, and nothing ever returns to `pending`. A retry column, a
 * `timed_out` state and an attempt counter are all absent for one reason: a failed Run is never
 * re-run and nothing is ever timed out (ADR-0017).
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
 * The PostgreSQL schema both tables below live in, `saf_signals`, named for its subject rather than
 * for the Component.
 *
 * Prefixed because the framework is installed into a database it does not own, where a bare
 * `signals` is a plausible name for something an Operator already has. Not configurable: the tables
 * are compiled against this object, and the same object is what a generation reads.
 */
export const signalsSchema = pgSchema("saf_signals");

/**
 * A Signal's processing state. One-way: nothing returns to `pending`, and a failed Signal is never
 * re-run, so `error` is the whole of what became of it.
 */
export const signalStates = ["pending", "processing", "done", "failed"] as const;
export type SignalState = (typeof signalStates)[number];

/**
 * A Run's state. There is no `timed_out`, the framework imposing no timeout on a Run or on anything
 * else, so a Run that never ends stays `running` and holds the queue.
 */
export const runStates = ["pending", "running", "done", "failed"] as const;
export type RunState = (typeof runStates)[number];

/**
 * The constraint holding a state column to the states above.
 *
 * Derived from the same array the type is, rather than spelled a second time in SQL. Otherwise a
 * state added to one and not the other gives a database that rejects a value the code calls valid.
 * The literals go in with `sql.raw`, a CHECK constraint being DDL with nowhere to bind a parameter.
 */
function stateIsKnown(column: PgColumn, states: readonly string[]): SQL {
  const literals = states.map((state) => `'${state}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * An arrival record, written by a Producer and immutable but for `state` and `error`.
 *
 * Nothing deletes one. A Signal a Handler declined leaves a row behind exactly as a Signal that ran
 * does, which is what makes a refusal auditable afterwards.
 */
export const signals = signalsSchema.table(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Selects exactly one Signal Handler. A `kind` no Handler is registered for fails the Signal.
    kind: text("kind").notNull(),
    // Arbitrary JSON, never interpreted here. `jsonb` and not `text`, so an Operator can query into
    // it from outside; nothing in the framework does.
    payload: jsonb("payload").notNull(),
    /**
     * When the row was written, and the order the queue is drained in.
     *
     * `clock_timestamp()` and not `now()`, which is the transaction's start time. Two Signals
     * emitted in one transaction would carry that identical value, and their arrival order would
     * come down to the tiebreak on `id`.
     */
    emittedAt: timestamp("emitted_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    state: text("state").$type<SignalState>().notNull().default("pending"),
    // Why it failed, in the Operator's words or the framework's. Null unless failed.
    error: text("error"),
  },
  (table) => [
    check("signals_state_known", stateIsKnown(table.state, signalStates)),
    // The claim query's own index, run on every wakeup for the life of the process.
    index("signals_pending_idx").on(table.state, table.emittedAt),
  ],
);

/**
 * One Prompt executed in one Session, and the Worker's record of its own work.
 *
 * `session` is a plain name and not a foreign key. Sessions belong to the Agent Implementation, and
 * what is kept here is the name the Prompt was routed to. The Worker always writes one, a fresh
 * Session included, naming that one after the Run. The column stays nullable because rows written
 * before it did that still hold `null`.
 */
export const runs = signalsSchema.table(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id),
    session: text("session"),
    // The text delivered to the agent, as delivered. Not the template it came from.
    prompt: text("prompt").notNull(),
    state: text("state").$type<RunState>().notNull().default("pending"),
    // The Runtime's failure message, or the message it threw. Null unless failed.
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    check("runs_state_known", stateIsKnown(table.state, runStates)),
    // PostgreSQL indexes the primary key and not the referencing side, and every read of a Signal's
    // Runs goes this way.
    index("runs_signal_idx").on(table.signalId),
  ],
);

export const signalsTables = { signals, runs };
