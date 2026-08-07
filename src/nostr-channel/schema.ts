/**
 * The Nostr Channel's tables: `pubkeys` and `received`, in the `saf_nostr` schema.
 *
 * Public API, re-exported from `shared-agent-framework/nostr-channel`. An Operator barrels that
 * subpath into their own `schema.ts` and generates their DDL from it. Keep this file to the
 * tables and the values that define them.
 *
 * **No Message is here.** The log is the Messenger's, whichever medium a Message travelled by
 * ([ADR-0048](../../docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)).
 * What this Channel keeps is the two things only it can know: which Nostr public key is which
 * User, and which envelopes it has already turned into Messages
 * ([ADR-0049](../../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)).
 *
 * `pubkeys.user_id` is a foreign key onto `saf_users.users.id`, so this module imports the User
 * Manager's schema. It re-exports nothing of it. A barrel with this component and not the User
 * Manager generates a reference to a table nothing creates. Barrel
 * `shared-agent-framework/users` beside it. That is the second such import in the framework,
 * after the Messenger's, and it costs the same thing.
 */

import { sql } from "drizzle-orm";
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../users/schema.ts";

/**
 * The Nostr Channel's schema, named for the protocol rather than for the component.
 *
 * Prefixed because the framework is installed into a database it does not own. The name is not
 * an Operator's to change: the tables below are compiled against it, and their generation reads
 * that same object.
 */
export const nostrChannelSchema = pgSchema("saf_nostr");

/**
 * Which Nostr public key belongs to which User, and the whole of admission over this medium.
 *
 * **Written from trusted code only.** There is no route on either server that records one, so an
 * injected prompt cannot claim a User's key and take over their conversation
 * (ADR-0049). The recorded cost is that the agent cannot admit a stranger: a key nobody put here
 * is a key whose messages are dropped.
 *
 * Uniqueness runs both ways, and the two constraints refuse different mistakes. `user_id` is the
 * primary key, so one User holds at most one Nostr key. `pubkey` is unique, so a key already
 * recorded cannot be claimed by a second User — which is what stops one person's key becoming a
 * second person's inbox.
 */
export const pubkeys = nostrChannelSchema.table("pubkeys", {
  /**
   * The User this key speaks for. The primary key, so one User holds one Nostr key.
   *
   * A foreign key onto `saf_users.users.id`, and the only enforcement that this names a real
   * User: the refusal is PostgreSQL's `23503` caught, with no lookup in front of the write.
   *
   * No `onDelete`, because nothing removes a User and no cascade can fire.
   */
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  /**
   * The public key itself: 32 bytes as 64 lowercase hex characters, which is what both Nostr
   * libraries and the wire format use.
   *
   * Not an `npub`. NIP-19's human-facing encodings "MUST NOT be used in NIP-01 events", and the
   * framework decodes none of them (ADR-0050). What is stored here is compared byte for byte
   * against the author of a decrypted message, so a value in any other spelling matches nothing.
   */
  pubkey: text("pubkey").notNull().unique("pubkeys_pubkey_unique"),
  /**
   * `clock_timestamp()` and not `now()`, which is the transaction's start time.
   *
   * Two keys recorded in one transaction would share that exactly.
   */
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

/**
 * Every envelope that has already become a Message, keyed by the gift wrap's event id.
 *
 * **This is the correctness mechanism for inbound, and the subscription's `since`-lessness is
 * why** (ADR-0049). NIP-59 randomises a wrap's timestamp up to two days into the past, so a
 * timestamp watermark is not a valid cursor and the Channel re-reads what the Relay holds on
 * every connect instead. A primary key is what turns that repetition into nothing: the insert
 * shares the transaction that writes the Message, so a conflict means "already processed" and a
 * rollback un-processes it.
 *
 * Three other problems collapse into this one constraint: reconnect overlap, the `created_at`
 * tie when the paged read of stored events walks backwards, and the Relay delivering an event
 * twice.
 *
 * **Only admitted events get a row.** An envelope from a public key no `pubkeys` row names is
 * dropped and nothing whatever is stored for it, so a stranger who learns the agent's public
 * identity cannot grow this table. That also means such an envelope is harmlessly re-dropped on
 * every connect. The table is therefore the same order of magnitude as the Message log, and
 * nothing prunes it.
 */
export const received = nostrChannelSchema.table("received", {
  /** The gift wrap's own event id: 32 bytes as 64 lowercase hex characters. */
  eventId: text("event_id").primaryKey(),
  /** When this Gateway admitted it, which is not the timestamp the wrap carried. */
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

/**
 * Everything the Nostr Channel keeps, as `db.handle` wants it.
 *
 * One object, so every module of this component asks for the same handle by the same name.
 */
export const nostrChannelTables = { pubkeys, received };
