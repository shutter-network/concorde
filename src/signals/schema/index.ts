import { type SQL, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  type PgColumn,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const signalsSchema = pgSchema("concorde_signals");

export const signalStates = ["pending", "processing", "done", "failed"] as const;
export type SignalState = (typeof signalStates)[number];

export const runStates = ["pending", "running", "done", "failed"] as const;
export type RunState = (typeof runStates)[number];

function stateIsKnown(column: PgColumn, states: readonly string[]): SQL {
  const literals = states.map((state) => `'${state}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

export const signals = signalsSchema.table(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    emittedAt: timestamp("emitted_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    state: text("state").$type<SignalState>().notNull().default("pending"),
    error: text("error"),
  },
  (table) => [
    check("signals_state_known", stateIsKnown(table.state, signalStates)),
    index("signals_pending_idx").on(table.state, table.emittedAt),
  ],
);

export const runs = signalsSchema.table(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id),
    session: text("session"),
    prompt: text("prompt").notNull(),
    context: jsonb("context"),
    /** Not a foreign key: Signals does not depend on Users. */
    userId: text("user_id"),
    state: text("state").$type<RunState>().notNull().default("pending"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    check("runs_state_known", stateIsKnown(table.state, runStates)),
    index("runs_signal_idx").on(table.signalId),
  ],
);

/** One row per model call, saved when usage is reported and never updated. */
export const usage = signalsSchema.table(
  "usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    /** Copy the Run's `userId` so User totals can be calculated without joining the runs table. */
    userId: text("user_id"),
    provider: text("provider"),
    model: text("model"),
    input: integer("input").notNull(),
    output: integer("output").notNull(),
    cacheRead: integer("cache_read").notNull(),
    cacheWrite: integer("cache_write").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    cost: numeric("cost", { mode: "number" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index("usage_run_idx").on(table.runId),
    index("usage_user_idx").on(table.userId, table.recordedAt),
  ],
);

export const signalsTables = { signals, runs, usage };
