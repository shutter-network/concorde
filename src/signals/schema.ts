/**
 * The Signal Worker's tables: `signals` and `runs`, in its own PostgreSQL schema
 * ([`data-model.md`](../../docs/data-model.md)).
 *
 * Not public API. Every part of the Gateway owns a schema and no part reads
 * another's tables, so these objects are exported for this part's own modules and
 * are deliberately absent from the package's root export — an Operator who wants
 * tables gets them through `db.handle(theirOwnSchema)`, the same call the
 * framework's parts use (ADR-0021, ADR-0022).
 *
 * `drizzle-kit` reads this file to generate `migrations/signals`, so keep it to the
 * tables and the values they are defined in terms of. The descriptor that ships
 * those migrations lives in `migrations.ts` for that reason.
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
 * The Signal Worker's schema. Named for its subject rather than for the component
 * that owns it, matching `saf_users`: component names have proven the less stable of
 * the two, this part having been the Core until recently, and a schema rename is the
 * one rename with a database in it.
 *
 * Prefixed because the framework is installed into a database it does not own: an
 * unprefixed `signals` is a plausible name for a schema an Operator already has, and
 * this name is not theirs to change — the tables below are compiled against it, so a
 * descriptor naming a different schema would migrate one place and read another.
 */
export const workerSchema = pgSchema("saf_signals");

/**
 * A Signal's processing state. One-way: nothing returns to `pending`, and a
 * failed Signal is never re-run (ADR-0017).
 */
export const signalStates = ["pending", "processing", "done", "failed"] as const;
export type SignalState = (typeof signalStates)[number];

/**
 * A Run's state. There is no `timed_out`, because there are no timeouts of any
 * kind (ADR-0017), and adding one later would mean a migration and a lie about
 * every Run recorded before it.
 */
export const runStates = ["pending", "running", "done", "failed"] as const;
export type RunState = (typeof runStates)[number];

/**
 * The constraint that keeps a state column to the states above.
 *
 * Derived from the same array the type is, rather than spelled a second time in
 * SQL: a state added to one and not the other gives a database that rejects a
 * value the code believes in, and the first Signal to use it fails for a reason
 * nothing explains. The values go in with `sql.raw` because a CHECK constraint is
 * DDL — a bind parameter has nowhere to be bound — and they are our own literals,
 * from a list a few lines up.
 */
function stateIsKnown(column: PgColumn, states: readonly string[]): SQL {
  const literals = states.map((state) => `'${state}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * An arrival record, written by a Producer. Immutable but for `state` and
 * `error`.
 *
 * There is deliberately **no `user_id`**: the Signal Worker authenticates nobody, so
 * attribution is not a fact it holds. It travels in the payload, which the Worker
 * takes as fact because only a trusted Producer can write one (ADR-0020,
 * superseding ADR-0019).
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
     * `clock_timestamp()` rather than `now()`, which is the transaction's start
     * time: two Signals emitted in one transaction would share it exactly and
     * their arrival order would come down to the tiebreak. This is a queue, and
     * the column it is ordered by should be the time the row was written.
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
 * `session` is a plain name and **not** a foreign key — Sessions live in the Agent
 * Implementation, and the Signal Worker stores only the name it routed to (ADR-0016).
 * It is nullable because a Prompt may request a fresh Session by naming none: the
 * Runtime generates a name for it, and the contract carries nothing back (a Runtime
 * returns an outcome, not output), so the Worker has nothing to record there.
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
 * Everything the Signal Worker keeps, as `db.handle` wants it: one object, so the
 * worker and the Agent server routes ask for the same handle by the same name
 * rather than each assembling its own from the tables above.
 */
export const workerTables = { signals, runs };
