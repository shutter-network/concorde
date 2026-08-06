/**
 * The User Manager's tables: `users` and `tokens`, in the `saf_users` schema.
 *
 * Public API, re-exported from `shared-agent-framework/users`. An Operator barrels that subpath
 * into their own `schema.ts` and generates their DDL from it.
 *
 * An Operator's `drizzle-kit` reads this file through that barrel. Keep it to the tables and the
 * values that define them. No component reads another's tables, and an Operator who wants tables
 * of their own gets them through `db.handle(theirOwnSchema)`.
 */

import { sql } from "drizzle-orm";
import { index, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The User Manager's schema, named for its subject rather than for the component.
 *
 * Prefixed because the framework is installed into a database it does not own. An unprefixed
 * `users` is a plausible name for a schema an Operator already has. The name is not theirs to
 * change: the tables below are compiled against it, and their generation reads these objects.
 */
export const usersSchema = pgSchema("saf_users");

/**
 * A User: an opaque Gateway-issued id, arbitrary Attributes, and a credential that may not exist.
 *
 * There is no `deactivated_at` and no delete, because nothing removes a User. There is no read
 * position either, here or in the HTTP Messenger. A client's cursor is the largest `seq` it holds.
 */
export const users = usersSchema.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Arbitrary JSON, defined by the deployment, and where authorization lives.
   *
   * The Manager stores Attributes and interprets none of them. `POST /users` passes none,
   * because it has no such parameter. So this default decides what a created User has, and it
   * is the empty object.
   */
  attributes: jsonb("attributes").notNull().default({}),
  /**
   * scrypt, with its cost parameters beside the digest, in the PHC-style string `secrets.ts`
   * writes and parses.
   *
   * Nullable, and permanently so. Null means this User cannot log in with a password. Trusted
   * code can still hand them a Token, which is the OIDC path rather than a half-created row.
   */
  passwordHash: text("password_hash"),
  /**
   * `clock_timestamp()` and not `now()`, which is the transaction's start time.
   *
   * Two Users created in one transaction would share that exactly. The list route orders by
   * this column, so their order would come down to the uuid tiebreak.
   */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

/**
 * A bearer Token: one row per login, and the only credential that travels on a request.
 *
 * Nothing here is readable, only verifiable. The plaintext exists once, in the response that
 * issued it.
 */
export const tokens = usersSchema.table(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The User this Token belongs to, a real foreign key within this component's own schema.
     *
     * Both tables are in this module, so any barrel that carries one carries the other.
     * `on delete cascade` is carried for a delete that cannot happen yet. Nothing removes a
     * User, so the day one is added the credentials go with them.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * A plain single-pass SHA-256 of the 32 random bytes the holder carries, with no salt.
     *
     * The input already carries full entropy, so nothing stretches it. Unique, so verification
     * is a lookup by this column and the index does the comparison.
     */
    tokenHash: text("token_hash").notNull().unique(),
    /** `clock_timestamp()` for the reason the User's is: it is the row's own time. */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /**
     * When the Token stops working. Not nullable, so "never expires" is unrepresentable.
     *
     * Written from the Manager's construction-time lifetime, against the database's clock. The
     * comparison that refuses an expired Token reads the same clock. Nothing reaps a row past
     * this time.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // Revoking every Token of one User reads exactly this way. PostgreSQL indexes the primary
    // key and the unique constraint, not the referencing side.
    index("tokens_user_idx").on(table.userId),
  ],
);

/**
 * Everything the User Manager keeps, as `db.handle` wants it.
 *
 * One object, so every module of this component asks for the same handle by the same name.
 */
export const usersTables = { users, tokens };
