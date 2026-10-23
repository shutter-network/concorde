import { integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const decisionsSchema = pgSchema("concorde_decisions");

export const decisions = decisionsSchema.table("decisions", {
  seq: integer("seq").primaryKey().generatedByDefaultAsIdentity(),
  statement: text("statement").notNull(),
  jws: text("jws").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const decisionsTables = { decisions };
