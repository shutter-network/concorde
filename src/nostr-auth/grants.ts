/**
 * The four statements this component is made of: the grant written, the grant read, and the two
 * halves of the replay record that share one transaction.
 *
 * Which handle each takes is the decision in this file. `insertGrant` is widened over the caller's
 * schema and runs on the caller's transaction, so an Operator who admits a User and grants their
 * key in one transaction is not refused by a read that cannot see their own uncommitted write.
 * `selectGrantFor` runs on the component's own handle, before any transaction is opened, which is
 * what makes "nothing is stored for a stranger" literal.
 *
 * The insert is wrapped in a savepoint because Drizzle's nested `transaction` is a savepoint inside
 * one, and a constraint violation would otherwise abort whatever the Operator was doing beside it.
 *
 * **The prune's cutoff is derived and not chosen, and `admitEvent`'s comment is not enough on its
 * own.** A row is needed for exactly as long as the event it names could pass the freshness check
 * again. The window is two-sided, so an event may be admitted up to one whole window *before* its
 * own `created_at` and stays presentable until one window *after* it: two windows of real time from
 * admission, at the worst. So the cutoff is `2 * windowMs` and nothing shorter. Both sides of the
 * comparison are the database's `clock_timestamp()`, so an offset between the Gateway's clock and
 * the database's cancels out of a duration and only two Gateways whose clocks disagree with each
 * other could shorten it.
 */

import { eq, lt, sql } from "drizzle-orm";
import type { Handle } from "../db/index.ts";
import { admitted, grants, type tables } from "./schema.ts";

// A handle typed to this component's own tables, and to no other's.
type NostrAuthHandle = Handle<typeof tables>;

// PostgreSQL's SQLSTATE for a unique violation: that key is already granted.
const uniqueViolation = "23505";

// PostgreSQL's SQLSTATE for a foreign key violation: no such User.
const foreignKeyViolation = "23503";

// What a Nostr public key looks like on the wire: 32 bytes as 64 lowercase hex characters.
const publicKeyPattern = /^[0-9a-f]{64}$/;

/**
 * Records that one Nostr public key may act as one User, over whichever handle it is given.
 *
 * The query-builder form and a widened schema parameter, so it works on a transaction carrying any
 * component's schema, including an Operator's own.
 */
export async function insertGrant<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  userId: string,
  publicKey: string,
): Promise<void> {
  if (!publicKeyPattern.test(publicKey)) {
    throw new Error(
      `${JSON.stringify(publicKey)} is not a Nostr public key: 64 lowercase hex characters are wanted, and an npub is not one: decode it yourself with nip19.decode`,
    );
  }
  try {
    await handle.transaction(async (savepoint) => {
      await savepoint.insert(grants).values({ userId, pubkey: publicKey });
    });
  } catch (error) {
    const code = sqlState(error);
    if (code === foreignKeyViolation) {
      throw new Error(`no User ${userId} exists, so no Nostr public key can be granted to them`);
    }
    if (code === uniqueViolation) {
      throw new Error(
        `${publicKey} is already granted, and a key acts as one User: delete the row to move it`,
      );
    }
    throw error;
  }
}

/**
 * The User one public key may act as, or `undefined` when the Operator granted it nothing.
 *
 * `undefined` is the whole of admission over this scheme, and it is answered before anything is
 * written: a key nobody granted leaves no row in `admitted` and cannot grow that table.
 */
export async function selectGrantFor(
  handle: NostrAuthHandle,
  publicKey: string,
): Promise<string | undefined> {
  const [row] = await handle
    .select({ userId: grants.userId })
    .from(grants)
    .where(eq(grants.pubkey, publicKey))
    .limit(1);
  return row?.userId;
}

/**
 * Records one admitted event id and prunes the rows past the window, in the caller's transaction,
 * and answers whether this event is new.
 *
 * `false` is a replay: the id is already there, so this credential has been presented before and
 * the request is refused. The insert and the delete are one statement pair on purpose, so the table
 * holds the last window's traffic rather than every request ever made.
 */
export async function admitEvent<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  eventId: string,
  windowMs: number,
): Promise<boolean> {
  // Derived, not chosen: see the file header. `make_interval` takes seconds as a float, so a
  // window of one millisecond is expressible and a test needs no clock moved.
  const staleSeconds = (2 * windowMs) / 1000;
  await handle
    .delete(admitted)
    .where(
      lt(admitted.admittedAt, sql`clock_timestamp() - make_interval(secs => ${staleSeconds})`),
    );

  const written = await handle
    .insert(admitted)
    .values({ eventId })
    .onConflictDoNothing()
    .returning({ eventId: admitted.eventId });
  return written.length > 0;
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
