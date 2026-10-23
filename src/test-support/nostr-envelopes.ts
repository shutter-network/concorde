import type { NostrEvent } from "nostr-tools/core";
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";

export const sealKind = 13;
export const chatKind = 14;
export const giftWrapKind = 1059;

export type Rumor = {
  readonly id: string;
  readonly pubkey: string;
  readonly kind: number;
  readonly content: string;
  readonly created_at: number;
  readonly tags: string[][];
};

export function encryptTo(
  payload: unknown,
  secretKey: Uint8Array,
  recipientPublicKey: string,
): string {
  const plaintext = typeof payload === "string" ? payload : JSON.stringify(payload);
  return encrypt(plaintext, getConversationKey(secretKey, recipientPublicKey));
}

export function rumorFrom(author: string, text: string, kind: number = chatKind): Rumor {
  const rumor = {
    pubkey: author,
    kind,
    content: text,
    created_at: Math.floor(Date.now() / 1000),
    tags: [] as string[][],
  };
  return { ...rumor, id: getEventHash(rumor) };
}

export function sealFor(
  payload: unknown,
  senderSecretKey: Uint8Array,
  recipientPublicKey: string,
  overrides: { kind?: number; tags?: string[][]; content?: string } = {},
): NostrEvent {
  return finalizeEvent(
    {
      kind: overrides.kind ?? sealKind,
      tags: overrides.tags ?? [],
      content: overrides.content ?? encryptTo(payload, senderSecretKey, recipientPublicKey),
      created_at: Math.floor(Date.now() / 1000),
    },
    senderSecretKey,
  );
}

export function wrapContentFor(
  content: string,
  recipientPublicKey: string,
  createdAt: number = Math.floor(Date.now() / 1000),
  oneTimeKey: Uint8Array = generateSecretKey(),
): NostrEvent {
  return finalizeEvent(
    {
      kind: giftWrapKind,
      tags: [["p", recipientPublicKey]],
      content,
      created_at: createdAt,
    },
    oneTimeKey,
  );
}

export function wrapFor(
  payload: unknown,
  recipientPublicKey: string,
  createdAt?: number,
): NostrEvent {
  const oneTimeKey = generateSecretKey();
  return wrapContentFor(
    encryptTo(payload, oneTimeKey, recipientPublicKey),
    recipientPublicKey,
    createdAt,
    oneTimeKey,
  );
}

export type ReadMessage = {
  readonly sealAuthor: string;
  readonly rumor: Rumor;
};

export function readDirectMessage(
  wrap: NostrEvent,
  recipientSecretKey: Uint8Array,
): ReadMessage | undefined {
  try {
    const seal = JSON.parse(
      decrypt(wrap.content, getConversationKey(recipientSecretKey, wrap.pubkey)),
    ) as NostrEvent;
    const rumor = JSON.parse(
      decrypt(seal.content, getConversationKey(recipientSecretKey, seal.pubkey)),
    ) as Rumor;
    return { sealAuthor: seal.pubkey, rumor };
  } catch {
    return undefined;
  }
}

export function directMessage(options: {
  readonly senderSecretKey: Uint8Array;
  readonly recipientPublicKey: string;
  readonly text: string;
  readonly claimedAuthor?: string;
  readonly rumorKind?: number;
  readonly createdAt?: number;
}): NostrEvent {
  const author = options.claimedAuthor ?? getPublicKey(options.senderSecretKey);
  const rumor = rumorFrom(author, options.text, options.rumorKind);
  const seal = sealFor(rumor, options.senderSecretKey, options.recipientPublicKey);
  return wrapFor(seal, options.recipientPublicKey, options.createdAt);
}
