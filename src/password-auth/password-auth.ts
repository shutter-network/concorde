/**
 * **The three capabilities that escalate are methods and never routes**, and that is as true here
 * as it was where this code came from
 * ([ADR-0029](../../docs/adr/0029-users-are-a-part-of-their-own.md),
 * [ADR-0052](../../docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)).
 * Trusted code holds the returned object; the Agent server is a surface an injected prompt reaches
 * ([ADR-0003](../../docs/adr/0003-prompt-injection-is-an-accepted-risk.md)). So replacing a
 * password, minting a Token and revoking have no route anywhere, and this component registers
 * nothing on the Agent server at all.
 *
 * **This is not a Producer.** It emits no Signals and takes no reference to the Signal Worker. A
 * Signal on login is refused rather than merely omitted: the worker is globally serial
 * ([ADR-0012](../../docs/adr/0012-the-gateway-is-a-serial-signal-worker.md)), so a Signal per
 * login turns any authentication burst into a Run queue that starves every real Signal behind it.
 *
 * Three orderings below are load-bearing. `logIn` derives unconditionally, against a fixed dummy
 * digest when there is nothing to verify against, so a miss costs what a hit costs and the
 * response time answers nothing the body refused to. Do not fold those lines into an early
 * return. `issueToken` and `setPassword` read the User on the **caller's** handle rather than on
 * this component's own, which is what lets one transaction create a User and give them a
 * credential. And `insertToken` is the one place a Token row is written: a Token bought with a
 * password and one minted by an Operator's OIDC callback have to stay the same row, or something
 * downstream eventually learns to tell them apart.
 *
 * **`authenticate` runs two statements where the code it replaces ran one.** The Users component
 * joined its own `tokens` to its own `users`; the two tables are in different schemas now, and the
 * record an outcome carries is Users' to answer with rather than this component's to assemble out
 * of columns it does not own (ADR-0052). The second read is `users.get`, which is why this
 * component takes the whole Users component and not a hook.
 *
 * The registration is the **last** thing the constructor does, after the routes are queued. An
 * Auth that registered first and then threw would leave a server accepting a scheme nothing can
 * answer for.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Db, Handle } from "../db/index.ts";
import type { Auth, AuthOutcome } from "../gateway/auth.ts";
import type { UserRecord } from "../users/routes.ts";
import { users } from "../users/schema.ts";
import type { Users } from "../users/users.ts";
import {
  type Credentials,
  type IssuedToken,
  namesBearer,
  type PasswordChange,
  passwordRoutes,
  presentedToken,
} from "./routes.ts";
import { passwords, tables, tokens } from "./schema.ts";
import {
  checkedScryptParameters,
  defaultScryptParameters,
  hashPassword,
  hashToken,
  mintToken,
  type ScryptParameters,
  verifyPassword,
} from "./secrets.ts";

type PasswordAuthHandle = Handle<typeof tables>;

// Where the constructor puts its route group. A constant and not an option, so a client written
// for one deployment's login works against every other one.
const authPrefix = "/auth";

// One token, with no space and no parameters in it: the server writes the challenge around it.
const bearerScheme = "Bearer";

export type PasswordAuthOptions = {
  readonly db: Db;
  /**
   * Answers with the User record an authenticated request names, and with nothing else.
   *
   * An Auth reports a User rather than an id, because the server that walks the Auths is built
   * before any component and can resolve nothing itself. Construct Users first.
   */
  readonly users: Users;
  /**
   * Where the four routes go, at `/auth`, and the server this registers itself with as an Auth.
   *
   * Both acts happen in the constructor, so an entry point performs no wiring. Registration order
   * is the order the server asks the schemes in, and it is the order they are named in a 401.
   *
   * The three routes that act as somebody take this server's own `requireUser`, so a deployment
   * running a second scheme can change a password over that scheme too.
   *
   * Structural: anything carrying a Fastify instance, a `registerAuth` and a `requireUser`
   * satisfies it, which is what `serverComponent` answers with.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
    registerAuth(auth: Auth): void;
    readonly requireUser: preHandlerAsyncHookHandler;
  };
  /**
   * How long an issued Token lives, in milliseconds.
   *
   * No default. A long lifetime means fewer logins and a longer window for a stolen Token, and
   * only the deployment knows which side of that trade it is on.
   *
   * It is not per-Token: every Token this component issues gets this lifetime, and one that never
   * expires is unrepresentable.
   */
  readonly tokenTtl: number;
  /**
   * What a password derivation costs. Defaults to OWASP's 32 MiB row, around 200ms of one core.
   *
   * Old digests do not follow it. Each digest carries the parameters it was written under and
   * verifies at those, so raising this leaves every stored password working and there is no rehash
   * on login. The cost is paid on every login, and nothing here rate limits one.
   */
  readonly scrypt?: ScryptParameters;
};

/**
 * The Password Auth component as an Auth: one route group, one `authenticate`, and a programmatic
 * API.
 *
 * It keeps a scrypt digest of each User's password and one row per issued Token. A User who has no
 * password has no row rather than an empty one. A Token's plaintext exists once, in the response
 * that issued it, so nothing here answers with one afterwards.
 *
 * `authenticate` reads `Authorization: Bearer <token>`. A request with no such header carries
 * nothing of this scheme, and the server asks the next Auth. A Token that is unknown or expired is
 * refused, and so is a wrong password at the login route: those two and an id nobody holds are one
 * answer, so nothing here reports who exists.
 *
 * Every write in the programmatic API takes the caller's transaction as its first argument and
 * every read takes none, so a read cannot see the caller's own uncommitted write. That is why
 * `issueToken` answers with what it wrote.
 *
 * Nothing is notified when a User logs in, changes a password or is revoked. No Signal is emitted
 * and no Handler wakes, so a deployment that wants one emits it itself inside the same transaction.
 *
 * `start` and `stop` do nothing. A Token outlives a shutdown, being a row and the database's own
 * clock, and nothing reaps an expired one.
 */
export type PasswordAuth = Auth & {
  /**
   * Replaces a User's password, proving nothing: the whole of account recovery here.
   *
   * An Operator sets a new password from their own code, having established out of band that it is
   * right. It also gives a password to a User who had none, which is the only way a User gets a
   * first one. `PUT /auth/password` is the self-service route, and that one wants the current
   * password.
   *
   * It revokes nothing, so to lock somebody out, replace the password and then call
   * {@link PasswordAuth.revoke}, in that order. There is no bound on the length here: the empty
   * string stores like any other and leaves a User who cannot log in. It reads the User on the
   * caller's transaction, so one transaction can create a User and give them a password. It throws
   * when no User has that id.
   */
  setPassword<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    user: string,
    password: string,
  ): Promise<void>;

  /**
   * Issues a Token to a User who presented nothing, and answers what a login answers.
   *
   * This is how a deployment adds a login of its own without writing an Auth. Write a route on the
   * Public server, establish identity however you like, and call this. What comes back is an
   * ordinary Token, and nothing downstream can tell how it was obtained.
   *
   * The User needs no password, and their Token is not a lesser Token. It reads on the caller's
   * transaction, so one transaction can create a User and hand them a Token. It throws when no
   * User has that id.
   */
  issueToken<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    user: string,
  ): Promise<IssuedToken>;

  /**
   * Revokes every Token of one User, so that none of them works again.
   *
   * The revocation `DELETE /auth/tokens` performs, reachable without HTTP. Nothing removes a User,
   * so this is the closest thing to shutting one out, and it is not close: they keep their
   * password, which mints a new Token, so replace that too.
   *
   * Idempotent, and it answers nothing, not even a count. The rows are deleted rather than marked,
   * which is the only compaction that table gets.
   */
  revoke<TSchema extends Record<string, unknown>>(tx: Handle<TSchema>, user: string): Promise<void>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

/**
 * Builds the Password Auth component, registers its route group at `/auth` on the Public server,
 * and registers itself with that server as an Auth.
 *
 * Nothing here connects, listens or applies DDL.
 *
 * @throws If `tokenTtl` is not a positive number of milliseconds.
 * @throws If a `scrypt` parameter is not a positive integer, or `logN` is above 20.
 */
export function createPasswordAuth(options: PasswordAuthOptions): PasswordAuth {
  // The component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(tables);
  const tokenTtl = checkedTokenTtl(options.tokenTtl);
  const parameters = checkedScryptParameters(options.scrypt ?? defaultScryptParameters);
  const dummy = dummyDigest(parameters);

  const auth: PasswordAuth = {
    scheme: bearerScheme,

    async authenticate(request): Promise<AuthOutcome> {
      const header = request.headers.authorization;
      // Not this scheme's request at all, so the server asks whatever is registered behind this.
      if (!namesBearer(header)) return { kind: "absent" };

      const presented = presentedToken(header);
      if (presented === undefined) {
        // It named this scheme and carried no credential. That is mechanics rather than
        // identity, so it may be told apart, and the detail reaches the log alone.
        return {
          kind: "refused",
          code: "invalid_request",
          detail: "the Authorization header named Bearer and carried no token after it",
        };
      }

      const user = await userForToken(handle, options.users, presented);
      // One answer for an unknown Token, an expired one and a Token whose User is gone. No
      // detail either: a sentence telling those apart in a log is a sentence somebody
      // eventually puts on the wire.
      return user === undefined
        ? { kind: "refused", code: "invalid_token" }
        : { kind: "authenticated", user };
    },

    setPassword: (tx, user, password) => writePassword(tx, user, password, parameters),
    issueToken: (tx, user) => grantToken(tx, user, tokenTtl),
    revoke: (tx, user) => deleteTokens(tx, user),

    // The two no-ops: membership in the Gateway's record, and nothing else.
    start: async () => {},
    stop: async () => {},
  };

  const routes = passwordRoutes(
    {
      logIn: (credentials) => logIn(handle, options.users, credentials, { dummy, tokenTtl }),
      // The route's revocations run on this component's own handle. One statement is atomic by
      // itself, and a request that revokes has nothing else to keep it with. The methods above
      // are where a caller with something to keep it with reaches the same statements.
      revokeToken: (token) => deleteToken(handle, token),
      revokeTokens: (user) => deleteTokens(handle, user),
      changePassword: (change) => changePassword(handle, change, parameters),
    },
    // The server's own composed hook, taken and not wrapped: this component authenticates a
    // request through the server that walks every scheme, including its own.
    options.publicServer.requireUser,
  );

  // The two acts of wiring, both here so that an Operator's entry point does neither. Not
  // awaited: Fastify defers a plugin until the server is ready. So this registration is made at
  // construction and loaded at `listen`. A server already listening refuses one.
  options.publicServer.fastify.register(routes, { prefix: authPrefix });
  // Last, for the reason in the file header.
  options.publicServer.registerAuth(auth);

  return auth;
}

// The User a presented Token names, or `undefined` for an unknown Token and an expired one alike.
// The lookup is by the hash, so the unique index does the comparison.
//
// The expiry is compared against the database's clock, which is the clock `expires_at` was written
// from, so a Token's lifetime does not depend on the drift between two machines. Nothing reaps the
// expired rows: they stop matching.
async function userForToken(
  handle: PasswordAuthHandle,
  directory: Users,
  token: string,
): Promise<UserRecord | undefined> {
  const [row] = await handle
    .select({ userId: tokens.userId })
    .from(tokens)
    .where(
      and(eq(tokens.tokenHash, hashToken(token)), gt(tokens.expiresAt, sql`clock_timestamp()`)),
    );
  return row === undefined ? undefined : directory.get(row.userId);
}

// A password traded for a Token, or `undefined` for every way it can fail. A User with no row here
// is verified against a fixed dummy digest, so the cost is the same either way. Do not reorder the
// lines below into an early return; see the file header.
async function logIn(
  handle: PasswordAuthHandle,
  directory: Users,
  credentials: Credentials,
  cost: { readonly dummy: () => Promise<string>; readonly tokenTtl: number },
): Promise<IssuedToken | undefined> {
  const [row] = await handle.select().from(passwords).where(eq(passwords.userId, credentials.user));
  const stored = row?.passwordHash ?? (await cost.dummy());
  const matched = await verifyPassword(stored, credentials.password);
  if (row === undefined || !matched) return undefined;

  // The row is there and the password verified, so the User exists: the foreign key says so.
  // Read anyway rather than asserted, because the record is what the response carries.
  const user = await directory.get(credentials.user);
  if (user === undefined) return undefined;

  // The same statement `issueToken` reaches. A Token bought with a password and one minted by an
  // OIDC callback are one row.
  return insertToken(handle, user, cost.tokenTtl);
}

// The row a Token is, and the one place it is written. See the file header for why it stays one.
async function insertToken<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: UserRecord,
  tokenTtl: number,
): Promise<IssuedToken> {
  const minted = mintToken();
  const [issued] = await handle
    .insert(tokens)
    .values({
      userId: user.id,
      tokenHash: minted.hash,
      // The database's clock and not this process's, because the comparison that refuses this
      // Token reads the database's too. `make_interval` takes seconds as a float, so a lifetime of
      // one millisecond is expressible. A test needs no clock moved.
      expiresAt: sql`clock_timestamp() + make_interval(secs => ${tokenTtl / 1000})`,
    })
    .returning({ expiresAt: tokens.expiresAt });
  if (issued === undefined) {
    throw new Error("issuing a Token inserted no row");
  }
  return { token: minted.token, expiresAt: issued.expiresAt.toISOString(), user };
}

// The only path that skips a password. The read is on the caller's handle rather than the
// component's own, so it sees that transaction's own uncommitted write and the record answered
// with is the record that transaction will commit, Attributes and all.
async function grantToken<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
  tokenTtl: number,
): Promise<IssuedToken> {
  return insertToken(handle, await userOnHandle(handle, user), tokenTtl);
}

// The password row, written or replaced. The User is read on the caller's handle first, so that
// "no such User" is an error naming the id rather than a foreign key violation naming a
// constraint. The write is an upsert because a User has one password and no history of them.
async function writePassword<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
  password: string,
  parameters: ScryptParameters,
): Promise<void> {
  await userOnHandle(handle, user);
  const passwordHash = await hashPassword(password, parameters);
  await handle
    .insert(passwords)
    .values({ userId: user, passwordHash })
    .onConflictDoUpdate({
      target: passwords.userId,
      set: { passwordHash, updatedAt: sql`clock_timestamp()` },
    });
}

// A password replaced by somebody who proved they know the current one, or `false`. A User with no
// row here cannot change one, having nothing to prove.
//
// Unlike `logIn`, this derives nothing when there is nothing to verify against: the caller has
// already been authenticated, so there is no enumeration to close.
async function changePassword(
  handle: PasswordAuthHandle,
  change: PasswordChange,
  parameters: ScryptParameters,
): Promise<boolean> {
  const [row] = await handle.select().from(passwords).where(eq(passwords.userId, change.user));
  if (row === undefined) return false;
  if (!(await verifyPassword(row.passwordHash, change.currentPassword))) return false;

  const passwordHash = await hashPassword(change.newPassword, parameters);
  await handle
    .update(passwords)
    .set({ passwordHash, updatedAt: sql`clock_timestamp()` })
    .where(eq(passwords.userId, change.user));
  return true;
}

// By the hash and not by the User, so logging out of one device leaves every other session
// working. The row is removed rather than flagged, so one lookup refuses a revoked Token and a
// Token that never existed and the two answer identically.
async function deleteToken(handle: PasswordAuthHandle, token: string): Promise<void> {
  await handle.delete(tokens).where(eq(tokens.tokenHash, hashToken(token)));
}

// The `password_auth_tokens_user_idx` index exists for this statement: PostgreSQL indexes the
// primary key and the unique `token_hash`, and neither is the referencing side this reads. The
// query-builder form, so the public `revoke` and the route can share one statement.
async function deleteTokens<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
): Promise<void> {
  await handle.delete(tokens).where(eq(tokens.userId, user));
}

// The User as this component's two writes need one: read on the caller's handle, so a User created
// in the caller's own uncommitted transaction is found. The message names the id, the caller being
// trusted code reading a stack trace.
async function userOnHandle<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
): Promise<UserRecord> {
  const [row] = await handle.select().from(users).where(eq(users.id, user));
  if (row === undefined) {
    throw new Error(`no User ${user} exists`);
  }
  return { id: row.id, attributes: row.attributes, createdAt: row.createdAt.toISOString() };
}

// The digest a login with nothing to verify against is verified against instead. Derived once,
// lazily, and at this component's own cost, so a miss costs what a hit costs. The password it is
// written from is 32 random bytes of this process's, so nobody can present it.
function dummyDigest(parameters: ScryptParameters): () => Promise<string> {
  let derived: Promise<string> | undefined;
  return () => (derived ??= hashPassword(mintToken().token, parameters));
}

// A lifetime that is not a positive number of milliseconds is a mistake, not a policy.
function checkedTokenTtl(tokenTtl: number): number {
  if (!Number.isFinite(tokenTtl) || tokenTtl <= 0) {
    throw new Error(`tokenTtl must be a positive number of milliseconds, not ${tokenTtl}`);
  }
  return tokenTtl;
}
