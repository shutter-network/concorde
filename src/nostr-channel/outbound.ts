/**
 * The statements the outbound queue is made of, and the two refusals that keep a Message from being
 * recorded as sent when it could never have gone out.
 *
 * The send is split in two because a publish cannot be rolled back and a transaction can.
 * Publishing inside the caller's transaction would either hold that transaction open across a round
 * trip to the Relay, or leave a recipient holding words the rollback erased from the log. So
 * everything knowable happens before the commit, the address, the wrap, its size and the row, and
 * the network act happens after it.
 *
 * That split is what puts the size bound here rather than in the publishing half, and it is the
 * thing to keep if this file is rearranged: built early, an over-long reply is a throw at the
 * Operator's own call site with nothing recorded, where built late it is a queue row that fails once
 * and stops.
 *
 * The other half is a pump: read the rows nothing has attempted, publish, delete on acceptance, and
 * leave a reason on anything else. Nothing retries, and this table is where retries,
 * backoff and an attempt cap would land.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { NostrEvent } from "nostr-tools/core";
import type { Handle } from "../db/index.ts";
import { type nostrChannelTables, outbox } from "./schema/index.ts";

// A handle typed to this component's own tables, and to no other's.
type NostrHandle = Handle<typeof nostrChannelTables>;

// The PostgreSQL notification channel a queued wrap announces itself on, and the one the Channel
// listens on. Prefixed for the reason the schema is, notification channels being per database. Not
// overridable: a Channel notifying one name and listening on another looks healthy and publishes
// nothing until the next start.
export const outboxChannel = "concorde_nostr_outbox";

/**
 * The User has no Nostr public key recorded, so there is no address to answer them at.
 *
 * Thrown inside the transaction the Message is being written in and before that Message row
 * survives, which is the point: a Message recorded as sent that nothing can deliver is a durable
 * claim that somebody was told something. Nothing was written, and the fix is recording a key rather
 * than sending again.
 */
export class UnrecordedPublicKeyError extends Error {
  constructor(userId: string) {
    super(
      `no Nostr public key is recorded for User ${userId}, so there is nowhere to send this Message; record one first, and nothing was written`,
    );
    this.name = "UnrecordedPublicKeyError";
  }
}

/**
 * The finished gift wrap is larger than the Relay said it accepts.
 *
 * Thrown inside the caller's transaction and before the Message row survives, so an over-long reply
 * is a refusal at the call site rather than something that fails after the fact. What is measured is
 * the whole message that goes on the wire and not the reply, because sealing more than doubles its
 * length: reckon on a 1.4 KB floor plus 2.1 times the reply, the payload being base64 of base64, so
 * a 32 KB reply is roughly a 66 KB wrap against a common Relay default of 65536.
 *
 * The maximum comes from the Relay's own NIP-11 document. A Relay that advertises none is a Relay
 * this is never thrown for, and an over-long reply is then whatever that Relay does with it.
 */
export class MessageTooLargeError extends Error {
  constructor(userId: string, bytes: number, limit: number) {
    super(
      `the reply to User ${userId} wraps to ${bytes} bytes and the Relay accepts ${limit}; shorten it, and nothing was written`,
    );
    this.name = "MessageTooLargeError";
  }
}

// One row of the queue, as the transaction that accepted the Message writes it.
export type QueuedWrap = {
  readonly userId: string;
  readonly messageId: string;
  readonly wrap: NostrEvent;
};

/**
 * How many bytes this wrap costs on the wire, as the Relay counts them.
 *
 * NIP-11's `max_message_length` bounds the whole JSON message a client sends and not the event
 * inside it, so what is measured is the `["EVENT", …]` frame, and in bytes rather than characters,
 * because a reply in any script but Latin would otherwise be measured short.
 */
export function wireSize(wrap: NostrEvent): number {
  return Buffer.byteLength(JSON.stringify(["EVENT", wrap]), "utf8");
}

/**
 * Queues one finished wrap and wakes the publishing half, in the caller's transaction.
 *
 * The query-builder form and a widened schema parameter, so it works on a transaction carrying any
 * component's schema, including an Operator's own.
 *
 * The `NOTIFY` is in that transaction with the row. PostgreSQL delivers a notification at commit and
 * never on rollback, so this cannot announce a wrap the rollback erased, nor stay silent about one
 * that committed. The payload is empty because the publishing half drains the whole queue: a
 * notification means only "look again", and PostgreSQL collapses identical ones sent in a single
 * transaction.
 */
export async function queueWrap<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  queued: QueuedWrap,
): Promise<void> {
  await handle.insert(outbox).values({
    eventId: queued.wrap.id,
    userId: queued.userId,
    messageId: queued.messageId,
    wrap: JSON.stringify(queued.wrap),
  });
  // `pg_notify` and not `NOTIFY`, because a utility statement takes no bind parameters.
  await handle.execute(sql`select pg_notify(${outboxChannel}, '')`);
}

/**
 * Every wrap nothing has attempted yet, oldest first.
 *
 * `reason is null` is the whole of "at most once": a refused wrap keeps its reason and is never
 * selected again, by this drain, by the one a later notification starts, or by the one the next
 * process runs at start. A row that outlived its process still has no reason, so it is picked up
 * here, which is the other half of the same predicate.
 */
export async function selectUnpublished(
  handle: NostrHandle,
): Promise<(typeof outbox.$inferSelect)[]> {
  return handle
    .select()
    .from(outbox)
    .where(isNull(outbox.reason))
    .orderBy(asc(outbox.queuedAt), asc(outbox.eventId));
}

// Forgets a wrap the Relay accepted, which is what keeps a healthy deployment's queue empty and
// makes anything left in it something an Operator wants to see.
export async function deletePublished(handle: NostrHandle, eventId: string): Promise<void> {
  await handle.delete(outbox).where(eq(outbox.eventId, eventId));
}

/**
 * Leaves the reason on a wrap the Relay refused, which retires it.
 *
 * Guarded on the row still having no reason, so two drains racing cannot overwrite the first answer
 * with the second, and so a row an Operator has already cleared by hand is not resurrected by a
 * publish that was in flight when they did it.
 */
export async function recordRefusal(
  handle: NostrHandle,
  eventId: string,
  reason: string,
): Promise<void> {
  await handle
    .update(outbox)
    .set({ reason, failedAt: sql`clock_timestamp()` })
    .where(and(eq(outbox.eventId, eventId), isNull(outbox.reason)));
}

/**
 * The wrap a row is carrying, as the Relay wants it.
 *
 * Cast rather than validated: this component wrote the column, in a transaction, out of an event its
 * own key signed. A row somebody edited by hand fails at the Relay's signature check instead, and
 * the reason it gives is stored like any other refusal.
 */
export function wrapOf(row: typeof outbox.$inferSelect): NostrEvent {
  return JSON.parse(row.wrap) as NostrEvent;
}

/**
 * What goes in the `reason` column: the message alone, and the stack goes to the log.
 *
 * The client library throws with the Relay's own `OK` reason as the message, which is why this is a
 * bare `error.message` and not a phrasing of ours. NIP-01 asks a Relay to prefix that string with a
 * machine-readable word, and rewording it would throw the only structure it has away.
 */
export function describeRefusal(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
