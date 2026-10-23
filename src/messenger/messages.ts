import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Handle } from "../db/index.ts";
import type { CursorWindow } from "../route-conventions.ts";
import { type MessageDirection, messages, type messengerTables } from "./schema/index.ts";

type MessagesHandle = Handle<typeof messengerTables>;

export type MessageRecord = {
  readonly id: string;
  readonly userId: string;
  readonly direction: MessageDirection;
  /** Sequence within one user's message log, across both directions. */
  readonly seq: number;
  readonly text: string;
  readonly createdAt: string;
};

export type MessageWindow = CursorWindow;

export type OutgoingMessage = {
  readonly userId: string;
  readonly direction: MessageDirection;
  readonly text: string;
};

export class UnknownUserError extends Error {
  constructor(userId: string) {
    super(`No user ${userId} exists`);
    this.name = "UnknownUserError";
  }
}

export class SeqContentionError extends Error {
  constructor(userId: string, attempts: number) {
    super(
      `Could not allocate a message sequence for user ${userId} after ${attempts} attempts. Nothing was recorded; retry the send.`,
    );
    this.name = "SeqContentionError";
  }
}

const maxAttempts = 5;

const uniqueViolation = "23505";

const foreignKeyViolation = "23503";

export async function insertMessage<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  message: OutgoingMessage,
): Promise<MessageRecord> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // A unique violation aborts its transaction; isolate each retry in a savepoint.
      return await handle.transaction((savepoint) => insertOnce(savepoint, message));
    } catch (error) {
      const code = sqlState(error);
      if (code === foreignKeyViolation) throw new UnknownUserError(message.userId);
      if (code !== uniqueViolation) throw error;
      if (attempt === maxAttempts) throw new SeqContentionError(message.userId, maxAttempts);
    }
  }
}

async function insertOnce<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  message: OutgoingMessage,
): Promise<MessageRecord> {
  const [inserted] = await handle
    .insert(messages)
    .values({
      userId: message.userId,
      direction: message.direction,
      seq: sql`(select coalesce(max(${messages.seq}), 0) + 1 from ${messages} where ${messages.userId} = ${message.userId})`,
      text: message.text,
    })
    .returning();
  if (inserted === undefined) {
    throw new Error("Message insert returned no row");
  }
  return asMessageRecord(inserted);
}

export async function selectMessages(
  handle: MessagesHandle,
  userId: string,
  window: MessageWindow,
): Promise<MessageRecord[]> {
  const forwards = window.after !== undefined;
  const rows = await handle
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        window.after === undefined ? undefined : gt(messages.seq, window.after),
        window.before === undefined ? undefined : lt(messages.seq, window.before),
      ),
    )
    .orderBy(forwards ? asc(messages.seq) : desc(messages.seq))
    .limit(window.limit);
  const ascending = forwards ? rows : rows.reverse();
  return ascending.map(asMessageRecord);
}

function asMessageRecord(row: typeof messages.$inferSelect): MessageRecord {
  return {
    id: row.id,
    userId: row.userId,
    direction: row.direction,
    seq: row.seq,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

function sqlState(error: unknown): string | undefined {
  let unwrapped: unknown = error;
  while (unwrapped instanceof Error) {
    if ("code" in unwrapped && typeof unwrapped.code === "string") return unwrapped.code;
    unwrapped = unwrapped.cause;
  }
  return undefined;
}
