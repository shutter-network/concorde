import { sql } from "drizzle-orm";
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../../users/schema/index.ts";

export const nostrChannelSchema = pgSchema("concorde_nostr_channel");

export const pubkeys = nostrChannelSchema.table("pubkeys", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  pubkey: text("pubkey").notNull().unique("pubkeys_pubkey_unique"),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

export const received = nostrChannelSchema.table("received", {
  eventId: text("event_id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

export const outbox = nostrChannelSchema.table("outbox", {
  eventId: text("event_id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  messageId: uuid("message_id").notNull(),
  wrap: text("wrap").notNull(),
  reason: text("reason"),
  queuedAt: timestamp("queued_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
  failedAt: timestamp("failed_at", { withTimezone: true }),
});

export const nostrChannelTables = { pubkeys, received, outbox };
