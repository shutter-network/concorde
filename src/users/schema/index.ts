import { sql } from "drizzle-orm";
import { jsonb, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

export const usersSchema = pgSchema("concorde_users");

export const users = usersSchema.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  attributes: jsonb("attributes").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

export const usersTables = { users };
