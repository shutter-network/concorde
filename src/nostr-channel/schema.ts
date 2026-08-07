/**
 * An Operator's `drizzle-kit` reads this file, through the barrel they build out of the component
 * subpaths. Keep it to the tables and the values that define them.
 *
 * No Message is declared here, whichever medium one travelled by: the log is the Messenger's
 * ([ADR-0048](../../docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). What
 * this Channel keeps is the three things only it can know
 * ([ADR-0049](../../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)).
 *
 * The import of the schema of Users is what lets two columns below reference
 * `saf_users.users.id`, and it re-exports nothing of it. That is the second such import in the
 * framework, after the Messenger's, and it costs the same thing: a barrel carrying this component
 * without that one generates a reference to a table nothing creates.
 */

import { sql } from "drizzle-orm";
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../users/schema.ts";

/**
 * The PostgreSQL schema every table below lives in, `saf_nostr`, named for the protocol rather than
 * for the component.
 *
 * Prefixed because the framework is installed into a database it does not own, and not
 * configurable: the tables are compiled against this object, and the same object is what a
 * generation reads.
 */
export const nostrChannelSchema = pgSchema("saf_nostr");

/**
 * Which Nostr public key belongs to which User, and the whole of admission over this medium.
 *
 * Written from trusted code only. No route on either server records a row here, so an injected
 * prompt cannot claim a User's key and take over their conversation. The cost is that the agent
 * cannot admit a stranger: a key nobody put here is a key whose messages are dropped.
 *
 * Uniqueness runs both ways, and the two constraints refuse different mistakes. `user_id` is the
 * primary key, so one User holds at most one Nostr key. `pubkey` is unique, so a key already
 * recorded cannot be claimed by a second User, which is what stops one person's key becoming a
 * second person's inbox.
 */
export const pubkeys = nostrChannelSchema.table("pubkeys", {
  /**
   * The User this key speaks for. The primary key, so one User holds one Nostr key.
   *
   * A foreign key onto `saf_users.users.id`, and the only enforcement that this names a real User:
   * the refusal is PostgreSQL's `23503` caught, with no lookup in front of the write.
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
 * This is the correctness mechanism for inbound. NIP-59 randomises a wrap's timestamp up to two days
 * into the past, so a timestamp watermark is not a valid cursor, and the Channel therefore asks the
 * Relay for everything it holds on every connect. A primary key is what turns that repetition into
 * nothing: the insert shares the transaction that writes the Message, so a conflict means "already
 * processed" and a rollback un-processes it. Reconnect overlap and a Relay that serves one event
 * twice collapse into the same constraint.
 *
 * Only admitted envelopes get a row. One from a public key no `pubkeys` row names is dropped with
 * nothing stored for it, so a stranger who learns the agent's public key cannot grow this table, and
 * that envelope is harmlessly re-dropped on every connect. The table is therefore the same order of
 * magnitude as the Message log, and nothing prunes it.
 */
export const received = nostrChannelSchema.table("received", {
  // The gift wrap's own event id: 32 bytes as 64 lowercase hex characters.
  eventId: text("event_id").primaryKey(),
  // When this Gateway admitted it, which is not the timestamp the wrap carried.
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
});

/**
 * Every gift wrap that is owed to the Relay, or that the Relay refused.
 *
 * A row is a durable claim that a Message was accepted for delivery, written in the same transaction
 * as the Message itself: a rollback loses both, so no recipient holds words the log denies. The wrap
 * is built and stored before that commit and published after it, which is what makes the table the
 * seam between the two halves of a send.
 *
 * A wrap the Relay accepts leaves no row, so a healthy deployment keeps this table empty. A row
 * carrying a `reason` is one the Relay refused, and it is never attempted again; recovering it is an
 * Operator replaying the row by hand.
 *
 * So `select * from saf_nostr.outbox where reason is not null` is the whole answer to "why did she
 * not get it", and it needs no API.
 */
export const outbox = nostrChannelSchema.table("outbox", {
  /**
   * The gift wrap's own event id: 32 bytes as 64 lowercase hex characters.
   *
   * The primary key, so the same wrap cannot be queued twice. It is also what the Relay
   * acknowledges by, which is what makes a publish and the delete that follows it name one thing.
   */
  eventId: text("event_id").primaryKey(),
  /**
   * The User this wrap is addressed to, and the column an Operator filters by.
   *
   * A foreign key onto `saf_users.users.id`, like `pubkeys.user_id`. It is not the recipient's
   * Nostr public key: that is inside the wrap, where the Relay cannot read it either.
   */
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  /**
   * The Message in the log that this wrap carries, so an Operator can read what was not delivered.
   *
   * Deliberately not a foreign key onto `saf_messenger.messages.id`. The wrap is opaque, so this id
   * is the only route from a stuck row back to the words, and a plain column answers that with one
   * join. A constraint would add a third cross-schema reference to a value written in the same
   * transaction as the row it names, out of a record this component was just handed.
   */
  messageId: uuid("message_id").notNull(),
  /**
   * The finished gift wrap, as the JSON that goes on the wire.
   *
   * Stored whole and byte for byte, which is what keeps key material out of the publishing half:
   * the wrap was sealed and signed inside the transaction, so nothing after the commit needs the
   * agent's secret key to send it. It is encrypted to the recipient, so this column tells the
   * Operator nothing about what it says.
   */
  wrap: text("wrap").notNull(),
  /**
   * Why the Relay refused it, in the Relay's own words, or `null` while nothing has retired it.
   *
   * NIP-01 prefixes an `OK` message's reason with a machine-readable word, `blocked:`,
   * `rate-limited:`, `invalid:` or `auth-required:`, so "the Relay was down" and "the Relay refused
   * this" are distinguishable without parsing prose.
   *
   * `null` is what the publishing half selects on, and that is what makes "never attempted again"
   * hold across a notification, a restart and a stop and start alike. So `null` is "still owed"
   * rather than "never tried": a publish a shutdown interrupted leaves the row exactly as the
   * transaction wrote it, so that the next start owes it rather than reading it as spent.
   */
  reason: text("reason"),
  /**
   * When the transaction that accepted the Message wrote this row.
   *
   * `clock_timestamp()` and not `now()`, which is the transaction's start time. Two wraps queued in
   * one transaction would share that exactly, and this column is the publishing order.
   */
  queuedAt: timestamp("queued_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
  // When the Relay refused it, and `null` for as long as `reason` is.
  failedAt: timestamp("failed_at", { withTimezone: true }),
});

export const nostrChannelTables = { pubkeys, received, outbox };
