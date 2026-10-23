import type { Db, Handle } from "../db/index.ts";
import type { Auth, AuthOutcome } from "../gateway/auth.ts";
import type { UserRecord } from "../users/routes.ts";
import type { Users } from "../users/users.ts";
import { admitEvent, insertGrant, selectGrantFor } from "./grants.ts";
import { checkNip98, nostrScheme } from "./nip98.ts";
import { nostrAuthTables } from "./schema/index.ts";

const defaultWindowMs = 60_000;

export type NostrAuthOptions = {
  readonly db: Db;
  readonly users: Users;
  readonly publicServer: {
    registerAuth(auth: Auth): void;
  };
  /** Public URL prefix used to verify signed request URLs. Include any reverse proxy path prefix. */
  readonly externalBaseUrl: string;
  /** Maximum clock difference in either direction, in milliseconds; defaults to 60,000. */
  readonly windowMs?: number;
};

export type NostrAuth = Auth & {
  /**
   * Grants a lowercase, 64-character hex key permission to authenticate as an existing user.
   * A user may have several keys; a key belongs to one user. Duplicate grants throw.
   * This does not configure Nostr channel delivery.
   */
  recordPublicKey<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    publicKey: string,
  ): Promise<void>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

export function createNostrAuth(options: NostrAuthOptions): NostrAuth {
  const handle = options.db.handle(nostrAuthTables);
  const baseUrl = checkedBaseUrl(options.externalBaseUrl);
  const windowMs = checkedWindow(options.windowMs ?? defaultWindowMs);

  const auth: NostrAuth = {
    scheme: nostrScheme,

    async authenticate(request): Promise<AuthOutcome> {
      const header = request.headers.authorization;
      if (!namesNostr(header)) return { kind: "absent" };

      const presented = presentedToken(header);
      if (presented === undefined) {
        return {
          kind: "refused",
          code: "invalid_request",
          detail: "Missing event after Nostr in the Authorization header",
        };
      }

      const checked = checkNip98(presented, {
        url: `${baseUrl}${request.url}`,
        method: request.method,
        body: request.body,
        now: Date.now(),
        windowMs,
      });
      if (!checked.ok) {
        return { kind: "refused", code: checked.code, detail: checked.reason };
      }

      const user = await userForKey(handle, options.users, checked.pubkey);
      if (user === undefined) return { kind: "refused", code: "invalid_token" };

      const fresh = await options.db.tx((tx) => admitEvent(tx, checked.eventId, windowMs));
      if (!fresh) {
        return {
          kind: "refused",
          code: "invalid_token",
          detail: "NIP-98 event already used. Sign a new event for each request.",
        };
      }

      return { kind: "authenticated", user };
    },

    recordPublicKey: (tx, userId, publicKey) => insertGrant(tx, userId, publicKey),

    start: async () => {},
    stop: async () => {},
  };

  options.publicServer.registerAuth(auth);

  return auth;
}

async function userForKey(
  handle: Handle<typeof nostrAuthTables>,
  directory: Users,
  publicKey: string,
): Promise<UserRecord | undefined> {
  const granted = await selectGrantFor(handle, publicKey);
  return granted === undefined ? undefined : directory.get(granted);
}

function namesNostr(header: string | undefined): header is string {
  return header !== undefined && /^nostr(\s|$)/i.test(header);
}

function presentedToken(header: string): string | undefined {
  const presented = header.slice(nostrScheme.length).trim();
  return presented.length === 0 || /\s/.test(presented) ? undefined : presented;
}

function checkedBaseUrl(externalBaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(externalBaseUrl);
  } catch {
    throw new Error(
      `externalBaseUrl must be an absolute URL; received ${JSON.stringify(externalBaseUrl)}`,
    );
  }
  return parsed.href.replace(/\/+$/, "");
}

function checkedWindow(windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(
      `windowMs must be a finite, positive number of milliseconds; received ${windowMs}`,
    );
  }
  return windowMs;
}
