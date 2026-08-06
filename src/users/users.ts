/**
 * The User Manager: the component of a Gateway that owns Users.
 *
 * One call builds it, and it registers its routes on whichever servers it is handed. Its `start`
 * and `stop` do nothing. It emits no Signals and holds no reference to the Signal Worker. Writes
 * take the caller's transaction as their first parameter, and reads do not.
 *
 * Setting Attributes, replacing a password and issuing a Token are methods rather than routes.
 * Trusted code holds this object, and the Agent server is the surface an injected prompt reaches.
 * So the agent can create and read Users, and the three capabilities that escalate are not there
 * to reach.
 */

import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import type { Component } from "../components.ts";
import type { Db, Handle } from "../db/index.ts";
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

/** A handle typed to this component's own tables, and to no other's. */
type UsersHandle = Handle<typeof usersTables>;

/** Everything `createUsers` needs: the Db, a Token lifetime, and the servers its routes go on. */
export type UsersOptions = {
  /** The Db this component queries through. It takes a handle to its own two tables. */
  readonly db: Db;
  /**
   * How long an issued Token lives, in milliseconds.
   *
   * No default. A long lifetime means fewer logins and a longer window for a stolen Token. Only
   * the deployment knows which side of that trade it is on.
   *
   * The lifetime is not per-Token. A Token that never expires is unrepresentable.
   */
  readonly tokenTtl: number;
  /**
   * The Agent server, if the agent is to create and read Users.
   *
   * Given one, the constructor registers `agentRoutes` on it under `/users`: `POST /users`,
   * `GET /users` and `GET /users/:id`. Omit it and nothing is registered anywhere, which is how
   * the agent's ability to create a User is denied. There is no flag and no route to guard.
   *
   * Structural, and asks for nothing but the Fastify instance. What `serverComponent` returns
   * satisfies it. A server built on http2 does not, and takes `agentRoutes` below instead.
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
   * Omit it to replace this password login with a scheme of your own. That scheme can be OIDC, a
   * wallet signature, or a corporate header. `issueToken` is a method, so your own route still
   * mints our Tokens. Nothing else about the User Manager changes.
   */
  readonly publicServer?: {
    readonly fastify: FastifyInstance;
  };
  /**
   * What a password derivation costs. Defaults to OWASP's 32 MiB row.
   *
   * Old digests do not follow it. Each digest carries the parameters it was written under, and
   * verifies at those. So raising this leaves every stored password working, and there is no
   * rehash on login.
   */
  readonly scrypt?: ScryptParameters;
};

/** The User Manager as a Component: two route plugins, one hook, and the methods no route has. */
export type Users = Component & {
  /**
   * The Agent server routes as a Fastify plugin: create a User, read Users.
   *
   * For an Operator who wants them somewhere other than where `agentServer` puts them. The plugin
   * carries no prefix of its own. Register it under a prefix of yours, inside your own encapsulated
   * plugin, or behind your own hook.
   *
   * Passing no server and never registering this is how the capability is switched off.
   */
  readonly agentRoutes: FastifyPluginAsync;

  /**
   * The Public server routes as a Fastify plugin: the login, and the four routes around it.
   *
   * The same prefix story `agentRoutes` carries. `/auth` is the constructor's default, and
   * `POST /auth/tokens` is where the login goes.
   *
   * Registering neither this plugin nor a Public server is how a deployment replaces this login.
   * Its own scheme mints our Tokens through `issueToken`, and there is no interface to implement.
   */
  readonly publicRoutes: FastifyPluginAsync;

  /**
   * The preHandler that requires a Token, as one option on any route.
   *
   * `publicServer.post("/ask", { preHandler: users.requireUser }, handler)`. It reads the
   * `Authorization: Bearer …` header. It then assigns the User to `request.safUser`, or answers
   * the single 401 that every authentication failure gets.
   *
   * A hook rather than a plugin, so it works on either server, inside any plugin, at any depth.
   * A route that does not take it reads `request.safUser` as `undefined`, despite the type.
   * Nothing is protected by default.
   */
  readonly requireUser: preHandlerAsyncHookHandler;

  /**
   * Creates a User with no Attributes and no password, and answers with the record.
   *
   * Takes the caller's transaction, so admitting a User and writing the Operator's own rows
   * cannot come apart. A rollback loses both. The caller cannot read this write back through
   * `get`, which is why the record comes back here.
   *
   * It accepts no id. A User has no natural key, so seeding is the Operator's own job, out of
   * band and once.
   */
  create<TSchema extends Record<string, unknown>>(tx: Handle<TSchema>): Promise<UserRecord>;

  /**
   * Replaces a User's Attributes, wholesale.
   *
   * This is where authorization lives, and the agent cannot reach it. `POST /users` has no
   * parameter for an attribute, so an injected prompt cannot mint a privileged User.
   *
   * Wholesale rather than a merge, because a merge cannot express removal. A merge is one line on
   * top of this: read, spread, set. A write, so it takes the caller's transaction first, and it
   * throws when no User has that id.
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
   * self-service route, and it wants the current password.
   *
   * It revokes nothing. To lock somebody out, replace the password and then call `revoke`, in that
   * order. There is no bound on the length here. The empty string stores like any other, and leaves
   * a User who cannot log in.
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
   * The User needs no password, and their Token is not a lesser Token. It takes the caller's
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
   * What `DELETE /auth/tokens` does, reachable without HTTP. Nothing removes a User, so this is
   * the closest thing to shutting one out. They keep their password, which mints a new Token, so
   * replace that too.
   *
   * It takes the caller's transaction. It is idempotent and answers nothing, not even a count. The
   * rows are deleted rather than marked, which is the only compaction that table gets.
   */
  revoke<TSchema extends Record<string, unknown>>(tx: Handle<TSchema>, user: string): Promise<void>;

  /**
   * One User by id, or `undefined`.
   *
   * A read, so it takes no transaction and cannot see the caller's own uncommitted write.
   * `create` answers with the User for that reason.
   */
  get(id: string): Promise<UserRecord | undefined>;

  /**
   * Users, newest first, limited.
   *
   * A read, with the same consequence `get` carries. `limit` defaults to the route's default and
   * is not capped here. The cap on a route bounds a response body the agent reads, and this is
   * not that.
   */
  list(options?: { readonly limit?: number }): Promise<UserRecord[]>;

  /**
   * Does nothing. There is nothing here to start.
   *
   * The pool belongs to the Db, and the routes belong to the servers they went on. This component
   * is in the Gateway's record for its membership. Everything it needs was done at construction.
   */
  start(): Promise<void>;

  /**
   * Does nothing, for the reason `start` does not.
   *
   * A Token outlives a shutdown. What makes it valid is a row and the database's own clock, and
   * nothing reaps the expired rows.
   */
  stop(): Promise<void>;
};

/**
 * Builds the User Manager and registers its routes on the servers it is given.
 *
 * Nothing here connects, listens or applies DDL. Put the result in the Gateway's record under a
 * key of your own.
 *
 * @throws If `tokenTtl` is not a positive number of milliseconds.
 * @throws If a `scrypt` parameter is outside its bounds.
 *
 * @example
 * No Agent server, so the agent can neither create nor read Users.
 * ```ts
 * import Fastify from "fastify";
 * import { openDb, serverComponent } from "shared-agent-framework";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * const db = openDb(process.env.DATABASE_URL ?? "");
 * const publicServer = serverComponent(Fastify(), { host: "0.0.0.0", port: 8080 });
 * const users = createUsers({ db, tokenTtl: 3_600_000, publicServer });
 *
 * await db.start();
 *
 * // Trusted code can still admit somebody and hand them a Token.
 * const issued = await db.tx(async (tx) => {
 *   const user = await users.create(tx);
 *   return users.issueToken(tx, user.id);
 * });
 * ```
 */
export function createUsers(options: UsersOptions): Users {
  // The component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(usersTables);
  const tokenTtl = checkedTokenTtl(options.tokenTtl);
  const parameters = checkedScryptParameters(options.scrypt ?? defaultScryptParameters);
  const dummy = dummyDigest(parameters);
  // One hook, built once and shared by `GET /me` and by every route of the Operator's. The
  // documented surface and the Public plugin's own route are the same object.
  const presentedUser = requireUser({ authenticate: (token) => userForToken(handle, token) });

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

    requireUser: presentedUser,

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

/**
 * The insert, over whichever handle the caller reached it by.
 *
 * It takes one value and could take no other. Every remaining column of a new User is the
 * database's default, so nothing on this path can carry an attribute. The query-builder form, so
 * it works on a transaction carrying any component's schema.
 *
 * The derivation runs before the insert, inside the caller's transaction, which holds it open for
 * as long as scrypt takes.
 */
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

/**
 * The one update statement behind both things trusted code may change about a User.
 *
 * One function and not two, because the two differ only in which column they name. The
 * query-builder form, so it works on a transaction carrying any component's schema. A
 * `returning`, so that "there is no such User" is distinct from "there was nothing to change".
 *
 * That is why this throws where `deleteTokens` says nothing. An id with a typo in it would
 * otherwise be a permission quietly not given. The message names the id, because the caller is
 * trusted code reading a stack trace.
 */
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

/**
 * A Token issued to a User who presented nothing: the only path that skips a password.
 *
 * The read is on the caller's handle rather than the component's own. So one transaction can
 * create a User and issue them a Token, because the read sees its own uncommitted write. The row
 * this answers with is the row that transaction will commit, Attributes and all.
 */
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

/**
 * The row a Token is, and the one place it is written.
 *
 * Shared by the login route and by `issueToken`. A Token minted for an OIDC callback and one
 * bought with a password are the same row. One statement writes both.
 */
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

/**
 * A password traded for a Token, or `undefined` for every way it can fail.
 *
 * The derivation is unconditional. A missing User and a User whose password hash is null are both
 * verified against a fixed dummy digest. The cost is the same either way, so the response time
 * answers nothing the body refused to. Do not reorder the lines below into an early return.
 */
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

/**
 * Drops one Token: the one whose plaintext this is, and no other.
 *
 * By the hash and not by the User, so logging out of one device leaves every other session
 * working. A Token nobody holds matches nothing and deletes nothing.
 *
 * The row is removed rather than flagged. One lookup refuses a revoked Token and a Token that
 * never existed, so the two answer identically.
 */
async function deleteToken(handle: UsersHandle, token: string): Promise<void> {
  await handle.delete(tokens).where(eq(tokens.tokenHash, hashToken(token)));
}

/**
 * Drops every Token of one User, over whichever handle the caller reached it by.
 *
 * The `tokens_user_idx` index exists for this statement. PostgreSQL indexes the primary key and
 * the unique `token_hash`, and neither is the referencing side this reads.
 *
 * The query-builder form, so it works on a transaction carrying any component's schema. That is
 * what lets the public `revoke` and the route share one statement.
 */
async function deleteTokens<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
): Promise<void> {
  await handle.delete(tokens).where(eq(tokens.userId, user));
}

/**
 * A password replaced by somebody who proved they know the current one, or `false`.
 *
 * The proof is what makes this self-service rather than account recovery. A User whose
 * `password_hash` is null cannot change it here, because there is nothing for them to prove.
 *
 * Unlike `logIn`, this derives nothing when there is nothing to verify against. The caller
 * already presented a Token naming this User, so there is no enumeration to close. It revokes
 * nothing: `DELETE /auth/tokens` is a request of its own.
 */
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

/**
 * The User a presented Token names, or `undefined` for an unknown Token and an expired one.
 *
 * The lookup is by the hash, so the unique index does the comparison. A Token carries full
 * entropy, so a hash of it is not a guessable thing. The join makes this one round trip, and it
 * stays inside this component's own schema.
 *
 * The expiry is compared against the database's clock, which is the clock `expires_at` was written
 * from. So a Token's lifetime does not depend on the drift between two machines. Nothing reaps the
 * expired rows: they stop matching.
 */
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

/**
 * The digest a login with nothing to verify against is verified against instead.
 *
 * Derived once, lazily, and at the Manager's own cost, so a miss costs what a hit costs. The
 * password it is written from is 32 random bytes of this process's, so nobody can present it.
 */
function dummyDigest(parameters: ScryptParameters): () => Promise<string> {
  let derived: Promise<string> | undefined;
  return () => (derived ??= hashPassword(mintToken().token, parameters));
}

/** A lifetime that is not a positive number of milliseconds is a mistake, not a policy. */
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

/** The row as the agent reads it. The password hash is not on this wire, ever. */
function asUserRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    attributes: row.attributes,
    createdAt: row.createdAt.toISOString(),
  };
}
