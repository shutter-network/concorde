/**
 * An Operator's `drizzle-kit` reads this file, through the barrel they build out of the component
 * subpaths ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md),
 * [ADR-0047](../../docs/adr/0047-a-component-is-one-subpath.md)). Keep it to the tables and the
 * values that define them.
 *
 * The import of the schema of Users is what lets `grants.user_id` reference `saf_users.users.id`,
 * and it re-exports nothing of it. That is the fourth such reference in the framework, after the
 * Messenger's, the Nostr Channel's two and Password Auth's two, and it costs the same thing: a
 * barrel carrying this component without that one generates a constraint onto a table nothing
 * creates.
 *
 * **`grants` is not a copy of `saf_nostr_channel.pubkeys` and must not be kept in step with it**
 * ([ADR-0053](../../docs/adr/0053-nostr-auth-verifies-nip-98-per-request.md)). The two tables hold
 * the same kind of value with opposite cardinalities and for opposite purposes: the Channel picks
 * exactly one key to *send* to, so its primary key is the User; this table admits any number of
 * signers to *act as* one User, so its primary key is the key. A reader who fixes the "duplication"
 * by pointing one at the other has made a person reachable over Nostr into a person who may drive
 * the HTTP API.
 *
 * `admitted` is written on every authenticated request, which no other table in the framework is.
 * It is pruned in the transaction that writes it, so read the delete in `grants.ts` before changing
 * either column here: the row's lifetime is derived from the freshness window and not chosen.
 */

import { sql } from "drizzle-orm";
import { index, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../users/schema.ts";

/**
 * The PostgreSQL schema both tables below live in, `saf_nostr_auth`.
 *
 * Prefixed because the framework is installed into a database it does not own, and not
 * configurable: the tables are compiled against this object, and the same object is what a
 * generation reads.
 */
export const nostrAuthSchema = pgSchema("saf_nostr_auth");

/**
 * One row per Nostr public key that may act as a User over HTTP, and no row for one that may not.
 *
 * The primary key is the **key**, so one User holds as many keys as they have signers and a person
 * with a phone and a laptop needs one User rather than two. Nothing here is unique per User.
 *
 * Written from trusted code only. No route on either server records a row, so an injected prompt
 * cannot grant itself a User's identity. The cost is that nobody enrols themselves: a key nobody
 * recorded authenticates nothing, whatever it signs.
 */
export const grants = nostrAuthSchema.table(
  "grants",
  {
    /**
     * The public key itself: 32 bytes as 64 lowercase hex characters, which is what the wire
     * format and both Nostr libraries use.
     *
     * Not an `npub`. NIP-19's human-facing encodings must not appear in an event, and the framework
     * decodes none of them. What is stored here is compared byte for byte against the author of a
     * verified event, so a value in any other spelling matches nothing.
     */
    pubkey: text("pubkey").primaryKey(),
    /**
     * The User this key acts as, and an ordinary column rather than a key of any kind.
     *
     * A foreign key onto `saf_users.users.id`. No `onDelete`, because nothing removes a User and no
     * cascade can fire.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /**
     * `clock_timestamp()` and not `now()`, which is the transaction's start time.
     *
     * Two keys recorded in one transaction would share that exactly.
     */
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    // Reading every key of one User is the Operator's own query, not this component's: the lookup
    // per request goes the other way and rides the primary key.
    index("nostr_auth_grants_user_idx").on(table.userId),
  ],
);

/**
 * Every NIP-98 event this Gateway has already admitted, keyed by the event's own id.
 *
 * This is the whole replay defence. Nothing in NIP-98 stops a captured `Authorization` header being
 * sent again inside its freshness window, and on a submission route that means the same Message
 * twice and the agent woken twice. The primary key is what turns the second presentation into a
 * refusal.
 *
 * Only an admitted event gets a row. A signature that did not verify, an event outside the window
 * and a key no `grants` row names are all refused before this table is touched, so a stranger
 * cannot grow it.
 *
 * The table prunes itself in the transaction that writes it, so its size is a function of the
 * traffic in the last window rather than of the traffic ever.
 */
export const admitted = nostrAuthSchema.table(
  "admitted",
  {
    // The event's own id: 32 bytes as 64 lowercase hex characters.
    eventId: text("event_id").primaryKey(),
    /**
     * When this Gateway admitted it, which is not the timestamp the event carried.
     *
     * `clock_timestamp()` and the database's clock throughout: the delete that prunes this table
     * compares this column against the same clock, so an offset between the Gateway and the
     * database cancels and only a difference of rate could matter.
     */
    admittedAt: timestamp("admitted_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    // The prune reads exactly this column, on every authenticated request. PostgreSQL indexes the
    // primary key and nothing else here.
    index("nostr_auth_admitted_at_idx").on(table.admittedAt),
  ],
);

export const nostrAuthTables = { grants, admitted };
