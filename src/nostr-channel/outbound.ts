import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { NostrEvent } from "nostr-tools/core";
import type { Handle } from "../db/index.ts";
import { type nostrChannelTables, outbox } from "./schema/index.ts";

type NostrHandle = Handle<typeof nostrChannelTables>;

export const outboxChannel = "concorde_nostr_outbox";

export class UnrecordedPublicKeyError extends Error {
  constructor(userId: string) {
    super(
      `no Nostr public key is recorded for User ${userId}, so there is nowhere to send this Message; record one first, and nothing was written`,
    );
    this.name = "UnrecordedPublicKeyError";
  }
}

export class MessageTooLargeError extends Error {
  constructor(userId: string, bytes: number, limit: number) {
    super(
      `the reply to User ${userId} wraps to ${bytes} bytes and the Relay accepts ${limit}; shorten it, and nothing was written`,
    );
    this.name = "MessageTooLargeError";
  }
}

export type QueuedWrap = {
  readonly userId: string;
  readonly messageId: string;
  readonly wrap: NostrEvent;
};

export function wireSize(wrap: NostrEvent): number {
  return Buffer.byteLength(JSON.stringify(["EVENT", wrap]), "utf8");
}

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
  await handle.execute(sql`select pg_notify(${outboxChannel}, '')`);
}

export async function selectUnpublished(
  handle: NostrHandle,
): Promise<(typeof outbox.$inferSelect)[]> {
  return handle
    .select()
    .from(outbox)
    .where(isNull(outbox.reason))
    .orderBy(asc(outbox.queuedAt), asc(outbox.eventId));
}

export async function deletePublished(handle: NostrHandle, eventId: string): Promise<void> {
  await handle.delete(outbox).where(eq(outbox.eventId, eventId));
}

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

export function wrapOf(row: typeof outbox.$inferSelect): NostrEvent {
  return JSON.parse(row.wrap) as NostrEvent;
}

export function describeRefusal(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
