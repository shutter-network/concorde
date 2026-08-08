/**
 * The NIP-98 credential, checked by hand over the signature primitive, and the seven checks that
 * are the whole authentication of a request
 * ([ADR-0053](../../docs/adr/0053-nostr-auth-verifies-nip-98-per-request.md)).
 *
 * This file is `src/nostr-channel/envelope.ts`'s sibling and was written from the same argument.
 * `nostr-tools` ships `nip98.validateToken`, and **nothing here calls it**. Its freshness check,
 * read out of the installed package, is one-sided:
 *
 * ```js
 * function validateEventTimestamp(event) {
 *   if (!event.created_at) return false;
 *   return Math.round(new Date().getTime() / 1e3) - event.created_at < 60;
 * }
 * ```
 *
 * An event stamped in the future subtracts to a negative number, passes, and passes forever. A
 * client that sets `created_at` ten years ahead holds a credential with no expiry, and a client
 * with a fast clock holds one by accident. That is not a check the library is missing; it is a
 * check the library makes wrongly, so calling it and adding one more would leave a reader unable
 * to tell which of the two is load-bearing.
 *
 * Two more things about that function are worth carrying, because both look like reasons to reach
 * for it and are not:
 *
 *  - **`validateToken` never checks the payload hash.** It calls `validateEvent(event, url,
 *    method)` with no fourth argument, and the body check inside is guarded by `Boolean(body)`. The
 *    request body is therefore unbound to the signature through that entry point.
 *  - **It throws a different `Error` per failure**, so the six mechanical refusals are reachable
 *    only by matching the text of a message the library may reword.
 *
 * `verifyEvent` is the primitive, and every check above it is here. Do not rewrite this over
 * `nip98.validateToken`, or over any other convenience wrapper.
 * `authenticating.test.ts`'s future-dated request is the one test whose whole subject is the check
 * that function does not make, and it is what would notice the validation being simplified back
 * into it.
 *
 * The order of the checks is itself the decision, and it is the order below:
 *
 * ```text
 * decode base64 -> JSON -> an event shape        <- malformed, and the only invalid_request here
 * verify id and signature                        <- the primitive
 * require kind 27235
 * require |now - created_at| within the window   <- both directions, unlike the library's
 * require the u tag equals the absolute URL      <- built from the external base URL, not Fastify's
 * require the method tag equals the method
 * require the payload tag hashes the body        <- only when the request carries one
 * ```
 *
 * Nothing here throws, nothing here touches the database, and nothing here knows a User exists.
 * Whether the author was granted anything is `grants.ts`'s question and is asked after all seven
 * pass, which is what keeps the two disclosure rules apart: every refusal below names its own
 * reason, and an author nobody granted names none.
 */

import { createHash } from "node:crypto";
import type { Event } from "nostr-tools/core";
import { verifyEvent } from "nostr-tools/pure";

/** NIP-98's HTTP authentication event, which is the only kind this component accepts. */
export const httpAuthKind = 27235;

/** The HTTP authentication scheme NIP-98 names, as one token with no parameters in it. */
export const nostrScheme = "Nostr";

/** What one request has to agree with, assembled by the component before this runs. */
export type Expectation = {
  /**
   * The absolute URL the client should have signed, built from the external base URL the component
   * was constructed with and never from what Fastify saw.
   */
  readonly url: string;
  /** The request's method, in any case: the comparison folds both sides. */
  readonly method: string;
  /**
   * The body Fastify parsed, or `undefined` for a request that carried none.
   *
   * A request with a body must carry a matching `payload` tag. A request without one is not asked
   * for a tag, which is NIP-98's own shape: the tag is optional and the hash is of the body.
   */
  readonly body: unknown;
  /** This instant in milliseconds, taken by the caller so that a test needs no clock moved. */
  readonly now: number;
  /** How far either side of `now` a `created_at` may sit, in milliseconds. */
  readonly windowMs: number;
};

/**
 * A checked credential, or why not.
 *
 * A result and not an exception, because the caller turns every arm of it into an outcome the
 * server understands, and because a thrown error on this path would be a 500 for a request that
 * merely presented a bad credential.
 */
export type Checked =
  | {
      readonly ok: true;
      /** The author, in lowercase hex, which the signature is what makes trustworthy. */
      readonly pubkey: string;
      /** The event's own id, which is the hash of everything signed and the replay key. */
      readonly eventId: string;
    }
  | {
      readonly ok: false;
      /** `invalid_request` for a credential that did not decode, `invalid_token` for the rest. */
      readonly code: "invalid_request" | "invalid_token";
      /** One sentence about the mechanics, for the log and never for the wire. */
      readonly reason: string;
    };

/**
 * Checks one `Authorization: Nostr <base64>` credential against what the request actually is.
 *
 * `token` is the base64 that followed the scheme, with the scheme and the spaces already off.
 */
export function checkNip98(token: string, expected: Expectation): Checked {
  const event = decodeEvent(token);
  if (event === undefined) {
    return { ok: false, code: "invalid_request", reason: "the credential is not a base64 event" };
  }

  // The primitive, and the only cryptography in this file. It recomputes the event id from the
  // serialized event and checks the Schnorr signature over it, so everything read below is bound
  // to the author's key and the id is a name for exactly these bytes.
  if (!verifyEvent(event)) {
    return { ok: false, code: "invalid_token", reason: "the event's signature did not verify" };
  }

  if (event.kind !== httpAuthKind) {
    return { ok: false, code: "invalid_token", reason: `the event is kind ${event.kind}` };
  }

  // Both directions, which is the whole reason this file exists. `Math.abs` is the check the
  // library's subtraction leaves out, and a future `created_at` is refused here rather than
  // accepted forever.
  const age = expected.now - event.created_at * 1000;
  if (Math.abs(age) > expected.windowMs) {
    const side = age > 0 ? "old" : "far in the future";
    return {
      ok: false,
      code: "invalid_token",
      reason: `the event is ${Math.round(Math.abs(age) / 1000)} seconds ${side}`,
    };
  }

  const url = tagValue(event, "u");
  if (url === undefined || !sameUrl(url, expected.url)) {
    // The likeliest first-run failure of the whole component, and the reason the base URL is a
    // construction option: behind a proxy, what the client signed and what Fastify saw differ.
    return {
      ok: false,
      code: "invalid_token",
      reason: `the event names ${url ?? "no URL"} and this request is ${expected.url}`,
    };
  }

  const method = tagValue(event, "method");
  if (method === undefined || method.toUpperCase() !== expected.method.toUpperCase()) {
    return {
      ok: false,
      code: "invalid_token",
      reason: `the event names method ${method ?? "nothing"} and this request is ${expected.method}`,
    };
  }

  if (expected.body !== undefined && expected.body !== null) {
    const payload = tagValue(event, "payload");
    if (payload !== hashBody(expected.body)) {
      return {
        ok: false,
        code: "invalid_token",
        reason: "the event's payload tag is not the hash of this request's body",
      };
    }
  }

  return { ok: true, pubkey: event.pubkey, eventId: event.id };
}

/**
 * The event a credential carries, or `undefined` for every way it can fail to be one.
 *
 * One answer for base64 that does not decode, bytes that are not UTF-8 JSON, and JSON that is not
 * an event, because the caller does the same thing with all three.
 */
function decodeEvent(token: string): Event | undefined {
  let parsed: unknown;
  try {
    // `base64` and not `base64url`: NIP-98 says base64, and Node's decoder accepts either
    // alphabet, so a client that sent the URL-safe spelling is read rather than refused.
    parsed = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  return isEventShaped(parsed) ? parsed : undefined;
}

/**
 * Whether a decoded object has the seven fields `verifyEvent` and the checks above read.
 *
 * Written out rather than trusted, because a credential is attacker-controlled JSON: a `tags` that
 * is a string would make the tag search a character scan, and a `kind` that is a string would fail
 * the comparison for the wrong reason. `verifyEvent` catches its own throw and answers `false`, so
 * without this a malformed credential would be reported as a signature that did not verify.
 */
function isEventShaped(value: unknown): value is Event {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.sig === "string" &&
    typeof event.kind === "number" &&
    typeof event.content === "string" &&
    typeof event.created_at === "number" &&
    Array.isArray(event.tags) &&
    event.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))
  );
}

/** The first value of the first tag with this name, or `undefined` when there is none. */
function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/**
 * Whether two absolute URLs name the same call.
 *
 * Compared as parsed URLs rather than as strings, so a client that wrote the default port, upper
 * case in the host or a percent-encoding of its own is not refused over spelling. The path and the
 * query stay case-sensitive, because they are.
 */
function sameUrl(presented: string, expected: string): boolean {
  try {
    return new URL(presented).href === new URL(expected).href;
  } catch {
    return false;
  }
}

/**
 * The hash NIP-98's `payload` tag carries: SHA-256 of the request body, hex encoded.
 *
 * **The body Fastify parsed is what is hashed, re-serialized**, which is what `nostr-tools`' own
 * `getToken` hashes on the other side of the wire. Hashing the raw bytes would be the literal
 * reading of the NIP, and it is unreachable here: `authenticate` runs in a `preHandler`, long
 * after the body was parsed and the bytes were dropped, and keeping them would mean replacing the
 * server's content type parser from inside a component that registers no route. What the
 * comparison binds is therefore what the handler will act on rather than what arrived, which is
 * the more useful of the two and is not the same claim. The cost is real and is a client's to
 * notice: a body whose spelling does not survive a JSON round trip, such as one with duplicate
 * keys or with numbers written in a form the serializer does not reproduce, hashes to something
 * else and is refused.
 *
 * A string body is hashed as it stands, there being nothing to re-serialize.
 */
function hashBody(body: unknown): string {
  const bytes = typeof body === "string" ? body : JSON.stringify(body);
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
