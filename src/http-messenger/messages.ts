/**
 * The two statements this component is made of: one insert, and one read.
 *
 * The agent's send and a Signal Handler's `send` are the same statement with a different handle.
 * The agent's read, a User's own read and a Handler's `history` are one query. The User id comes
 * from a different place each time: a query parameter, a Token, or an argument.
 */

import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Handle } from "../db/index.ts";
import type { CursorWindow } from "../route-conventions.ts";
import { type httpMessagesTables, type MessageDirection, messages } from "./schema.ts";

/** A handle typed to this component's own tables, and to no other's. */
type MessagesHandle = Handle<typeof httpMessagesTables>;

/**
 * A Message, as every surface answers with it.
 *
 * The POST response, both reads, the trusted-code methods and the Signal payload are one shape
 * rather than a projection each. So `direction` is on a Signal payload, where it is always
 * `inbound`. `createdAt` is an ISO 8601 string, because JSON has no date.
 *
 * A Handler for a submitted Message is written `SignalHandler<MessageRecord>`.
 */
export type MessageRecord = {
  readonly id: string;
  readonly userId: string;
  readonly direction: MessageDirection;
  readonly seq: number;
  readonly text: string;
  readonly createdAt: string;
};

/**
 * Which stretch of a User's log a read asks for: the shared cursor window, under this name.
 *
 * An alias and not a second declaration. What a cursor means lives beside the schema that
 * validates it, in `route-conventions.ts`. The name is what this component's own modules say.
 */
export type MessageWindow = CursorWindow;

/** What a send is: a User, a direction the server decided, and the text. */
export type OutgoingMessage = {
  readonly userId: string;
  readonly direction: MessageDirection;
  readonly text: string;
};

/**
 * No User has that id: PostgreSQL's `23503`, which is the foreign key catching a wrong id.
 *
 * An error class rather than a status. The insert is reached from a route, which has a 404 to
 * answer with. It is also reached from trusted code, which has no reply at all. There is no lookup
 * in front of the write, so this comes from the write that failed.
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
 * Five is arbitrary. The unique constraint is what makes the numbering correct. This bound keeps
 * one pathological client from becoming O(n²) inserts.
 *
 * The cost is worth knowing. With n writers at once on one User, the last needs up to n attempts.
 * Each failure means somebody else committed the number it had computed.
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
 * Each attempt runs in a savepoint, which is required whether or not the retry exists. A constraint
 * violation aborts the enclosing transaction, so a lost race would otherwise take the caller's
 * transaction down with it. Drizzle's nested `transaction` is a savepoint inside one and an
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
 * a write. So the window in which another writer can take the number is as narrow as PostgreSQL can
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
 * a client opening a conversation wants. PostgreSQL cannot answer "the last fifty in ascending
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
 * Drizzle wraps a driver error in one of its own and puts the original on `cause`. So the code is
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
