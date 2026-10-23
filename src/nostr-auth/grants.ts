import { eq, lt, sql } from "drizzle-orm";
import type { Handle } from "../db/index.ts";
import { admitted, grants, type nostrAuthTables } from "./schema/index.ts";

type NostrAuthHandle = Handle<typeof nostrAuthTables>;

const uniqueViolation = "23505";

const foreignKeyViolation = "23503";

const publicKeyPattern = /^[0-9a-f]{64}$/;

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

export async function admitEvent<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  eventId: string,
  windowMs: number,
): Promise<boolean> {
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

function sqlState(error: unknown): string | undefined {
  let unwrapped: unknown = error;
  while (unwrapped instanceof Error) {
    if ("code" in unwrapped && typeof unwrapped.code === "string") return unwrapped.code;
    unwrapped = unwrapped.cause;
  }
  return undefined;
}
