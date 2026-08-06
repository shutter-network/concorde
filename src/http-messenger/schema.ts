/**
 * The HTTP Messenger's one table, in the part's own PostgreSQL schema
 * ([`data-model.md`](../../docs/data-model.md)).
 *
 * **Public API, on `shared-agent-framework/http-messenger/schema` and nowhere else**, for
 * the reason the User Manager's schema is: an Operator barrels this module into their own
 * `schema.ts` and generates from it
 * ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md)). That reverses
 * ADR-0021/0022's "deliberately absent from the `/http-messenger` subpath" — the part's own
 * subpath still carries none of it. What the subpath does **not** carry is the User
 * Manager's tables: the import below is a value used to declare a reference, not a
 * re-export, so `users` and `tokens` are absent from this module's export surface and an
 * Operator who barrels only this part gets a `messages` that references a table nothing in
 * their graph creates. Barrel `shared-agent-framework/users/schema` beside it.
 *
 * `drizzle-kit` reads this file to generate the DDL, so keep it to the table and the
 * values it is defined in terms of. Two consequences of that reading follow:
 *
 *  - **`user_id` carries its `references`**, and so this file imports
 *    `../users/schema.ts`. ADR-0036 had to forbid that import: a per-part config points at
 *    one schema file, `drizzle-kit` follows imports, and it would emit `CREATE TABLE
 *    saf_users.users` into *this* part's folder — so the constraint was added to the
 *    generated migration by hand instead, on every regeneration.
 *    [ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md) removes that reason:
 *    a deployment barrels the parts it runs into one schema graph and generates once, so
 *    there is no other part's folder to bleed into, and the import that had to be
 *    forbidden is exactly the import that makes the constraint free. What ADR-0036 decided
 *    is untouched — the constraint is still the only enforcement, and the agent's 404 is
 *    still PostgreSQL's `23503` caught. Only where it is declared moved. A deployment
 *    running the HTTP Messenger must barrel the User Manager's schema too, or generation
 *    references a table it does not create.
 *  - **The `check` helper below is a copy** of `src/signals/schema.ts`'s and not an
 *    import of it. That, too, was for the reason above, and it is left a copy here only
 *    because sharing it is a separate change from declaring the foreign key.
 *
 * A Message is **immutable** once written — no column is ever updated — and nothing
 * removes one: no delete, no TTL, no sweeper and nothing to configure, so the table grows
 * forever exactly as `tokens` does (ADR-0035).
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
 * The HTTP Messenger's schema, prefixed for the reason the other two are: the framework
 * is installed into a database it does not own, and this name is not an Operator's to
 * change — the table below is compiled against it, and an Operator's generation reads that
 * same object, so renaming it is a migration in somebody else's database.
 *
 * It carries the **part** and not only its subject, against the rule the other two
 * follow. What that rule protects against is a part rename becoming a migration, and
 * "HTTP" is the durable half of this part's name: a second messaging Producer is a peer
 * with a schema of its own rather than a rename of this one (ADR-0034).
 */
export const httpMessagesSchema = pgSchema("saf_http_messages");

/**
 * Which way a Message travelled. Decided by which server the request arrived on, so
 * there is no field anywhere for a caller to set and nothing to get wrong.
 */
export const messageDirections = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof messageDirections)[number];

/**
 * The constraint that keeps the column to the directions above.
 *
 * Derived from the same array the type is, rather than spelled a second time in SQL: a
 * direction added to one and not the other gives a database that rejects a value the code
 * believes in. The values go in with `sql.raw` because a CHECK constraint is DDL — a bind
 * parameter has nowhere to be bound — and they are our own literals, from a list a few
 * lines up.
 */
function directionIsKnown(column: PgColumn, directions: readonly string[]): SQL {
  const literals = directions.map((direction) => `'${direction}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

/**
 * One Message, in one direction, belonging to exactly one User.
 *
 * One entity and one table for both directions, which is what makes a User's log a single
 * numbered sequence and the Outbox unnecessary rather than merely unbuilt (ADR-0035).
 */
export const messages = httpMessagesSchema.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Exactly one User — the sender when inbound, the recipient when outbound. No
     * groups and no broadcast (ADR-0008).
     *
     * **A foreign key onto `saf_users.users.id`**, declared here rather than hand-added
     * to a generated migration (ADR-0036, ADR-0046), and the only enforcement that this
     * names a real User: the agent's 404 is PostgreSQL's `23503` caught, with no lookup
     * in front of it. No `onDelete`: it never fires a cascade, because nothing removes a
     * User (ADR-0029), so there is no behaviour worth choosing.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    direction: text("direction").$type<MessageDirection>().notNull(),
    /**
     * Per-User, monotonic from 1, and carried by **both** directions, which is what lets
     * one cursored read serve a client's poll and its rendering alike (ADR-0035).
     *
     * There is no `serial` and no default: a sequence would be global, and invariant 2 of
     * the data model says no counter a User can see may be moved by another User's
     * activity. `messages.ts` computes it as `coalesce(max(seq), 0) + 1` for that User
     * and the unique constraint below is what makes a lost race visible.
     */
    seq: integer("seq").notNull(),
    /**
     * The whole content, a plain string. No `jsonb`, no payload convention and no
     * registry: fixing the shape is what creates the generic client ADR-0007 correctly
     * observed did not exist (ADR-0034).
     *
     * No length bound here or on the route: the server's own `bodyLimit` is already the
     * bound and it is the Operator's to raise on the server they constructed.
     */
    text: text("text").notNull(),
    /**
     * `clock_timestamp()` and not `now()`, which is the transaction's start time: an
     * inbound Message and the outbound answer written in one transaction would share it
     * exactly, for the reason `signals.emitted_at` uses it.
     */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check("messages_direction_known", directionIsKnown(table.direction, messageDirections)),
    // The only index, and it does two jobs: it enforces the numbering, and it is the
    // index every read uses, since every query this part will ever make is
    // `where user_id = ? [and seq >/< ?] order by seq`. Do not add another without a
    // query that needs it.
    unique("messages_user_id_seq_unique").on(table.userId, table.seq),
  ],
);

/**
 * Everything the HTTP Messenger keeps, as `db.handle` wants it: one object, so every
 * module of this part asks for the same handle by the same name.
 */
export const httpMessagesTables = { messages };
