/**
 * An Operator's `drizzle-kit` reads this file, through the barrel they build out of the component
 * subpaths ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md),
 * [ADR-0047](../../docs/adr/0047-a-component-is-one-subpath.md)). Keep it to the tables and the
 * values that define them, and import no other component's schema.
 *
 * Two other components import this one and point a foreign key at `users.id`: the Messenger's
 * `messages.user_id` (ADR-0036) and the Nostr Channel's `pubkeys.user_id` and `outbox.user_id`
 * ([ADR-0049](../../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)). A barrel
 * carrying either of those without this one generates a constraint onto a table it never creates.
 * `schemas.test.ts` pushes every part's schema together, which is what keeps the assembled set
 * honest.
 *
 * Nothing removes a User ([ADR-0029](../../docs/adr/0029-users-are-a-part-of-their-own.md)): no
 * delete route, no deactivation, and no column holding one. Do not add a `deactivated_at` for a
 * capability no deployment has asked for. It would put a state and two authentication branches
 * into the code.
 */

import { sql } from "drizzle-orm";
import { index, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The PostgreSQL schema every table below lives in, `saf_users`.
 *
 * Prefixed because the framework is installed into a database it does not own, and an unprefixed
 * `users` is a plausible name for a schema an Operator already has. Not configurable: the tables
 * are compiled against this object, and the same object is what a generation reads.
 */
export const usersSchema = pgSchema("saf_users");

/**
 * A User: an opaque Gateway-issued id, arbitrary Attributes, and a password that may not exist.
 *
 * Nothing removes a row. There is no delete, no deactivation and no column recording either, so a
 * reference to a User from another component's table cannot come to dangle.
 */
export const users = usersSchema.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Arbitrary JSON the deployment defines, and where grouping and therefore authorization live.
   *
   * `POST /users` has no parameter an attribute could arrive through, so this default is the only
   * thing that decides what a created User has. It is the empty object.
   */
  attributes: jsonb("attributes").notNull().default({}),
  /**
   * scrypt, with its cost parameters beside the digest, in the PHC-style string `secrets.ts`
   * writes and parses.
   *
   * Nullable, and permanently so. Null means this User cannot log in with a password. Trusted code
   * can still hand them a Token, which is the OIDC path rather than a half-created row.
   */
  passwordHash: text("password_hash"),
  /**
   * `clock_timestamp()` and not `now()`, which is the transaction's start time.
   *
   * Two Users created in one transaction would share `now()` exactly. The list route orders by
   * this column, so their order would come down to the uuid tiebreak.
   */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

/**
 * A bearer Token: one row per login, and the only credential a request ever carries.
 *
 * The plaintext exists once, in the response that issued it, so a row is verifiable and never
 * readable. Nothing reaps a row past its expiry. An expired Token stops matching.
 */
export const tokens = usersSchema.table(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The User this Token belongs to, a real foreign key inside this component's own schema.
     *
     * Both tables are in this module, so a barrel carrying one carries the other. The cascade is
     * carried for a delete that cannot happen: nothing removes a User, so the day one is added the
     * credentials go with them.
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
    tokenHash: text("token_hash").notNull().unique(),
    /** `clock_timestamp()` for the reason the User's is: it is the row's own time. */
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
    index("tokens_user_idx").on(table.userId),
  ],
);

export const usersTables = { users, tokens };
