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

export const signalsTables = { signals, runs };
