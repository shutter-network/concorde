/**
 * **The three capabilities that escalate are methods and never routes**, and that is the whole
 * shape of this file ([ADR-0029](../../docs/adr/0029-users-are-a-part-of-their-own.md)). Trusted
 * code holds the returned object; the Agent server is a surface an injected prompt reaches
 * ([ADR-0003](../../docs/adr/0003-prompt-injection-is-an-accepted-risk.md)). So setting
 * Attributes, replacing a password and issuing a Token have no route anywhere, and promoting one
 * to a route is the thing to refuse in review.
 *
 * **This is not a Producer.** It emits no Signals and takes no reference to the Signal Worker. A
 * Signal on login is refused rather than merely omitted: the worker is globally serial
 * ([ADR-0012](../../docs/adr/0012-the-gateway-is-a-serial-signal-worker.md)), so a Signal per
 * login turns any authentication burst into a Run queue that starves every real Signal behind it.
 * A deployment that wants one emits it itself, atomically, because writes take the transaction
 * first ([ADR-0023](../../docs/adr/0023-cross-component-writes-take-an-explicit-transaction.md)).
 *
 * Three orderings below are load-bearing. `logIn` derives unconditionally, against a fixed dummy
 * digest when there is nothing to verify against, so a miss costs what a hit costs and the
 * response time answers nothing the body refused to. Do not fold those lines into an early
 * return. `updateUser` uses `returning` so that "no such User" is distinct from "nothing to
 * change", which is why it throws where `deleteTokens` says nothing: an id with a typo in it would
 * otherwise be a permission quietly not given. And `grantToken` reads on the *caller's* handle
 * rather than the component's own, which is what lets one transaction create a User and issue them
 * a Token.
 *
 * `insertToken` is the one place a Token row is written. A Token bought with a password and one
 * minted by an Operator's OIDC callback have to stay the same row, or something downstream
 * eventually learns to tell them apart.
 *
 * **`requireUser` is scaffolding, and `.scratch/auth/issues/03-*` deletes it.** The credential is
 * the Password Auth component's now
 * ([ADR-0052](../../docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)),
 * and Signatures, Decisions and the HTTP Channel still take this hook off this component. So it
 * asks the Public server's aggregate first, which is where a Password Auth Token is verified, and
 * falls back to the Token lookup below when that server has no Auth registered, which is every
 * deployment still running this component's own login, and there is no third case. `logIn`,
 * `GET /me` and both revocations keep the lookup outright and are not routed through the
 * aggregate, so this component's own surface behaves the same whatever is registered with the
 * server it is on. Ticket 03 moves the three dependents onto `publicServer.requireUser` and takes
 * the whole of this with it: the member, the fallback, the `requireUser` in `UsersOptions`, and
 * the import of the error class the fallback branches on.
 */

import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import type { Db, Handle } from "../db/index.ts";
import { NoAuthRegisteredError } from "../gateway/auth.ts";
import type { Component } from "../gateway/components.ts";
import { limitSchema } from "../route-conventions.ts";
import {
  agentUserRoutes,
  type Credentials,
  type IssuedToken,
  type PasswordChange,
  publicUserRoutes,
  requireUser,
  type UserRecord,
} from "./routes.ts";
import { tokens, users, usersTables } from "./schema.ts";
import {
  checkedScryptParameters,
  defaultScryptParameters,
  hashPassword,
  hashToken,
  mintToken,
  type ScryptParameters,
  verifyPassword,
} from "./secrets.ts";

type UsersHandle = Handle<typeof usersTables>;

export type UsersOptions = {
  readonly db: Db;
  /**
   * How long an issued Token lives, in milliseconds.
   *
   * No default. A long lifetime means fewer logins and a longer window for a stolen Token, and
   * only the deployment knows which side of that trade it is on.
   *
   * It is not per-Token: every Token this Gateway issues gets this lifetime, and one that never
   * expires is unrepresentable.
   */
  readonly tokenTtl: number;
  /**
   * The Agent server, if the agent is to create and read Users.
   *
   * Given one, the constructor registers `agentRoutes` on it under `/users`: `POST /users`,
   * `GET /users` and `GET /users/:id`. Omit it and nothing is registered anywhere, which is how
   * the agent's ability to create a User is denied. There is no flag and no route to guard.
   *
   * Structural: anything carrying a Fastify instance satisfies it. A server built on http2 does
   * not, and takes `agentRoutes` instead.
   */
  readonly agentServer?: {
    readonly fastify: FastifyInstance;
  };
  /**
   * The Public server, if Users are to trade a password for a Token.
   *
   * Given one, the constructor registers `publicRoutes` on it under `/auth`, which is where
   * `POST /auth/tokens` comes from.
   *
   * Omit it to replace this password login with a scheme of your own, which can be an Auth, OIDC,
   * a wallet signature or a corporate header. `issueToken` is a method, so that scheme still mints
   * ordinary Tokens and nothing else about this component changes.
   *
   * Structural, on the same terms as `agentServer`.
   */
  readonly publicServer?: {
    readonly fastify: FastifyInstance;
    /**
     * The schemes that server accepts, composed, which is what {@link Users.requireUser} asks
     * before it reads a Token of its own.
     *
     * Optional so that a bare Fastify instance still satisfies this option. A server that carries
     * one and has an Auth registered is a deployment whose credentials are somebody else's, and
     * this component then verifies none of them.
     */
    readonly requireUser?: preHandlerAsyncHookHandler;
  };
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
 * The Users component as a Component: two route plugins, one hook, and a programmatic API.
 *
 * It keeps a User's Attributes and a scrypt digest of their password, and one row per issued
 * Token. A Token's plaintext exists once, in the response that issued it, so nothing here answers
 * with one afterwards. Nothing removes a User either: `revoke` is the closest thing to shutting
 * one out.
 *
 * Setting Attributes, replacing a password and issuing a Token are in the programmatic API and have
 * no route anywhere. The Agent server is the surface an injected prompt reaches, so the three
 * capabilities that escalate are not there to reach.
 *
 * Every write takes the caller's transaction as its first argument and every read takes none, so a
 * read cannot see the caller's own uncommitted write. That is why `create` and `issueToken` answer
 * with what they wrote.
 *
 * Nothing is notified when a User is created, logs in or is revoked. No Signal is emitted and no
 * Handler wakes, so a deployment that wants one emits it itself inside the same transaction.
 *
 * `start` and `stop` do nothing. A Token outlives a shutdown, being a row and the database's own
 * clock, and nothing reaps an expired one.
 */
export type Users = Component & {
  /**
   * The Agent server routes as a Fastify plugin: create a User, read Users.
   *
   * For an Operator who wants them somewhere other than where `agentServer` puts them. The plugin
   * carries no prefix of its own, so register it under a prefix of yours, inside your own
   * encapsulated plugin, or behind your own hook.
   *
   * Passing no Agent server and never registering this is how the capability is switched off.
   */
  readonly agentRoutes: FastifyPluginAsync;

  /**
   * The Public server routes as a Fastify plugin: the login, and the four routes around it.
   *
   * The same prefix story `agentRoutes` carries. `/auth` is what the constructor uses, and
   * `POST /auth/tokens` is where the login goes.
   *
   * Registering neither this plugin nor a Public server is how a deployment replaces this login
   * with its own. That scheme mints ordinary Tokens through `issueToken`, and there is no
   * interface to implement.
   */
  readonly publicRoutes: FastifyPluginAsync;

  /**
   * The preHandler that requires an authenticated User, as one option on any route.
   *
   * **Temporary, and it will be removed.** Authentication is an Auth's and the composition of the
   * Auths is the Public server's, so a protected route takes `publicServer.requireUser` and this
   * member exists only until the components that still read it here have been moved onto that one.
   * Write new routes against the server.
   *
   * It asks the Public server this component was given, so a Token any registered Auth accepts
   * authenticates the route. With no Auth registered there, and with no Public server at all, it
   * reads the `Authorization: Bearer …` header and verifies a Token of this component's own
   * instead. Either way the User is assigned to `request.safUser`, or the single 401 that every
   * authentication failure gets is answered.
   *
   * A hook rather than a plugin, so it works on either server, inside any plugin, at any depth.
   * Nothing is protected by default, and a route that does not take it reads `request.safUser` as
   * `undefined` despite the type.
   */
  readonly requireUser: preHandlerAsyncHookHandler;

  /**
   * Creates a User with no Attributes and no password, and answers with the record.
   *
   * Takes the caller's transaction, so admitting a User and writing the Operator's own rows cannot
   * come apart: a rollback loses both. The record comes back from here because a read cannot see
   * that uncommitted write.
   *
   * It accepts no id. A User has no natural key, so "create this User if absent" is not
   * expressible and seeding the first one is the Operator's own job, out of band and once.
   */
  create<TSchema extends Record<string, unknown>>(tx: Handle<TSchema>): Promise<UserRecord>;

  /**
   * Replaces a User's Attributes, wholesale, and throws when no User has that id.
   *
   * This is where authorization lives, and the agent cannot reach it: `POST /users` has no
   * parameter for an attribute, so an injected prompt cannot mint a privileged User.
   *
   * Wholesale rather than a merge, because a merge cannot express removal. A merge is one line on
   * top of this: read, spread, set.
   */
  setAttributes<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    user: string,
    attributes: unknown,
  ): Promise<void>;

  /**
   * Replaces a User's password, proving nothing: the whole of account recovery here.
   *
   * An Operator sets a new password from their own code, having established out of band that it is
   * right. It also gives a password to a User who had none. `PUT /auth/password` is the
   * self-service route, and that one wants the current password.
   *
   * It revokes nothing, so to lock somebody out, replace the password and then call `revoke`, in
   * that order. There is no bound on the length here: the empty string stores like any other and
   * leaves a User who cannot log in. It throws when no User has that id.
   */
  setPassword<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    user: string,
    password: string,
  ): Promise<void>;

  /**
   * Issues a Token to a User who presented nothing, and answers what a login answers.
   *
   * This is how a deployment adds a login of its own. Write a route on the Public server,
   * establish identity however you like, and call this. What comes back is an ordinary Token, and
   * nothing downstream can tell how it was obtained.
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

  /**
   * One User by id, or `undefined`.
   *
   * A read, so it takes no transaction and cannot see the caller's own uncommitted write. `create`
   * answers with the User for that reason.
   */
  get(id: string): Promise<UserRecord | undefined>;

  /**
   * Users, newest first, limited.
   *
   * A read, with the same consequence `get` carries. `limit` takes the routes' default when
   * omitted and is not capped here: a cap is there to bound a response body the agent reads, and
   * this is not that.
   */
  list(options?: { readonly limit?: number }): Promise<UserRecord[]>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

/**
 * Builds the Users component and registers its route groups on whichever servers it is given.
 *
 * Nothing here connects, listens or applies DDL.
 *
 * @throws If `tokenTtl` is not a positive number of milliseconds.
 * @throws If a `scrypt` parameter is not a positive integer, or `logN` is above 20.
 */
export function createUsers(options: UsersOptions): Users {
  // The component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(usersTables);
  const tokenTtl = checkedTokenTtl(options.tokenTtl);
  const parameters = checkedScryptParameters(options.scrypt ?? defaultScryptParameters);
  const dummy = dummyDigest(parameters);
  // This component's own hook, which its own Public routes take directly. See the file header.
  const presentedUser = requireUser({ authenticate: (token) => userForToken(handle, token) });
  // And the scaffolding the three dependents still take, which ticket 03 deletes whole.
  const throughTheServer = forwarding(options.publicServer?.requireUser, presentedUser);

  const agentRoutes = agentUserRoutes({
    // The route's create runs on the component's own handle. One insert is atomic by itself, and
    // a request that creates a User has nothing else to keep it with.
    create: ({ password }) => insertUser(handle, password, parameters),
    get: (id) => selectUser(handle, id),
    list: ({ limit }) => selectUsers(handle, limit),
  });

  const publicRoutes = publicUserRoutes(
    {
      logIn: (credentials) => logIn(handle, credentials, { dummy, tokenTtl }),
      // The route's revocations run on the component's own handle, for the reason its create
      // does. The method below is where a caller with something to keep it with reaches the
      // same statement.
      revokeToken: (token) => deleteToken(handle, token),
      revokeTokens: (user) => deleteTokens(handle, user),
      changePassword: (change) => changePassword(handle, change, parameters),
    },
    presentedUser,
  );

  // The two acts of wiring, both of them here so that an Operator's entry point does neither.
  // Not awaited: Fastify defers a plugin until the server is ready. So this registration is made
  // at construction and loaded at `listen`. A server already listening refuses one. A server not
  // passed is a route group that does not exist.
  options.agentServer?.fastify.register(agentRoutes, { prefix: "/users" });
  options.publicServer?.fastify.register(publicRoutes, { prefix: "/auth" });

  return {
    agentRoutes,

    publicRoutes,

    requireUser: throughTheServer,

    create: (tx) => insertUser(tx, undefined, parameters),
    setAttributes: (tx, user, attributes) => updateUser(tx, user, { attributes }),
    setPassword: async (tx, user, password) =>
      updateUser(tx, user, { passwordHash: await hashPassword(password, parameters) }),
    issueToken: (tx, user) => grantToken(tx, user, tokenTtl),
    revoke: (tx, user) => deleteTokens(tx, user),
    get: (id) => selectUser(handle, id),
    list: (asked) => selectUsers(handle, asked?.limit ?? limitSchema.default),

    // The two no-ops, whose reason is on the type above: membership in the Gateway's record,
    // and nothing else.
    start: async () => {},
    stop: async () => {},
  };
}

// The scaffolding named in the file header, and the whole of it. Ticket 03 deletes this function,
// its call site, and the import of the error class it branches on.
//
// The server's aggregate throws before it has read the request or touched the reply, so catching
// that one class and running the old hook after it costs a request nothing and cannot answer
// twice. Any other failure is a failure and is rethrown. Called with `request.server` because a
// Fastify hook is declared with a `this` of the instance, and neither of these two reads it.
function forwarding(
  aggregate: preHandlerAsyncHookHandler | undefined,
  ownTokens: preHandlerAsyncHookHandler,
): preHandlerAsyncHookHandler {
  if (aggregate === undefined) return ownTokens;
  return async (request, reply) => {
    try {
      return await aggregate.call(request.server, request, reply);
    } catch (failure) {
      if (!(failure instanceof NoAuthRegisteredError)) throw failure;
      return ownTokens.call(request.server, request, reply);
    }
  };
}

// One value and no other could be taken here. Every remaining column of a new User is the
// database's default, so nothing on this path can carry an attribute. The query-builder form, so
// it works on a transaction carrying any component's schema.
//
// The derivation runs before the insert, inside the caller's transaction, which holds that
// transaction open for as long as scrypt takes.
async function insertUser<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  password: string | undefined,
  parameters: ScryptParameters,
): Promise<UserRecord> {
  const passwordHash = password === undefined ? null : await hashPassword(password, parameters);
  const [inserted] = await handle.insert(users).values({ passwordHash }).returning();
  if (inserted === undefined) {
    throw new Error("creating a User inserted no row");
  }
  return asUserRecord(inserted);
}

// The one update statement behind both things trusted code may change about a User. One function
// and not two, because the two differ only in which column they name. For why it `returning`s and
// throws, see the file header. The message names the id, the caller being trusted code reading a
// stack trace.
async function updateUser<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
  columns: { readonly attributes: unknown } | { readonly passwordHash: string },
): Promise<void> {
  const updated = await handle
    .update(users)
    .set(columns)
    .where(eq(users.id, user))
    .returning({ id: users.id });
  if (updated.length === 0) {
    throw new Error(`no User ${user} exists`);
  }
}

// The only path that skips a password. The read is on the caller's handle rather than the
// component's own, so it sees that transaction's own uncommitted write and the row answered with
// is the row that transaction will commit, Attributes and all.
async function grantToken<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
  tokenTtl: number,
): Promise<IssuedToken> {
  const [row] = await handle.select().from(users).where(eq(users.id, user));
  if (row === undefined) {
    throw new Error(`no User ${user} exists`);
  }
  return insertToken(handle, row, tokenTtl);
}

// The row a Token is, and the one place it is written. See the file header for why it stays one.
async function insertToken<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: typeof users.$inferSelect,
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
  return {
    token: minted.token,
    expiresAt: issued.expiresAt.toISOString(),
    user: asUserRecord(user),
  };
}

// A password traded for a Token, or `undefined` for every way it can fail. A missing User and a
// User whose password hash is null are both verified against a fixed dummy digest, so the cost is
// the same either way. Do not reorder the lines below into an early return; see the file header.
async function logIn(
  handle: UsersHandle,
  credentials: Credentials,
  directory: { readonly dummy: () => Promise<string>; readonly tokenTtl: number },
): Promise<IssuedToken | undefined> {
  const [row] = await handle.select().from(users).where(eq(users.id, credentials.user));
  const stored = row?.passwordHash ?? (await directory.dummy());
  const matched = await verifyPassword(stored, credentials.password);
  if (row === undefined || row.passwordHash === null || !matched) return undefined;

  // The same statement `issueToken` reaches. A Token bought with a password and one minted by an
  // OIDC callback are one row.
  return insertToken(handle, row, directory.tokenTtl);
}

// By the hash and not by the User, so logging out of one device leaves every other session
// working. The row is removed rather than flagged, so one lookup refuses a revoked Token and a
// Token that never existed and the two answer identically.
async function deleteToken(handle: UsersHandle, token: string): Promise<void> {
  await handle.delete(tokens).where(eq(tokens.tokenHash, hashToken(token)));
}

// The `tokens_user_idx` index exists for this statement: PostgreSQL indexes the primary key and
// the unique `token_hash`, and neither is the referencing side this reads. The query-builder form,
// so the public `revoke` and the route can share one statement.
async function deleteTokens<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
): Promise<void> {
  await handle.delete(tokens).where(eq(tokens.userId, user));
}

// A password replaced by somebody who proved they know the current one, or `false`. A User whose
// `password_hash` is null cannot change it here, having nothing to prove.
//
// Unlike `logIn`, this derives nothing when there is nothing to verify against: the caller already
// presented a Token naming this User, so there is no enumeration to close.
async function changePassword(
  handle: UsersHandle,
  change: PasswordChange,
  parameters: ScryptParameters,
): Promise<boolean> {
  const [row] = await handle.select().from(users).where(eq(users.id, change.user));
  const stored = row?.passwordHash ?? undefined;
  if (stored === undefined) return false;
  if (!(await verifyPassword(stored, change.currentPassword))) return false;

  const passwordHash = await hashPassword(change.newPassword, parameters);
  await handle.update(users).set({ passwordHash }).where(eq(users.id, change.user));
  return true;
}

// The User a presented Token names, or `undefined` for an unknown Token and an expired one alike.
// The lookup is by the hash, so the unique index does the comparison, and the join makes it one
// round trip inside this component's own schema.
//
// The expiry is compared against the database's clock, which is the clock `expires_at` was written
// from, so a Token's lifetime does not depend on the drift between two machines. Nothing reaps the
// expired rows: they stop matching.
async function userForToken(handle: UsersHandle, token: string): Promise<UserRecord | undefined> {
  const [row] = await handle
    .select()
    .from(tokens)
    .innerJoin(users, eq(users.id, tokens.userId))
    .where(
      and(eq(tokens.tokenHash, hashToken(token)), gt(tokens.expiresAt, sql`clock_timestamp()`)),
    );
  return row === undefined ? undefined : asUserRecord(row.users);
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

async function selectUser(handle: UsersHandle, id: string): Promise<UserRecord | undefined> {
  const [row] = await handle.select().from(users).where(eq(users.id, id));
  return row === undefined ? undefined : asUserRecord(row);
}

async function selectUsers(handle: UsersHandle, limit: number): Promise<UserRecord[]> {
  const rows = await handle
    .select()
    .from(users)
    // Newest first, because "who has been admitted" is the question this answers. `id` breaks
    // the tie, so a limit cannot drop one of two Users created in the same instant.
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(limit);
  return rows.map(asUserRecord);
}

// The row as the agent reads it. The password hash is not on this wire, ever.
function asUserRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    attributes: row.attributes,
    createdAt: row.createdAt.toISOString(),
  };
}
