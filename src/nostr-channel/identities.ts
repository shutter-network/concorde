import { eq } from "drizzle-orm";
import type { Handle } from "../db/index.ts";
import { type nostrChannelTables, pubkeys } from "./schema/index.ts";

type NostrHandle = Handle<typeof nostrChannelTables>;

const uniqueViolation = "23505";

const foreignKeyViolation = "23503";

const publicKeyPattern = /^[0-9a-f]{64}$/;

export class MalformedPublicKeyError extends Error {
  constructor(publicKey: string) {
    super(
      `Invalid Nostr public key ${JSON.stringify(publicKey)}. Expected 64 lowercase hex characters; decode npub values with nip19.decode.`,
    );
    this.name = "MalformedPublicKeyError";
  }
}

export class NoSuchUserError extends Error {
  constructor(userId: string) {
    super(`Cannot record a public key: user ${userId} does not exist`);
    this.name = "NoSuchUserError";
  }
}

export class PublicKeyConflictError extends Error {
  constructor(userId: string, publicKey: string) {
    super(
      `Cannot record ${publicKey} for user ${userId}: the key or user already has a mapping. Existing mappings are not replaced.`,
    );
    this.name = "PublicKeyConflictError";
  }
}

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

function sqlState(error: unknown): string | undefined {
  let unwrapped: unknown = error;
  while (unwrapped instanceof Error) {
    if ("code" in unwrapped && typeof unwrapped.code === "string") return unwrapped.code;
    unwrapped = unwrapped.cause;
  }
  return undefined;
}
