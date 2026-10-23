import { type SQL, sql } from "drizzle-orm";
import {
  check,
  integer,
  type PgColumn,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "../../users/schema/index.ts";

export const messengerSchema = pgSchema("concorde_messenger");

export const messageDirections = ["inbound", "outbound"] as const;

export type MessageDirection = (typeof messageDirections)[number];

function directionIsKnown(column: PgColumn, directions: readonly string[]): SQL {
  const literals = directions.map((direction) => `'${direction}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

export const messages = messengerSchema.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    direction: text("direction").$type<MessageDirection>().notNull(),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check("messages_direction_known", directionIsKnown(table.direction, messageDirections)),
    unique("messages_user_id_seq_unique").on(table.userId, table.seq),
  ],
);

export const messengerTables = { messages };
