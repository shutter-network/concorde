/**
 * The three statements the public-key mapping is made of: one insert, and one lookup each way.
 *
 * The insert is the Operator's, from their own code and inside their own transaction. One lookup
 * is the inbound path's, turning the author of a decrypted message into a User id — or into
 * nothing at all, which is how a stranger is dropped. The other is the outbound path's, turning a
 * User into the key a reply is addressed to — or into nothing, which is how a send refuses.
 *
 * A public key here **proves nothing**, in exactly the sense the User Manager's `setPassword`
 * proves nothing: the Operator established out of band that this key belongs to this person, and
 * this table records what they decided. Nothing in the framework verifies it, and nothing can.
 */

import { eq } from "drizzle-orm";
import type { Handle } from "../db/index.ts";
import { type nostrChannelTables, pubkeys } from "./schema.ts";

/** A handle typed to this component's own tables, and to no other's. */
type NostrHandle = Handle<typeof nostrChannelTables>;

/** PostgreSQL's SQLSTATE for a unique violation: the key, or the User, is spoken for. */
const uniqueViolation = "23505";

/** PostgreSQL's SQLSTATE for a foreign key violation: no such User. */
const foreignKeyViolation = "23503";

/** What a Nostr public key looks like on the wire: 32 bytes as 64 lowercase hex characters. */
const publicKeyPattern = /^[0-9a-f]{64}$/;

/**
 * The public key offered was not a Nostr public key.
 *
 * Refused at the call site rather than stored, because the alternative is silent and permanent: a
 * key recorded as an `npub1…`, in upper case, or with a `0x` in front of it is compared byte for
 * byte against the author of every decrypted message and matches none of them, so the User simply
 * never hears from the agent and nothing anywhere says why.
 *
 * This decodes nothing. An Operator holding an `npub` calls `nip19.decode` themselves, the way
 * they decode the secret key the constructor takes.
 */
export class MalformedPublicKeyError extends Error {
  constructor(publicKey: string) {
    super(
      `${JSON.stringify(publicKey)} is not a Nostr public key: 64 lowercase hex characters are wanted, and an npub is not one — decode it yourself with nip19.decode`,
    );
    this.name = "MalformedPublicKeyError";
  }
}

/**
 * No User has that id: PostgreSQL's `23503`, which is the foreign key catching a wrong id.
 *
 * An error class and not a status, because there is no route here to answer one with. Recording a
 * key is trusted code's alone.
 */
export class NoSuchUserError extends Error {
  constructor(userId: string) {
    super(`no User ${userId} exists, so no Nostr public key can be recorded for them`);
    this.name = "NoSuchUserError";
  }
}

/**
 * The key, or the User, is already spoken for: PostgreSQL's `23505`.
 *
 * Both directions are refused and this is deliberate. A key already recorded cannot be claimed by
 * a second User, or one person's messages would land in another's log. And a User already holding
 * a key cannot be given a second, because there would then be no answer to which one the agent
 * writes back to.
 */
export class PublicKeyConflictError extends Error {
  constructor(userId: string, publicKey: string) {
    super(
      `${publicKey} cannot be recorded for User ${userId}: either that key already belongs to another User or that User already has a key, and neither is replaced here`,
    );
    this.name = "PublicKeyConflictError";
  }
}

/**
 * Records that one Nostr public key belongs to one User, over whichever handle it is given.
 *
 * The query-builder form and a widened schema parameter, so it works on a transaction carrying
 * any component's schema — an Operator's own, in the transaction that also writes whatever they
 * record about the admission.
 *
 * The insert runs in a savepoint, so a refusal does not abort the caller's transaction. Drizzle's
 * nested `transaction` is a savepoint inside one and an ordinary transaction outside one.
 */
export async function insertPublicKey<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  userId: string,
  publicKey: string,
): Promise<void> {
  if (!publicKeyPattern.test(publicKey)) throw new MalformedPublicKeyError(publicKey);
  try {
    await handle.transaction(async (savepoint) => {
      await savepoint.insert(pubkeys).values({ userId, pubkey: publicKey });
    });
  } catch (error) {
    const code = sqlState(error);
    if (code === foreignKeyViolation) throw new NoSuchUserError(userId);
    if (code === uniqueViolation) throw new PublicKeyConflictError(userId, publicKey);
    throw error;
  }
}

/**
 * The User one public key speaks for, or `undefined` when the Operator recorded none.
 *
 * `undefined` is the whole of admission over this medium: the system is permissioned, so a key
 * nobody recorded has no User to attach a Message to, and the envelope is dropped with nothing
 * stored. On the component's own handle, because this read happens before any transaction is
 * opened — which is what makes "nothing stored" literal.
 */
export async function selectUserFor(
  handle: NostrHandle,
  publicKey: string,
): Promise<string | undefined> {
  const [row] = await handle
    .select({ userId: pubkeys.userId })
    .from(pubkeys)
    .where(eq(pubkeys.pubkey, publicKey))
    .limit(1);
  return row?.userId;
}

/**
 * The public key one User's replies are addressed to, or `undefined` when nobody recorded one.
 *
 * On the caller's handle and widened over its schema, because this read happens **inside the
 * transaction the Message is being written in**: an Operator who admits a User and answers them in
 * one transaction would otherwise be refused by a read that cannot see their own uncommitted
 * `recordPublicKey`.
 */
export async function selectPublicKeyFor<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  userId: string,
): Promise<string | undefined> {
  const [row] = await handle
    .select({ pubkey: pubkeys.pubkey })
    .from(pubkeys)
    .where(eq(pubkeys.userId, userId))
    .limit(1);
  return row?.pubkey;
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
