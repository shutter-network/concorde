/**
 * The two statements the whole part is made of: the insert every send reaches, and the
 * read every surface answers from.
 *
 * One insert and one read, deliberately. The agent's send and a Signal Handler's `send`
 * are the same statement with a different handle; the agent's read, a User's own read and
 * a Handler's `history` are the same query with the User id from a different place — a
 * query parameter, a Token, or an argument. Duplicating either would be two chances to
 * get the numbering or the cursor wrong.
 */

import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Handle } from "../db/index.ts";
import { type httpMessagesTables, type MessageDirection, messages } from "./schema.ts";

/** A handle typed to this part's own tables, and to no other part's (ADR-0022). */
type MessagesHandle = Handle<typeof httpMessagesTables>;

/**
 * A Message as every surface answers with it: the POST response, both reads, the
 * trusted-code methods and the Signal payload.
 *
 * One shape and not a projection per surface. `direction` is redundant in the Signal
 * payload, where it is always `inbound`, and `seq` is redundant for most Handlers; both
 * are paid so that this part has one shape rather than two kept parallel by hand
 * (ADR-0034). `createdAt` is an ISO 8601 string, because JSON has no date.
 *
 * It lives here rather than in `routes.ts`, where the User Manager keeps `UserRecord`,
 * because it is not only the wire shape: it is what the insert answers with and what a
 * Handler is written against, and the routes are one consumer of it among three.
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
 * Which stretch of a User's log a read asks for.
 *
 * Three motions and one order on the wire: no cursor is the newest `limit`, `before` is
 * the newest `limit` strictly below it, and `after` is everything above it capped at
 * `limit`. All three answer ascending by `seq`, so a client concatenates pages without
 * reversing anything (ADR-0035). Both cursors at once describes two windows and is
 * refused by the routes rather than resolved here.
 */
export type MessageWindow = {
  readonly after?: number;
  readonly before?: number;
  readonly limit: number;
};

/** What a send is: a User, a direction the server decided, and the text. */
export type OutgoingMessage = {
  readonly userId: string;
  readonly direction: MessageDirection;
  readonly text: string;
};

/**
 * No User has that id: PostgreSQL's `23503`, which is the foreign key doing the one thing
 * it exists to catch — an agent copying an id wrong (ADR-0036).
 *
 * An error class rather than a status, because the insert is reached from a route, which
 * has a 404 to answer with, and from trusted code, which has nothing to write a status
 * to. There is deliberately no lookup in front of the write: a check in front of a
 * constraint is two mechanisms for one rule, and it would make the 404 come from a read
 * rather than from the write that actually failed.
 *
 * The id is in the message and on no field of its own: every caller already holds the id it
 * passed, so a field would be a second copy for nobody to read.
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
 * Not a correctness failure and not a caller's mistake: the numbering is intact, and what
 * has happened is that this User's own concurrent writers outran a bounded retry.
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
 * How many times an insert will try for a number before giving up.
 *
 * **Five is arbitrary.** It is not a correctness number — the unique constraint is what
 * makes the numbering correct, and one more attempt would always eventually get one — it
 * is the point at which further attempts are answering the wrong question: this many
 * losses means something is wrong that a sixth attempt will not fix. The bound exists
 * because the alternative amplifies one pathological client into O(n²) inserts on a route
 * nothing rate limits, and the shape of the cost is worth knowing: with n writers at once
 * on one User, the last of them needs up to n attempts, since each failure means somebody
 * else committed the number it had computed.
 */
const maxAttempts = 5;

/** PostgreSQL's SQLSTATE for a unique violation: the numbering race, lost. */
const uniqueViolation = "23505";

/** PostgreSQL's SQLSTATE for a foreign key violation: no such User. */
const foreignKeyViolation = "23503";

/**
 * Writes one Message with the next number for its User, over whichever handle the caller
 * reached it by.
 *
 * The query-builder form and a widened schema parameter, so it works on a transaction
 * carrying any part's schema (ADR-0023): the inbound path's transaction is the one that
 * also emits the Signal, and a Handler's is its own.
 *
 * Each attempt runs in a **savepoint**, and that is required whether or not the retry
 * exists: a constraint violation aborts the enclosing transaction, so without one a lost
 * race would take the caller's transaction down with it — including the emit it was
 * keeping the insert company with. Drizzle's nested `transaction` is a savepoint on a
 * handle that is already in one and an ordinary transaction on a handle that is not, which
 * is what makes both callers the same code.
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
      // Not retried, and not a race: the foreign key refused the User outright, and a
      // sixth attempt would be refused identically (ADR-0036).
      if (code === foreignKeyViolation) throw new UnknownUserError(message.userId);
      if (code !== uniqueViolation) throw error;
      if (attempt === maxAttempts) throw new SeqContentionError(message.userId, maxAttempts);
    }
  }
}

/**
 * One attempt: the number and the row in one statement.
 *
 * `coalesce(max(seq), 0) + 1` is a scalar subquery in the statement that uses it rather
 * than a read followed by a write, so the window in which another writer can take the
 * number is as narrow as PostgreSQL can make it — and `unique (user_id, seq)` is what
 * makes the remaining window visible instead of silently renumbering somebody.
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
 * `before` and no cursor at all select **descending** and reverse in memory, because the
 * newest page is what a client opening a conversation wants and PostgreSQL cannot answer
 * "the last fifty in ascending order" without one or the other. The reversal is the whole
 * of that asymmetry, and it is invisible from outside: every page arrives ascending, so a
 * client concatenates them without reversing anything (ADR-0035).
 *
 * On the part's own handle rather than a widened one: a read takes no transaction
 * (ADR-0023), and this part reads nothing but its own table.
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
 * Drizzle wraps a driver error in one of its own and puts the original on `cause`, so the
 * code is one or two levels down rather than on the error a caller catches. The chain is
 * walked rather than the shape asserted, because which level carries it is Drizzle's
 * business and has changed between versions.
 */
function sqlState(error: unknown): string | undefined {
  let unwrapped: unknown = error;
  while (unwrapped instanceof Error) {
    if ("code" in unwrapped && typeof unwrapped.code === "string") return unwrapped.code;
    unwrapped = unwrapped.cause;
  }
  return undefined;
}
