/**
 * The Messenger's one table: `messages`, in the `saf_messenger` schema.
 *
 * Public API, re-exported from `shared-agent-framework/messenger`. An Operator barrels that
 * subpath into their own `schema.ts` and generates their DDL from it. Keep this file to the table
 * and the values that define it.
 *
 * The log is the Messenger's and no Channel's, which is the whole of
 * [ADR-0048](../../docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md): one
 * table for one User across both directions, whichever medium a Message travelled by. The HTTP
 * Channel that used to own this table owns none.
 *
 * `user_id` is a foreign key onto `saf_users.users.id`, so this module imports the User Manager's
 * schema. It re-exports nothing of it. A barrel with this component and not the User Manager
 * generates a reference to a table nothing creates. Barrel `shared-agent-framework/users` beside
 * it. A Message is immutable once written, and nothing removes one, so the table grows forever.
 */

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
import { users } from "../users/schema.ts";

/**
 * The Messenger's schema, named for the component that owns the log.
 *
 * Prefixed because the framework is installed into a database it does not own. The name is not an
 * Operator's to change. The table below is compiled against it, and their generation reads that
 * same object.
 *
 * It was `saf_http_messages` while one component held the log *and* the only way of reaching a
 * person. A Channel is what reaches a person now, and it has no share of this schema: the medium
 * is gone from the name because it is gone from the ownership (ADR-0048).
 */
export const messengerSchema = pgSchema("saf_messenger");

/**
 * Which way a Message travelled: `inbound` or `outbound`.
 *
 * Decided by which of the Messenger's two writes wrote it — a Channel's inbound `receive` or
 * trusted code's outbound `send` — so there is no field anywhere for a caller to set.
 */
export const messageDirections = ["inbound", "outbound"] as const;
/** Which way one Message travelled. One of `messageDirections`. */
export type MessageDirection = (typeof messageDirections)[number];

/**
 * The constraint that keeps the column to the directions above.
 *
 * Derived from the same array the type is, rather than spelled a second time in SQL. Otherwise a
 * direction added to one gives a database that rejects a valid value. The values go in with
 * `sql.raw`, because a CHECK constraint is DDL and has nowhere to bind a parameter.
 */
function directionIsKnown(column: PgColumn, directions: readonly string[]): SQL {
  const literals = directions.map((direction) => `'${direction}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * One Message, in one direction, belonging to exactly one User.
 *
 * One table for both directions, which is what makes a User's log a single numbered sequence.
 */
export const messages = messengerSchema.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Exactly one User: the sender when inbound, the recipient when outbound.
     *
     * There are no groups and no broadcast. A foreign key onto `saf_users.users.id`, and the only
     * enforcement that this names a real User. The agent's 404 is PostgreSQL's `23503` caught,
     * with no lookup in front of it.
     *
     * No `onDelete`, because nothing removes a User and no cascade can fire.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    direction: text("direction").$type<MessageDirection>().notNull(),
    /**
     * Per-User, monotonic from 1, and carried by both directions.
     *
     * So one cursored read serves a client's poll and its rendering alike. There is no `serial` and
     * no default. A sequence would be global, and another User's activity would move this number.
     *
     * `messages.ts` computes it as `coalesce(max(seq), 0) + 1` for that User, and the unique
     * constraint below makes a lost race visible.
     */
    seq: integer("seq").notNull(),
    /**
     * The whole content, a plain string. There is no `jsonb` and no payload convention.
     *
     * A fixed shape is what makes a generic client possible. There is no length bound here or on
     * the route. The server's own `bodyLimit` is the bound, and it is the Operator's to raise.
     */
    text: text("text").notNull(),
    /**
     * `clock_timestamp()` and not `now()`, which is the transaction's start time.
     *
     * An inbound Message and an outbound answer written in one transaction would share that
     * exactly. `signals.emitted_at` uses it for the same reason.
     */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check("messages_direction_known", directionIsKnown(table.direction, messageDirections)),
    // The only index, and it does two jobs. It enforces the numbering, and every read uses it.
    // Every query this component makes is `where user_id = ? [and seq >/< ?] order by seq`. Do not
    // add another without a query that needs it.
    unique("messages_user_id_seq_unique").on(table.userId, table.seq),
  ],
);

/**
 * Everything the Messenger keeps, as `db.handle` wants it.
 *
 * One object, so every module of this component asks for the same handle by the same name.
 */
export const messengerTables = { messages };
