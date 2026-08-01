/**
 * The User Directory's tables, in the part's own PostgreSQL schema
 * ([`data-model.md`](../../docs/data-model.md)).
 *
 * Not public API, for the same reason the Core's schema is not: every part of the
 * Gateway owns a schema and no part reads another's tables, so these objects are
 * exported for this part's own modules and are deliberately absent from the
 * package's `/users` subpath — an Operator who wants tables gets them through
 * `store.handle(theirOwnSchema)`, the same call the framework's parts use
 * (ADR-0021, ADR-0022).
 *
 * `drizzle-kit` reads this file to generate `migrations/users`, through a config
 * file of this part's own, so keep it to the tables and the values they are
 * defined in terms of.
 */

import { sql } from "drizzle-orm";
import { jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The User Directory's schema. Prefixed for the reason the Core's is: the framework
 * is installed into a database it does not own, an unprefixed `users` is a schema an
 * Operator plausibly already has, and this name is not theirs to change — the table
 * below is compiled against it, so a descriptor naming a different schema would
 * migrate one place and read another.
 */
export const usersSchema = pgSchema("saf_users");

/**
 * A User: an opaque Gateway-issued id, arbitrary Attributes, and a credential that
 * may not exist.
 *
 * There is deliberately **no `deactivated_at`** and no delete — nothing removes a
 * User (ADR-0029) — and no `outbox_cursor`, which is Outbox state and belongs to the
 * Messenger (ADR-0015).
 */
export const users = usersSchema.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Arbitrary JSON, deployment-defined, and where grouping and therefore
   * authorization live, since there is no Party (ADR-0008, ADR-0014). The Directory
   * stores them and interprets none of them.
   *
   * The default is what makes the agent's route safe by construction rather than by
   * a check: `POST /users` passes no attributes because it has no such parameter, so
   * the column's own default is the only thing that can decide what a created User
   * has, and it is the empty object.
   */
  attributes: jsonb("attributes").notNull().default({}),
  /**
   * scrypt, with its cost parameters stored alongside the digest. Unused until the
   * Public server's login route exists.
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
 * Everything the User Directory keeps, as `store.handle` wants it: one object, so
 * every module of this part asks for the same handle by the same name.
 */
export const usersTables = { users };
