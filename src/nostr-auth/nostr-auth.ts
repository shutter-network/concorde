/**
 * **The grant is a method and never a route**, and that is the same guard the Nostr Channel's
 * `recordPublicKey` carries ([ADR-0049](../../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md),
 * [ADR-0053](../../docs/adr/0053-nostr-auth-verifies-nip-98-per-request.md)). Recording a key hands
 * whoever holds it a User's whole identity over HTTP, so it sits with the writes an injected prompt
 * cannot reach ([ADR-0003](../../docs/adr/0003-prompt-injection-is-an-accepted-risk.md)). This
 * component registers **no route on either server**, and a route added here is the thing to refuse
 * in review, whatever it does.
 *
 * **Nothing here reads `saf_nostr_channel.pubkeys`.** The Channel's table says "the agent writes to
 * this key"; this one says "this key acts as this User". ADR-0048 refused a shared identity table
 * on the argument that an Authenticator would keep a copy, and it turns out not to be a copy: the
 * cardinalities are opposite and so are the directions. Making one read the other is the thing to
 * refuse in review after the route.
 *
 * **The order of the checks in `authenticate` is load-bearing and runs one way only.** Every
 * mechanical check in `nip98.ts` happens first, then the grant lookup, then the User read, and the
 * replay record last. Moving the replay record above the grant lookup would let a stranger with a
 * valid signature over a key nobody granted write a row per request, which is the one way this
 * table could be grown from outside. Moving the grant lookup above the mechanical checks would
 * spend a database read on a request that a `Math.abs` refuses.
 *
 * **Authentication over this scheme is a write.** A `GET` here inserts a row and deletes some,
 * where the same request under Password Auth is one indexed select. The asymmetry is real, it is
 * the price of a per-request credential nothing else can refuse twice, and it belongs in the
 * component's documentation rather than in a reader's surprise.
 *
 * The registration is the **last** thing the constructor does. An Auth that registered first and
 * then threw would leave a server accepting a scheme nothing can answer for.
 */

import type { Db, Handle } from "../db/index.ts";
import type { Auth, AuthOutcome } from "../gateway/auth.ts";
import type { UserRecord } from "../users/routes.ts";
import type { Users } from "../users/users.ts";
import { admitEvent, insertGrant, selectGrantFor } from "./grants.ts";
import { checkNip98, nostrScheme } from "./nip98.ts";
import { tables } from "./schema.ts";

// NIP-98's own window, in milliseconds, and the default `windowMs` takes.
const defaultWindowMs = 60_000;

export type NostrAuthOptions = {
  readonly db: Db;
  /**
   * Answers with the User record an authenticated request names, and with nothing else.
   *
   * An Auth reports a User rather than an id, because the server that walks the Auths is built
   * before any component and can resolve nothing itself. Construct Users first.
   */
  readonly users: Users;
  /**
   * The server this registers itself with as an Auth, and the only wiring the constructor does.
   *
   * Registration order is the order the server asks the schemes in, and it is the order they are
   * named in a 401. No route is registered on it, or on any other server.
   *
   * Structural: anything carrying a `registerAuth` satisfies it, which is what `serverComponent`
   * answers with.
   */
  readonly publicServer: {
    registerAuth(auth: Auth): void;
  };
  /**
   * The origin, and any path prefix, that clients reach this deployment at, such as
   * `https://agent.example.com` or `https://example.com/agent`.
   *
   * The `u` tag of every request is compared against this plus the path Fastify received, so it has
   * to be what the **client** typed and not what your reverse proxy forwarded. Behind a proxy the
   * two differ, and every request is refused with a reason that reaches your log and never the
   * client.
   *
   * A trailing slash is ignored. The scheme and host are compared case-insensitively and a default
   * port may be written or left out, because a URL says so; the path is compared exactly.
   */
  readonly externalBaseUrl: string;
  /**
   * How far either side of now an event's `created_at` may sit, in milliseconds. Defaults to
   * 60000, which is NIP-98's own window.
   *
   * Applied in **both** directions, so an event stamped in the future is refused rather than valid
   * forever. Raise it for clients whose clocks you do not control, and know that it is also how
   * long a captured request stays replayable against a Gateway that has forgotten it, and twice
   * how long a row lives in the replay record.
   */
  readonly windowMs?: number;
};

/**
 * The Nostr Auth component as an Auth: one `authenticate`, one grant, and no route.
 *
 * It keeps one row per granted public key and one row per admitted event. A person signs every
 * request with a Nostr key, so there is no login and nothing is issued: `authenticate` reads
 * `Authorization: Nostr <base64>`, checks the event by hand, and answers with the User the
 * Operator granted that key to. A request with no such header carries nothing of this scheme, and
 * the server asks the next Auth.
 *
 * Every mechanical failure is told apart and one refusal is not. A credential that does not
 * decode, a signature that does not verify, a wrong kind, an event outside the freshness window, a
 * `u` tag or a `method` that names a different call, a `payload` tag that is not the hash of the
 * body, and a credential that was presented before each reach the Logger the server was built
 * with, carrying their own reason. A key nobody granted is refused with the code alone, because a
 * reason would tell a stranger which keys are enrolled.
 *
 * **A request under this scheme is a write.** Every admitted event id is recorded, so that a
 * captured header cannot be sent twice, and the rows past the window are deleted in the same
 * transaction. The table therefore holds the last window's traffic rather than every request ever
 * made, and nothing has to be reaped, configured or remembered.
 *
 * **A credential is used once, and an event id is what "once" counts.** That id is the hash of the
 * event's fields and `created_at` counts whole seconds, so a client that signs the same URL and
 * method twice inside one second signs one event and is refused the second time. A client that
 * repeats a call adds a tag of its own to make the two events two, which NIP-98 leaves it free to
 * do and which is what every client that retries has to do anyway.
 *
 * `start` and `stop` do nothing. A grant is a row and survives a shutdown; so does the replay
 * record, which is what makes a restart no help to somebody holding a captured header.
 */
export type NostrAuth = Auth & {
  /**
   * Records that one Nostr public key may act as one User, and **proves nothing**.
   *
   * The Operator establishes out of band that the key is that person's, and this stores what they
   * decided. It is the whole of admission to this scheme, and deliberately the whole: no route on
   * either server records a key, so an injected prompt cannot grant itself a User's identity. The
   * cost is that nobody enrols themselves, and a deployment that wants a logged-in User to prove
   * control of a key writes that route itself out of this method.
   *
   * A User holds as many keys as they have signers, so recording a second key for the same User is
   * ordinary. A key already granted is refused rather than moved, because moving one silently is
   * how one person's key becomes another person's identity.
   *
   * A write, so it takes the caller's transaction first: the grant and whatever the Operator
   * records about it commit together or not at all. `publicKey` is 64 lowercase hex characters,
   * which is what a Nostr public key is on the wire, and an `npub` is not one.
   *
   * @throws If `publicKey` is not 64 lowercase hex characters.
   * @throws If no User has that id.
   * @throws If that key is already granted, to this User or to another. Every refusal here runs in
   *   a savepoint, so none of them aborts the caller's transaction.
   */
  recordPublicKey<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    publicKey: string,
  ): Promise<void>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

/**
 * Builds the Nostr Auth component and registers it with the Public server as an Auth.
 *
 * It registers no route, on that server or on any other. Nothing here connects, listens or applies
 * DDL.
 *
 * @throws If `externalBaseUrl` is not an absolute URL.
 * @throws If `windowMs` is not a positive number of milliseconds.
 */
export function createNostrAuth(options: NostrAuthOptions): NostrAuth {
  // The component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(tables);
  const baseUrl = checkedBaseUrl(options.externalBaseUrl);
  const windowMs = checkedWindow(options.windowMs ?? defaultWindowMs);

  const auth: NostrAuth = {
    scheme: nostrScheme,

    async authenticate(request): Promise<AuthOutcome> {
      const header = request.headers.authorization;
      // Not this scheme's request at all, so the server asks whatever is registered behind this.
      if (!namesNostr(header)) return { kind: "absent" };

      const presented = presentedToken(header);
      if (presented === undefined) {
        return {
          kind: "refused",
          code: "invalid_request",
          detail: "the Authorization header named Nostr and carried no event after it",
        };
      }

      // Every check the library either does not make or makes one-sidedly, in `nip98.ts`. The URL
      // is built from the base this component was told, so what a proxy rewrote is invisible here.
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

      // The first database read, and the one refusal that says nothing. A key nobody granted, a
      // User that is not there and a grant onto a User who has gone are one answer, because any
      // sentence telling them apart names who is enrolled here.
      const user = await userForKey(handle, options.users, checked.pubkey);
      if (user === undefined) return { kind: "refused", code: "invalid_token" };

      // Last, and only for a request that would otherwise be admitted: a stranger cannot reach
      // this line, so a stranger cannot grow the table.
      const fresh = await options.db.tx((tx) => admitEvent(tx, checked.eventId, windowMs));
      if (!fresh) {
        return {
          kind: "refused",
          code: "invalid_token",
          detail: "this event was presented before, and a NIP-98 credential is used once",
        };
      }

      return { kind: "authenticated", user };
    },

    recordPublicKey: (tx, userId, publicKey) => insertGrant(tx, userId, publicKey),

    // The two no-ops: membership in the Gateway's record, and nothing else.
    start: async () => {},
    stop: async () => {},
  };

  // The one act of wiring, so an Operator's entry point performs none. Last, for the reason in the
  // file header.
  options.publicServer.registerAuth(auth);

  return auth;
}

// The User a verified author acts as, or `undefined` for an ungranted key and a User that is not
// there alike. The lookup is by the primary key, so the index does the comparison.
async function userForKey(
  handle: Handle<typeof tables>,
  directory: Users,
  publicKey: string,
): Promise<UserRecord | undefined> {
  const granted = await selectGrantFor(handle, publicKey);
  return granted === undefined ? undefined : directory.get(granted);
}

// Whether the header names this scheme. RFC 7235 makes the name case-insensitive, and a client is
// not refused over spelling.
function namesNostr(header: string | undefined): header is string {
  return header !== undefined && /^nostr(\s|$)/i.test(header);
}

// What followed the scheme, or `undefined` when nothing did. The credential is one base64 token,
// so anything with a space in it is not one.
function presentedToken(header: string): string | undefined {
  const presented = header.slice(nostrScheme.length).trim();
  return presented.length === 0 || /\s/.test(presented) ? undefined : presented;
}

// The base URL as a prefix a request path is appended to: no trailing slash, so `/decisions`
// concatenates to one path rather than two. Parsed first, because a base URL with no scheme in it
// would otherwise make every `u` tag comparison fail with nothing saying why.
function checkedBaseUrl(externalBaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(externalBaseUrl);
  } catch {
    throw new Error(
      `externalBaseUrl must be an absolute URL such as https://agent.example.com, not ${JSON.stringify(externalBaseUrl)}`,
    );
  }
  return parsed.href.replace(/\/+$/, "");
}

// A window that is not a positive number of milliseconds is a mistake, not a policy.
function checkedWindow(windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`windowMs must be a positive number of milliseconds, not ${windowMs}`);
  }
  return windowMs;
}
