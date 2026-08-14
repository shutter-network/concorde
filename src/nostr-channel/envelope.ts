/**
 * The NIP-59 envelope, unwrapped by hand over the encryption primitive, and the five checks that
 * are the whole authentication of an inbound message.
 *
 * A gift wrap is signed by a fresh random key and the rumor inside it is signed by nobody. So the
 * only thing that binds a message to its author is that the *seal* decrypted under a conversation
 * key derived from that author's public key, and that the rumor agrees with the seal about who
 * that was. NIP-17 states the second half as its one `MUST`:
 *
 * > Clients MUST verify if pubkey of the `kind:13` is the same pubkey as that of the
 * > `unsignedMessageRumor`, otherwise any sender can impersonate any other by simply changing
 * > the pubkey on the rumor.
 *
 * `nostr-tools`' own `unwrapEvent` decrypts both layers and returns the rumor, **discarding the
 * seal**, so `seal.pubkey` never reaches a caller and the comparison is not merely omitted but
 * inexpressible through it. Do not rewrite this over that function, or over any other convenience
 * wrapper that hands back one layer. `receiving.test.ts`'s forged envelope is the only thing that
 * would notice the check being refactored away.
 *
 * The order of the checks is itself the decision, and it is the order below:
 *
 * ```text
 * decrypt wrap -> seal;   require seal.kind is the seal kind and its tags are empty
 * decrypt seal -> rumor;  require rumor author == seal author      <- the MUST
 *                         reject rumor author == the agent's own key
 *                         require rumor kind is the chat kind
 * ```
 *
 * Nothing here throws and nothing here touches the database. Every refusal is an `Opened` carrying
 * a reason, which the Channel logs and drops, because a thrown error would end the subscription
 * and one malformed event would then cost every later message.
 *
 * Sealing goes the other way and is the library's one call: a rumor the agent wrote carries the
 * agent's own key by construction, so there is no `MUST` to express. Both halves live in this one
 * file so that they cannot drift apart into two nobody reads together.
 */

import type { NostrEvent } from "nostr-tools/core";
import { wrapEvent } from "nostr-tools/nip17";
import { decrypt, getConversationKey } from "nostr-tools/nip44";

// NIP-59's seal: the sender's signed envelope around the rumor, carrying no tags at all.
export const sealKind = 13;

// NIP-17's private direct message, which is the only inner kind this Channel accepts.
export const chatKind = 14;

// NIP-59's gift wrap: what the Relay holds and serves, signed by a throwaway key.
export const giftWrapKind = 1059;

// NIP-42's authentication event, which is the whole of what this component reads from that NIP.
export const authenticationKind = 22242;

// NIP-17's relay list: where a public key receives private direct messages.
export const directMessageRelaysKind = 10050;

// A result and not an exception, for the reason in the file header: a rejection is a log line and
// a dropped event, never the end of the subscription.
export type Opened =
  | { readonly ok: true; readonly rumor: Rumor }
  | { readonly ok: false; readonly reason: string };

/**
 * The unsigned inner message: who wrote it, what kind it is, and what it says.
 *
 * `pubkey` is trustworthy only because `openEnvelope` compared it against the seal's author, and
 * the seal's author is trustworthy because the seal decrypted under a conversation key derived
 * from it. A `Rumor` from anywhere else carries neither statement.
 */
export type Rumor = {
  readonly pubkey: string;
  readonly kind: number;
  readonly content: string;
  readonly created_at: number;
  readonly tags: readonly (readonly string[])[];
};

/**
 * Unwraps one gift wrap addressed to this agent and answers with the rumor, or with why not.
 *
 * `wrap` is the event the Relay served, whose own signature the client checked before this ran.
 * `secretKey` is the agent's 32 raw bytes, which both conversation keys are derived from.
 * `agentPublicKey` is the agent's own public key in lowercase hex, so that an envelope claiming to
 * come from the agent is refused rather than answered.
 */
export function openEnvelope(
  wrap: { readonly pubkey: string; readonly content: string },
  secretKey: Uint8Array,
  agentPublicKey: string,
): Opened {
  const seal = decryptEvent(wrap.content, secretKey, wrap.pubkey);
  if (seal === undefined) return { ok: false, reason: "the wrap did not decrypt to an event" };

  // NIP-59 requires a seal to be a kind 13 carrying no tags whatever. A seal with tags is either
  // a different protocol or an attempt to smuggle addressing past a reader that only looks
  // inside, so it is refused before anything is decrypted with the key it names.
  if (seal.kind !== sealKind) return { ok: false, reason: `the seal is kind ${seal.kind}` };
  if (seal.tags.length !== 0) return { ok: false, reason: "the seal carries tags" };

  // The conversation key comes from `seal.pubkey`, which is what makes the seal's author honest:
  // forging one that names somebody else would need that somebody's secret to produce a payload
  // that decrypts under it.
  const rumor = decryptEvent(seal.content, secretKey, seal.pubkey);
  if (rumor === undefined) return { ok: false, reason: "the seal did not decrypt to an event" };

  // NIP-17's one MUST, and the only authentication in this envelope. Both layers decrypt cleanly
  // for an attacker who seals honestly with their own key and writes a victim's public key on
  // the rumor; this line is what stops that becoming one User speaking as another.
  if (rumor.pubkey !== seal.pubkey) {
    return { ok: false, reason: "the rumor claims an author the seal did not sign for" };
  }
  // Nobody speaks as the agent, including the agent: a Message the agent appeared to have sent
  // itself would wake it with its own words.
  if (rumor.pubkey === agentPublicKey) {
    return { ok: false, reason: "the rumor claims the agent's own key" };
  }
  if (rumor.kind !== chatKind) return { ok: false, reason: `the rumor is kind ${rumor.kind}` };

  return { ok: true, rumor };
}

/**
 * Seals one reply for one recipient and answers with the single gift wrap that goes on the wire.
 *
 * One wrap, not two. `wrapManyEvents` produces a second one addressed to the sender, so that a
 * client can recover its own sent messages from a Relay. The agent's record of what it said is the
 * Message log, so the self-copy would halve nothing and would put the agent's own events on the
 * agent's own subscription. `wrapEvent` is therefore the entry point, and that is a decision
 * rather than a shortcut.
 *
 * Nothing about the result is dated now. NIP-59 randomises both the seal's and the wrap's
 * `created_at` up to two days into the past, which hides when the agent answered from anyone
 * reading the Relay and keeps the published event out of the future, which some Relays refuse
 * outright. Only the rumor carries the real time, where nobody but the recipient reads it.
 *
 * `text` is the reply as the Messenger's log holds it, `secretKey` the agent's 32 raw bytes, and
 * `recipientPublicKey` the recipient in lowercase hex. That last is the only `p` tag on the wrap,
 * so nothing the Relay can read names anybody else.
 */
export function sealEnvelope(
  text: string,
  secretKey: Uint8Array,
  recipientPublicKey: string,
): NostrEvent {
  return wrapEvent(secretKey, { publicKey: recipientPublicKey }, text);
}

/**
 * One NIP-44 layer: decrypt with the conversation key for `author`, parse, and check the shape.
 *
 * Answers `undefined` for every failure alike, a bad conversation key, a payload that is not
 * NIP-44, plaintext that is not JSON and JSON that is not an event, because the caller does the
 * same thing with all of them and telling a sender which one it was would be a decryption oracle.
 */
function decryptEvent(payload: string, secretKey: Uint8Array, author: string): Rumor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypt(payload, getConversationKey(secretKey, author)));
  } catch {
    return undefined;
  }
  return isEventShaped(parsed) ? parsed : undefined;
}

/**
 * Whether a decrypted object has the five fields the checks above read.
 *
 * Written out rather than trusted, because everything inside the envelope is attacker-controlled
 * JSON: a `tags` that is a string would make `seal.tags.length` a character count, and a `kind`
 * that is a string would make `!==` true for the wrong reason.
 */
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
