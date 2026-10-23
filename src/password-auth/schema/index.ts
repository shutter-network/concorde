import { sql } from "drizzle-orm";
import { index, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../../users/schema/index.ts";

export const passwordAuthSchema = pgSchema("concorde_password_auth");

export const passwords = passwordAuthSchema.table("passwords", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  passwordHash: text("password_hash").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

export const tokens = passwordAuthSchema.table(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique("password_auth_tokens_token_hash_unique"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("password_auth_tokens_user_idx").on(table.userId)],
);

export const passwordAuthTables = { passwords, tokens };
