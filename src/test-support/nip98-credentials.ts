/**
 * NIP-98 credentials a test can build, including the ones no honest client would send.
 *
 * Nostr Auth's whole authentication is what is inside one kind 27235 event, so the interesting
 * tests are the events a well-behaved client cannot produce: one dated a day into the future, one
 * naming a URL the request is not, one signed by a key nobody granted. Every event here is
 * **really signed**, with `finalizeEvent` computing the id and the Schnorr signature over exactly
 * the fields the component verifies, so a forgery is refused by the primitive rather than by a
 * stub agreeing to fail.
 *
 * `nostr-tools`' own `nip98.getToken` builds only the honest one: it stamps `created_at` from the
 * clock, takes the tags it likes and hashes a payload with `JSON.stringify`. The dishonest knobs
 * are here instead, over the same primitives, which is the same reason `nostr-envelopes.ts` beside
 * this file assembles a gift wrap by hand.
 *
 * Nothing here is a production interface and nothing in `src/nostr-auth` imports it. It is the
 * **other end of the wire**: everything it builds is an ordinary event a real client could have
 * published, and what a test hands Fastify is the header string a real client would send.
 *
 * `src/test-support` is excluded from the build, so none of this ships.
 */

import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

/** NIP-98's HTTP authentication event. */
export const httpAuthKind = 27235;

/** One client's keypair: 32 raw bytes, and the 64 lowercase hex characters they derive. */
export type Signer = {
  readonly secretKey: Uint8Array;
  readonly publicKey: string;
};

/** A fresh signer, which is what a person's phone or laptop holds. */
export function signer(): Signer {
  const secretKey = generateSecretKey();
  return { secretKey, publicKey: getPublicKey(secretKey) };
}

/**
 * What a credential says, with every field a test may lie about.
 *
 * `url` and `method` are what the event claims rather than what the request is, which is how a
 * captured signature aimed at a different call is expressed. `createdAt` is in seconds and defaults
 * to now, which is where the future-dated test writes its whole subject.
 */
export type CredentialParts = {
  readonly signer: Signer;
  readonly url: string;
  readonly method: string;
  /** Hashed into a `payload` tag, exactly as a client that sends this body would hash it. */
  readonly body?: unknown;
  readonly createdAt?: number;
  readonly kind?: number;
  /**
   * What makes two otherwise identical credentials two credentials. Random unless given.
   *
   * A NIP-98 event's id is the hash of its fields, and `created_at` counts whole seconds, so the
   * same client asking the same question twice in one second signs the **same event** and the
   * second presentation is a replay. Real clients that make repeated calls add a tag for exactly
   * this reason, and so does every credential here: without it a test's second request would be
   * refused for a reason the test was not about.
   */
  readonly nonce?: string;
  /** Written instead of the `u`, `method` and `payload` tags the fields above produce. */
  readonly tags?: string[][];
};

/**
 * One signed credential, as the value of an `Authorization` header.
 *
 * The scheme is included, because that is what a client sends and what the component reads to
 * decide the request is its own.
 */
export function nip98Header(parts: CredentialParts): string {
  return `Nostr ${nip98Token(parts)}`;
}

/** The same credential without the scheme, for a test about a malformed header. */
export function nip98Token(parts: CredentialParts): string {
  const tags = parts.tags ?? [
    ["u", parts.url],
    ["method", parts.method],
    ["nonce", parts.nonce ?? randomUUID()],
    ...(parts.body === undefined ? [] : [["payload", hashBody(parts.body)]]),
  ];
  const event = finalizeEvent(
    {
      kind: parts.kind ?? httpAuthKind,
      tags,
      content: "",
      created_at: parts.createdAt ?? Math.floor(Date.now() / 1000),
    },
    parts.signer.secretKey,
  );
  return Buffer.from(JSON.stringify(event), "utf8").toString("base64");
}

/**
 * The hash a client puts in the `payload` tag: SHA-256 of the body it is about to send.
 *
 * Written the way `nostr-tools`' own `getToken` writes it, so what this file produces is what a
 * real client using that library would produce.
 */
export function hashBody(body: unknown): string {
  const bytes = typeof body === "string" ? body : JSON.stringify(body);
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
