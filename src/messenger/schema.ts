/**
 * An Operator's `drizzle-kit` reads this file, by the path of the `./schema/index.ts` beside it
 * (ADR-0046, ADR-0055). Keep it to the table and the values that define it.
 *
 * The one import of another component's schema in here is deliberate and is the mechanism rather
 * than an accident: `user_id` references `saf_users.users.id`
 * ([ADR-0036](../../docs/adr/0036-the-http-messengers-user-id-is-a-foreign-key.md)), and one
 * generation graph is what makes that legal. Nothing of the Users component's is re-exported. What
 * costs an Operator is stated on the table below, where they can act on it.
 *
 * One table for both directions, whichever medium a Message travelled by, is the whole of
 * [ADR-0048](../../docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md): the log
 * is the Messenger's and no Channel's, and the HTTP Channel that used to own this table owns none.
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
 * The PostgreSQL schema the table below lives in, `saf_messenger`.
 *
 * Prefixed because the framework is installed into a database it does not own, and not an
 * Operator's to change: the table is compiled against this object, and the same object is what a
 * generation reads.
 *
 * It was `saf_http_messages` while one component held the log and the only way of reaching a
 * person, so a deployment upgrading across that split renames the schema.
 */
export const schema = pgSchema("saf_messenger");

/**
 * Which way a Message travelled: `inbound` from the User to the agent, `outbound` from the agent to
 * the User.
 *
 * Decided by which of the Messenger's two writes wrote it, a Channel's inbound `receive` or trusted
 * code's outbound `send`, so there is no field anywhere for a caller to set and only a User can
 * cause an inbound one.
 */
export const messageDirections = ["inbound", "outbound"] as const;

export type MessageDirection = (typeof messageDirections)[number];

// Derived from the same array the type is, rather than spelled a second time in SQL. Otherwise a
// direction added to one gives a database that rejects a valid value. The values go in with
// `sql.raw`, because a CHECK constraint is DDL and has nowhere to bind a parameter.
function directionIsKnown(column: PgColumn, directions: readonly string[]): SQL {
  const literals = directions.map((direction) => `'${direction}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * One Message, in one direction, belonging to exactly one User: the durable record of what was
 * said.
 *
 * One table for both directions, which is what makes a User's log a single numbered sequence, and
 * no column saying which Channel it travelled by. Nothing removes a row and no column is ever
 * updated, so it grows forever.
 *
 * `user_id` is a foreign key onto the `users` table of Users. A configuration listing this
 * component's `/schema` subpath without `shared-agent-framework/users/schema` generates a reference
 * to a table nothing creates, and dies on `schema "saf_users" does not exist`.
 */
export const messages = schema.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Exactly one User: the sender when inbound, the recipient when outbound. There are no groups
     * and no broadcast.
     *
     * The foreign key is the only enforcement that this names a real User, and there is no lookup
     * in front of the write: the agent's 404 is PostgreSQL's `23503` caught. No `onDelete`, because
     * nothing removes a User and no cascade can fire.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    direction: text("direction").$type<MessageDirection>().notNull(),
    /**
     * Per-User, monotonic from 1, and carried by both directions, so one cursored read serves a
     * client's poll and its rendering alike.
     *
     * No `serial` and no default. A sequence would be global, and another User's activity would
     * move this number. `messages.ts` computes it as `coalesce(max(seq), 0) + 1` for that User, and
     * the unique constraint below makes a lost race visible.
     */
    seq: integer("seq").notNull(),
    /**
     * The whole content, a plain string. No `jsonb` and no payload convention, because a fixed
     * shape is what makes a generic client possible.
     *
     * No length bound here or on the route. The server's own `bodyLimit` is the bound, and it is
     * the Operator's to raise.
     */
    text: text("text").notNull(),
    /**
     * `clock_timestamp()` and not `now()`, which is the transaction's start time.
     *
     * An inbound Message and an outbound answer written in one transaction would otherwise share it
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

export const tables = { messages };
