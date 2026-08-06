/**
 * The User Manager's tables, in the part's own PostgreSQL schema
 * ([`data-model.md`](../../docs/data-model.md)).
 *
 * **Public API, on `shared-agent-framework/users/schema` and nowhere else.** An Operator
 * barrels this module into their own `schema.ts` and generates from it, which is what the
 * subpath is for
 * ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md)); it reverses
 * ADR-0021/0022's "deliberately absent from the `/users` subpath", and the separate door is
 * the point — `/users` is still the part's API and these objects are still not on it. The
 * discipline the old privacy enforced stands as a discipline: no part reads another's
 * tables, and an Operator who wants tables of their own gets them through
 * `db.handle(theirOwnSchema)`, the same call the framework's parts use.
 *
 * An Operator's `drizzle-kit` reads this file, through their barrel and their own
 * `drizzle.config.ts`, so keep it to the tables and the values they are
 * defined in terms of.
 */

import { sql } from "drizzle-orm";
import { index, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The User Manager's schema. Prefixed for the reason the Signal Worker's is: the framework
 * is installed into a database it does not own, an unprefixed `users` is a schema an
 * Operator plausibly already has, and this name is not theirs to change — the table
 * below is compiled against it, and an Operator's generation reads that same object, so
 * renaming it is a migration in somebody else's database.
 */
export const usersSchema = pgSchema("saf_users");

/**
 * A User: an opaque Gateway-issued id, arbitrary Attributes, and a credential that
 * may not exist.
 *
 * There is deliberately **no `deactivated_at`** and no delete — nothing removes a
 * User (ADR-0029) — and **no read position of any kind**, here or in the HTTP
 * Messenger: a client's cursor is the largest `seq` it holds, so there is nothing to
 * store (ADR-0035).
 */
export const users = usersSchema.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Arbitrary JSON, deployment-defined, and where grouping and therefore
   * authorization live, since there is no Party (ADR-0008, ADR-0014). The Manager
   * stores them and interprets none of them.
   *
   * The default is what makes the agent's route safe by construction rather than by
   * a check: `POST /users` passes no attributes because it has no such parameter, so
   * the column's own default is the only thing that can decide what a created User
   * has, and it is the empty object.
   */
  attributes: jsonb("attributes").notNull().default({}),
  /**
   * scrypt, with its cost parameters stored alongside the digest, in the PHC-style
   * string `secrets.ts` writes and parses.
   *
   * **Nullable, and permanently so.** Null means this User cannot log in with a
   * password while trusted code may still hand them a Token, which is the OIDC path
   * (ADR-0030) rather than a half-created row.
   */
  passwordHash: text("password_hash"),
  /**
   * `clock_timestamp()` and not `now()`, which is the transaction's start time: two
   * Users created in one transaction would share it exactly, and the list route
   * orders by this column, so their order would come down to the uuid tiebreak.
   */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

/**
 * A bearer Token: one row per login, and the only credential that travels on a
 * request.
 *
 * Nothing here is readable, only verifiable: the plaintext exists once, in the
 * response that issued it (invariant 7 in
 * [`data-model.md`](../../docs/data-model.md)).
 */
export const tokens = usersSchema.table(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * A real foreign key, and an uncomplicated one **because it is within this part's own
     * schema**: both tables are in the same module, so any barrel carrying one carries the
     * other. The cross-schema case is the HTTP Messenger's, and ADR-0046 is what made that
     * one declarable too.
     *
     * `on delete cascade` is carried deliberately for a delete that cannot currently
     * happen (nothing removes a User, ADR-0029), so that the day one is added, the
     * credentials go with them rather than outliving them.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * A plain single-pass SHA-256 of the 32 random bytes the holder carries, with no
     * salt and no KDF, because the input already has full entropy (ADR-0030).
     * Unique, so verification is a lookup **by** this column and the index does the
     * comparison.
     */
    tokenHash: text("token_hash").notNull().unique(),
    /** `clock_timestamp()` for the reason the User's is: it is the row's own time. */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /**
     * **Not nullable**, so "never expires" is unrepresentable and no read branches on
     * null. Written from the Manager's construction-time lifetime, against the
     * database's clock rather than this process's, since the comparison that refuses
     * an expired Token is made against the same clock.
     *
     * Nothing reaps a row past this time. That is an operational note in the
     * quickstart rather than a background job (ADR-0030).
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // Not redundant with the two indexes PostgreSQL makes for us: it indexes the
    // primary key and the unique constraint, not the referencing side, and revoking
    // every Token of one User reads exactly this way. The Signal Worker's `runs_signal_idx`
    // is there for the same reason.
    index("tokens_user_idx").on(table.userId),
  ],
);

/**
 * Everything the User Manager keeps, as `db.handle` wants it: one object, so
 * every module of this part asks for the same handle by the same name.
 */
export const usersTables = { users, tokens };
