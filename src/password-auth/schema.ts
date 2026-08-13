/**
 * An Operator's `drizzle-kit` reads this file, by the path of the `./schema/index.ts` beside it
 * ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md),
 * [ADR-0055](../../docs/adr/0055-a-components-tables-are-a-subpath-of-their-own.md)). Keep it to
 * the tables and the values that define them.
 *
 * The import of the schema of Users is what lets both columns below reference
 * `saf_users.users.id`, and it re-exports nothing of it. That is the third such import in the
 * framework, after the Messenger's and the Nostr Channel's, and it costs the same thing: a
 * configuration listing this component's `/schema` subpath without that one generates a reference
 * to a table nothing creates.
 *
 * **A password is a row rather than a column now**
 * ([ADR-0052](../../docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)).
 * `saf_users.users.password_hash` is nullable because a User authenticated some other way need
 * never have one; here the absence is the absence of the row, so `password_hash` is `NOT NULL` and
 * nothing has to decide what a null one means. Do not make it nullable to mirror the column this
 * replaces.
 *
 * Both index names carry the component's name where the Users component's carry the table's, and
 * that is deliberate rather than untidy. The two token tables coexist through the expand half of
 * this move, and a push that put `tokens_user_idx` into two schemas of one database is a question
 * about PostgreSQL nobody should have to answer while reading a diff.
 */

import { sql } from "drizzle-orm";
import { index, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../users/schema.ts";

/**
 * The PostgreSQL schema both tables below live in, `saf_password_auth`.
 *
 * Prefixed because the framework is installed into a database it does not own, and not
 * configurable: the tables are compiled against this object, and the same object is what a
 * generation reads.
 */
export const passwordAuthSchema = pgSchema("saf_password_auth");

/**
 * One row per User who can log in with a password, and no row for a User who cannot.
 *
 * The primary key is the User, so a User holds one password. Nothing here records who set it: an
 * Operator replacing a forgotten password and a User rotating their own write the same row.
 */
export const passwords = passwordAuthSchema.table("passwords", {
  /**
   * The User this password belongs to, and the primary key.
   *
   * A foreign key onto `saf_users.users.id`. No `onDelete`, because nothing removes a User and no
   * cascade can fire.
   */
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  /**
   * scrypt, with its cost parameters beside the digest, in the PHC-style string `secrets.ts`
   * writes and parses.
   *
   * Not nullable. A User with no password has no row here, so there is no second spelling of
   * "cannot log in with a password" for a query to get wrong.
   */
  passwordHash: text("password_hash").notNull(),
  /**
   * When this row was last written, which is the only history a password has.
   *
   * `clock_timestamp()` and not `now()`, which is the transaction's start time.
   */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

/**
 * A bearer Token: one row per login, and the credential every request of this scheme carries.
 *
 * The plaintext exists once, in the response that issued it, so a row is verifiable and never
 * readable. Nothing reaps a row past its expiry. An expired Token stops matching.
 */
export const tokens = passwordAuthSchema.table(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The User this Token belongs to, a foreign key onto `saf_users.users.id`.
     *
     * The cascade is carried for a delete that cannot happen: nothing removes a User, so the day
     * one is added the credentials go with them.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * A single-pass SHA-256 of the 32 random bytes the holder carries, with no salt.
     *
     * The input already carries full entropy, so nothing stretches it. Unique, so verification is
     * a lookup by this column and the index does the comparison.
     */
    tokenHash: text("token_hash").notNull().unique("password_auth_tokens_token_hash_unique"),
    /** `clock_timestamp()` for the reason the password's is: it is the row's own time. */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /**
     * When the Token stops working. Not nullable, so "never expires" is unrepresentable.
     *
     * Written from the component's construction-time lifetime against the database's clock, which
     * is the clock the comparison that refuses an expired Token reads too.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // Revoking every Token of one User reads exactly this way. PostgreSQL indexes the primary
    // key and the unique constraint, not the referencing side.
    index("password_auth_tokens_user_idx").on(table.userId),
  ],
);

export const passwordAuthTables = { passwords, tokens };
