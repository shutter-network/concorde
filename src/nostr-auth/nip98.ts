import { createHash } from "node:crypto";
import type { Event } from "nostr-tools/core";
import { verifyEvent } from "nostr-tools/pure";

export const httpAuthKind = 27235;

export const nostrScheme = "Nostr";

export type Expectation = {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly now: number;
  readonly windowMs: number;
};

export type Checked =
  | {
      readonly ok: true;
      readonly pubkey: string;
      readonly eventId: string;
    }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "invalid_token";
      readonly reason: string;
    };

export function checkNip98(token: string, expected: Expectation): Checked {
  const event = decodeEvent(token);
  if (event === undefined) {
    return { ok: false, code: "invalid_request", reason: "the credential is not a base64 event" };
  }

  if (!verifyEvent(event)) {
    return { ok: false, code: "invalid_token", reason: "the event's signature did not verify" };
  }

  if (event.kind !== httpAuthKind) {
    return { ok: false, code: "invalid_token", reason: `the event is kind ${event.kind}` };
  }

  // Check future timestamps too; nip98.validateToken only rejects old events.
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

function decodeEvent(token: string): Event | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  return isEventShaped(parsed) ? parsed : undefined;
}

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

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function sameUrl(presented: string, expected: string): boolean {
  try {
    return new URL(presented).href === new URL(expected).href;
  } catch {
    return false;
  }
}

function hashBody(body: unknown): string {
  const bytes = typeof body === "string" ? body : JSON.stringify(body);
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
