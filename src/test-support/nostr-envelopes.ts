/**
 * NIP-59 envelopes a test can build, including the ones no honest client would send.
 *
 * The Nostr Channel's whole authentication is what is inside an envelope, so the interesting
 * tests are the envelopes a well-behaved library cannot produce: a rumor claiming an author the
 * seal did not sign for, a seal carrying tags, a layer that does not decrypt at all. `nostr-tools`'
 * own `nip59.wrapEvent` builds only the honest one — `createRumor` overwrites the author with the
 * sender's own key — so the layers are assembled here instead, out of the same primitives.
 *
 * Nothing here is a production interface and nothing in `src/nostr-channel` imports it. It is a
 * **sender**, which is the other side of the wire from the component under test: everything it
 * builds is an ordinary event a real client could have published, and it reaches the Channel
 * through the fake Relay rather than through any seam.
 *
 * `src/test-support` is excluded from the build, so none of this ships.
 */

import type { NostrEvent } from "nostr-tools/core";
import { encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";

/** NIP-59's seal, NIP-17's chat message, and NIP-59's gift wrap. */
export const sealKind = 13;
export const chatKind = 14;
export const giftWrapKind = 1059;

/** The unsigned inner message. Unsigned is the point: nothing about it is attested. */
export type Rumor = {
  readonly id: string;
  readonly pubkey: string;
  readonly kind: number;
  readonly content: string;
  readonly created_at: number;
  readonly tags: string[][];
};

/**
 * One NIP-44 layer, from anything: an object is serialized, a string is encrypted as it stands.
 *
 * The string form is what lets a test seal plaintext that is not JSON, which a Channel has to
 * drop rather than throw on.
 */
export function encryptTo(
  payload: unknown,
  secretKey: Uint8Array,
  recipientPublicKey: string,
): string {
  const plaintext = typeof payload === "string" ? payload : JSON.stringify(payload);
  return encrypt(plaintext, getConversationKey(secretKey, recipientPublicKey));
}

/**
 * A rumor **claiming** `author`, whoever ends up sealing it.
 *
 * The author is a parameter rather than derived from a secret key, which is the whole
 * impersonation attack in one argument: an attacker seals with their own key and writes somebody
 * else's here.
 */
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

/**
 * A seal around `payload`, signed by the sender and encrypted to the recipient.
 *
 * `overrides` is how a test builds the malformed ones: a seal of the wrong kind, a seal carrying
 * tags NIP-59 says it must not, or a seal whose ciphertext is not a NIP-44 payload at all.
 */
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
      // NIP-59 randomises this into the past; a fixed recent value keeps a test's ordering its
      // own business.
      created_at: Math.floor(Date.now() / 1000),
    },
    senderSecretKey,
  );
}

/**
 * A gift wrap with exactly this content, signed by a one-time key and addressed to the recipient.
 *
 * The one-time key is the protocol's, not a shortcut: every gift wrap is signed by a fresh random
 * key, which is why a Relay can never authorize a direct-message write by the event's author.
 *
 * `oneTimeKey` is a parameter because **the key that signs a wrap has to be the key that
 * encrypted it**: the recipient derives its conversation key from `wrap.pubkey`, so two different
 * throwaway keys produce a wrap nobody can open — which is a way of failing this file could
 * otherwise cause and no test would explain.
 */
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

/** A gift wrap around `payload`, encrypted to the recipient under a one-time key. */
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

/**
 * The honest envelope, in one call: a sender's own chat message, sealed and wrapped.
 *
 * `claimedAuthor` is the dishonest knob. Left out, the rumor names the sender, which is what a
 * real client sends. Set to somebody else's public key, it is the impersonation NIP-17's one
 * `MUST` exists to refuse — and both layers still decrypt cleanly, which is what makes it worth
 * a test.
 */
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
