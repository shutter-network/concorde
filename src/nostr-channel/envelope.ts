import type { NostrEvent } from "nostr-tools/core";
import { wrapEvent } from "nostr-tools/nip17";
import { decrypt, getConversationKey } from "nostr-tools/nip44";

export const sealKind = 13;

export const chatKind = 14;

export const giftWrapKind = 1059;

export const authenticationKind = 22242;

export const directMessageRelaysKind = 10050;

export type Opened =
  | { readonly ok: true; readonly rumor: Rumor }
  | { readonly ok: false; readonly reason: string };

export type Rumor = {
  readonly pubkey: string;
  readonly kind: number;
  readonly content: string;
  readonly created_at: number;
  readonly tags: readonly (readonly string[])[];
};

export function openEnvelope(
  wrap: { readonly pubkey: string; readonly content: string },
  secretKey: Uint8Array,
  agentPublicKey: string,
): Opened {
  // Unwrap manually: unwrapEvent discards the seal needed to verify the rumor author.
  const seal = decryptEvent(wrap.content, secretKey, wrap.pubkey);
  if (seal === undefined) return { ok: false, reason: "the wrap did not decrypt to an event" };

  if (seal.kind !== sealKind) return { ok: false, reason: `the seal is kind ${seal.kind}` };
  if (seal.tags.length !== 0) return { ok: false, reason: "the seal carries tags" };

  const rumor = decryptEvent(seal.content, secretKey, seal.pubkey);
  if (rumor === undefined) return { ok: false, reason: "the seal did not decrypt to an event" };

  if (rumor.pubkey !== seal.pubkey) {
    return { ok: false, reason: "the rumor claims an author the seal did not sign for" };
  }
  if (rumor.pubkey === agentPublicKey) {
    return { ok: false, reason: "the rumor claims the agent's own key" };
  }
  if (rumor.kind !== chatKind) return { ok: false, reason: `the rumor is kind ${rumor.kind}` };

  return { ok: true, rumor };
}

export function sealEnvelope(
  text: string,
  secretKey: Uint8Array,
  recipientPublicKey: string,
): NostrEvent {
  return wrapEvent(secretKey, { publicKey: recipientPublicKey }, text);
}

function decryptEvent(payload: string, secretKey: Uint8Array, author: string): Rumor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypt(payload, getConversationKey(secretKey, author)));
  } catch {
    return undefined;
  }
  return isEventShaped(parsed) ? parsed : undefined;
}

function isEventShaped(value: unknown): value is Rumor {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.pubkey === "string" &&
    typeof event.kind === "number" &&
    typeof event.content === "string" &&
    typeof event.created_at === "number" &&
    Array.isArray(event.tags)
  );
}
