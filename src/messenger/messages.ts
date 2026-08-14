/**
 * The two statements this component is made of: one insert, and one read. The agent's send, a
 * Handler's `send` and a Channel's inbound `receive` are that insert with a different handle and a
 * different direction, and the agent's read, a User's own read and a Handler's `history` are that
 * one query with the User id arriving from a query parameter, a Token or an argument. Keep it that
 * way: a second spelling of either is a second chance to disagree about what `before` means.
 *
 * Numbering both directions per User is what the retry below is the price of. An
 * advisory lock and a per-User counter table have identical semantics and were rejected for adding
 * state and an idiom this repository has neither of. The savepoint is not part of the retry and
 * survives its removal: a constraint violation aborts the enclosing transaction, which on the
 * inbound path is the one carrying the Signal.
 */

import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Handle } from "../db/index.ts";
import type { CursorWindow } from "../route-conventions.ts";
import { type MessageDirection, messages, type messengerTables } from "./schema/index.ts";

type MessagesHandle = Handle<typeof messengerTables>;

/**
 * A Message, as every surface answers with it.
 *
 * The POST response, both reads, the Messenger's programmatic API and the Signal payload are one
 * shape rather than a projection each, so `direction` is on a Signal payload too, where it is
 * always `inbound`.
 *
 * `seq` numbers this Message inside one User's log across both directions, from 1, and it is the
 * cursor a read pages by. It is not global, and no other User's activity moves it.
 *
 * `createdAt` is an ISO 8601 string, because JSON has no date.
 */
export type MessageRecord = {
  readonly id: string;
  readonly userId: string;
  readonly direction: MessageDirection;
  readonly seq: number;
  readonly text: string;
  readonly createdAt: string;
};

// An alias and not a second declaration, so the components that page cannot come to disagree about
// what `before` means. What a cursor means lives beside the schema that validates it, in
// `route-conventions.ts`; this name is what this component's own modules say.
export type MessageWindow = CursorWindow;

/** What a send is: a User, a direction the server decided, and the text. */
export type OutgoingMessage = {
  readonly userId: string;
  readonly direction: MessageDirection;
  readonly text: string;
};

/**
 * No User has that id: PostgreSQL's `23503`, which is the foreign key catching a wrong one.
 *
 * An error class rather than a status. The insert is reached from a route, which has a 404 to
 * answer with, and from the programmatic API, which has no reply at all. There is no lookup in
 * front of the write, so this comes from the write that failed.
 *
 * The id is in the message and on no field of its own. Every caller already holds the id it passed.
 */
export class UnknownUserError extends Error {
  constructor(userId: string) {
    super(`no User ${userId} exists`);
    this.name = "UnknownUserError";
  }
}

/**
 * Five attempts at a `seq` all lost the race, which the routes answer with a 503.
 *
 * Not a correctness failure and not a caller's mistake. The numbering is intact, and this User's
 * own concurrent writers outran a bounded retry.
 */
export class SeqContentionError extends Error {
  constructor(userId: string, attempts: number) {
    super(
      `a Message for User ${userId} lost the race for its seq ${attempts} times; the log is intact and the send was not recorded`,
    );
    this.name = "SeqContentionError";
  }
}

/**
 * How many times an insert tries for a number before it gives up.
 *
 * Five is arbitrary, and the unique constraint is what makes the numbering correct. This bound is
 * what keeps one pathological client from becoming O(n²) inserts on a route nothing rate-limits.
 *
 * The cost is worth knowing: with n writers at once on one User, the last needs up to n attempts,
 * and each failure means somebody else committed the number it had computed.
 */
const maxAttempts = 5;

/** PostgreSQL's SQLSTATE for a unique violation: the numbering race, lost. */
const uniqueViolation = "23505";

/** PostgreSQL's SQLSTATE for a foreign key violation: no such User. */
const foreignKeyViolation = "23503";

/**
 * Writes one Message with the next number for its User, over whichever handle it is given.
 *
 * The query-builder form and a widened schema parameter, so it works on a transaction carrying any
 * component's schema. The inbound path's transaction is the one that also emits the Signal.
 *
 * Each attempt runs in a savepoint. Drizzle's nested `transaction` is a savepoint inside one and an
 * ordinary transaction outside one.
 */
export async function insertMessage<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  message: OutgoingMessage,
): Promise<MessageRecord> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await handle.transaction((savepoint) => insertOnce(savepoint, message));
    } catch (error) {
      const code = sqlState(error);
      // Not retried, and not a race. The foreign key refused the User outright, and a sixth
      // attempt would be refused identically.
      if (code === foreignKeyViolation) throw new UnknownUserError(message.userId);
      if (code !== uniqueViolation) throw error;
      if (attempt === maxAttempts) throw new SeqContentionError(message.userId, maxAttempts);
    }
  }
}

/**
 * One attempt: the number and the row in one statement.
 *
 * `coalesce(max(seq), 0) + 1` is a scalar subquery inside the insert rather than a read followed by
 * a write, so the window in which another writer can take the number is as narrow as PostgreSQL can
 * make it. `unique (user_id, seq)` makes the remaining window visible.
 */
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
    throw new Error("sending a Message inserted no row");
  }
  return asMessageRecord(inserted);
}

/**
 * One User's Messages, both directions, ascending by `seq`.
 *
 * `before`, and no cursor at all, select descending and reverse in memory. The newest page is what
 * a client opening a conversation wants, and PostgreSQL cannot answer "the last fifty in ascending
 * order" any other way. The reversal is invisible from outside: every page arrives ascending.
 *
 * On the component's own handle rather than a widened one. A read takes no transaction, and this
 * component reads nothing but its own table.
 */
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

/** The row as every surface reads it. */
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

/**
 * The SQLSTATE PostgreSQL refused a statement with, wherever it ended up.
 *
 * Drizzle wraps a driver error in one of its own and puts the original on `cause`, so the code is
 * one or two levels down. The chain is walked rather than the shape asserted, because which level
 * carries it has changed between versions.
 */
function sqlState(error: unknown): string | undefined {
  let unwrapped: unknown = error;
  while (unwrapped instanceof Error) {
    if ("code" in unwrapped && typeof unwrapped.code === "string") return unwrapped.code;
    unwrapped = unwrapped.cause;
  }
  return undefined;
}
