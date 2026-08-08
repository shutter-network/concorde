/**
 * An Operator's `drizzle-kit` reads this file, through the barrel they build out of the component
 * subpaths ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md),
 * [ADR-0047](../../docs/adr/0047-a-component-is-one-subpath.md)). Keep it to the tables and the
 * values that define them, and import no other component's schema.
 *
 * Four other components import this one, and six columns point a foreign key at `users.id`: the
 * Messenger's `messages.user_id` (ADR-0036), the Nostr Channel's `pubkeys.user_id` and
 * `outbox.user_id`
 * ([ADR-0049](../../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)), Password
 * Auth's `passwords.user_id` and `tokens.user_id`
 * ([ADR-0052](../../docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)),
 * and Nostr Auth's `grants.user_id`
 * ([ADR-0053](../../docs/adr/0053-nostr-auth-verifies-nip-98-per-request.md)).
 * A barrel carrying any of those without this one generates a constraint onto a table it never
 * creates. `schemas.test.ts` pushes every part's schema together, which is what keeps the
 * assembled set honest.
 *
 * **One table, and nothing a person presents.** The password digest and the Token table left for
 * Password Auth (ADR-0052), so a credential of any kind reaching this module again is the thing to
 * refuse in review: this component keeps identity, and the seam is who owns the secret.
 *
 * Nothing removes a User ([ADR-0029](../../docs/adr/0029-users-are-a-part-of-their-own.md)): no
 * delete route, no deactivation, and no column holding one. Do not add a `deactivated_at` for a
 * capability no deployment has asked for. It would put a state and two authentication branches
 * into the code.
 */

import { sql } from "drizzle-orm";
import { jsonb, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The PostgreSQL schema every table below lives in, `saf_users`.
 *
 * Prefixed because the framework is installed into a database it does not own, and an unprefixed
 * `users` is a plausible name for a schema an Operator already has. Not configurable: the tables
 * are compiled against this object, and the same object is what a generation reads.
 */
export const usersSchema = pgSchema("saf_users");

/**
 * A User: an opaque Gateway-issued id, arbitrary Attributes, and when they were admitted.
 *
 * Nothing removes a row. There is no delete, no deactivation and no column recording either, so a
 * reference to a User from another component's table cannot come to dangle.
 */
export const users = usersSchema.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Arbitrary JSON the deployment defines, and where grouping and therefore authorization live.
   *
   * No route anywhere writes this column: the agent cannot create a User at all, and trusted code
   * is the only caller of `setAttributes`. So the default is what every new row gets, and it is the
   * empty object.
   */
  attributes: jsonb("attributes").notNull().default({}),
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

export const usersTables = { users };
