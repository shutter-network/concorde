import { sql } from "drizzle-orm";
import { index, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../../users/schema/index.ts";

export const nostrAuthSchema = pgSchema("concorde_nostr_auth");

export const grants = nostrAuthSchema.table(
  "grants",
  {
    pubkey: text("pubkey").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [index("nostr_auth_grants_user_idx").on(table.userId)],
);

export const admitted = nostrAuthSchema.table(
  "admitted",
  {
    eventId: text("event_id").primaryKey(),
    admittedAt: timestamp("admitted_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [index("nostr_auth_admitted_at_idx").on(table.admittedAt)],
);

export const nostrAuthTables = { grants, admitted };
