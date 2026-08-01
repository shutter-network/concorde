/**
 * The User Directory: the part of the Gateway that owns Users.
 *
 * Constructed like every other part — one call, an ordinary object back, nothing to
 * register it with and no lifecycle (ADR-0021). It is **not a Producer**: it takes
 * no reference to the Core and emits no Signals, because the worker is serial
 * globally and a Signal per User event would put a Run behind one (ADR-0029). A
 * deployment that wants that Signal emits it itself, atomically, because `create`
 * takes the caller's transaction.
 *
 * Two things about the surface are decisions rather than omissions:
 *
 *  - **Writes take the transaction as their first parameter; reads do not**
 *    (ADR-0023). So `create` is transactional on the caller's behalf, and `get` and
 *    `list` go through the part's own handle.
 *  - **Nothing removes a User.** No delete, no deactivation, no `deactivated_at`
 *    (ADR-0029).
 *
 * The third thing is the asymmetry the whole part is arranged around. Setting
 * Attributes, replacing a password and issuing a Token are **methods and not routes**:
 * Signal Handlers and an Operator's entry point are trusted code (ADR-0009, ADR-0020)
 * and hold this object, while the Agent server is the one surface an injected prompt
 * reaches and it has no authentication at all (ADR-0003, ADR-0010). So the agent may
 * create a User and read Users, and the three capabilities that could turn that into an
 * escalation are not on its surface to reach — by absence, not by a guard.
 *
 * The consequence of the first is worth stating where it will be met: a caller
 * **cannot read its own uncommitted write**. A Handler that creates a User inside a
 * transaction and then calls `get` gets nothing, because the read is on a different
 * connection. `create` returns the User, so the read-back has no reason to exist.
 */

import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import { limitSchema } from "../route-conventions.ts";
import type { Handle, Store } from "../store/index.ts";
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

/** A handle typed to this part's own tables, and to no other part's (ADR-0022). */
type UsersHandle = Handle<typeof usersTables>;

export type UsersOptions = {
  readonly store: Store;
  /**
   * How long an issued Token lives, in milliseconds.
   *
   * No default, because the trade it settles is the deployment's: a long lifetime is
   * fewer re-authentications and a longer window for a stolen Token, and nothing in
   * this framework can tell which side of that a Gateway is on. It is not
   * per-Token either: a Token that never expires is unrepresentable, and one that
   * expires on a schedule of the caller's would be a second policy to keep straight
   * (ADR-0030).
   */
  readonly tokenTtl: number;
  /**
   * What a password derivation costs. Defaults to OWASP's 32 MiB row.
   *
   * A construction-time option that old digests **do not** follow: each digest
   * carries the parameters it was written under and is verified at those, so raising
   * this leaves every existing password working, and there is deliberately no
   * rehash-on-login (ADR-0030). Lowering it does the same, which is the only reason a
   * test can run at a cost a person would not accept.
   */
  readonly scrypt?: ScryptParameters;
};

export type Users = {
  /**
   * The Agent server routes — create a User, read Users — as a Fastify plugin:
   * `agentServer.register(users.agentRoutes, { prefix: "/users" })`, on the Fastify
   * instance the Operator constructed.
   *
   * The plugin carries no prefix of its own, so the URL layout stays the Operator's,
   * and not registering it is how the capability is switched off wholesale
   * (ADR-0010, ADR-0021).
   */
  readonly agentRoutes: FastifyPluginAsync;

  /**
   * The Public server routes, the login, as a Fastify plugin:
   * `publicServer.register(users.publicRoutes, { prefix: "/auth" })`, which is where
   * `POST /auth/tokens` comes from.
   *
   * Registering it is the whole of "the Gateway authenticates with passwords", and
   * **not** registering it is how a deployment replaces that with its own scheme
   * while keeping our Tokens: there is no Authenticator interface, because the useful
   * extension point is issuance rather than verification (ADR-0030).
   */
  readonly publicRoutes: FastifyPluginAsync;

  /**
   * The preHandler that requires a Token, as one option on any route:
   * `publicServer.post("/ask", { preHandler: users.requireUser }, handler)`.
   *
   * It reads the `Authorization: Bearer …` header, and either assigns the User it
   * names to `request.safUser` or answers the single 401 — the same status and the
   * same body a wrong password gets, for a missing header, a header in another
   * scheme, an unknown Token and an expired one alike (ADR-0030).
   *
   * This is the whole integration surface, and it is deliberately a hook rather than
   * a plugin: it works on either server, inside any plugin of the Operator's, at any
   * depth, with nothing of ours to register first. The Messenger will use exactly
   * this and will authenticate nobody itself.
   *
   * A route that does not take it reads `request.safUser` as `undefined` despite the
   * type, because the augmentation cannot express "set only after this ran". Nothing
   * anywhere is protected by default.
   */
  readonly requireUser: preHandlerAsyncHookHandler;

  /**
   * Creates a User with no Attributes and no password, and returns it.
   *
   * Takes the caller's transaction rather than finding one (ADR-0023), so admitting
   * a User and recording whatever the Operator's own tables record about them cannot
   * come apart: a rollback loses both. Ambient enlistment is not available — a
   * transaction started on one handle takes its own connection from the pool, so a
   * second handle's writes survive its rollback with nothing reported.
   *
   * The schema parameter is widened rather than named, because the transaction
   * carries the schema of the handle it was started on and that handle belongs to
   * the caller.
   *
   * It deliberately accepts **no id**. A User has no natural key, so "create this
   * User if absent" is not expressible and boot-time seeding is not a thing to make
   * idempotent; an explicit id would only invite a hardcoded uuid into every copy of
   * a deployment's source (ADR-0029). Seeding is the Operator's, out of band, once.
   */
  create<TSchema extends Record<string, unknown>>(tx: Handle<TSchema>): Promise<UserRecord>;

  /**
   * Replaces a User's Attributes, **wholesale**.
   *
   * This is where authorization lives, since there is no Party (ADR-0008, ADR-0014),
   * and it is the one capability the agent is denied by the **absence of a parameter**
   * rather than by a check: `POST /users` has nowhere for an attribute to arrive
   * through, so an injected prompt cannot mint a privileged User (ADR-0029). Which
   * makes this method the other half of that boundary, and the reason it takes trusted
   * code to reach it.
   *
   * **Wholesale and not a merge**, and the choice is written here because an
   * undocumented one becomes a deployment's bug the first time somebody sets one key
   * and finds another still set. Three reasons, and the first is the load-bearing one:
   *
   *  - A merge cannot express **removal**. Taking `role` away from somebody would need
   *    a sentinel value invented for it, and a framework that stores Attributes without
   *    interpreting them has no business interpreting one. Replacement is total, and a
   *    merge is written from it in one line — read, spread, set — while removal cannot
   *    be written from a merge at all.
   *  - Attributes are **arbitrary JSON** and need not be an object. There is no merge
   *    of an array with an object, so a merging method would have a shape it silently
   *    behaved differently for.
   *  - `jsonb ||` merges only the **top level**, so a nested object would be replaced
   *    wholesale while its siblings were merged — the one behaviour nobody predicts.
   *
   * A write, so it takes the caller's transaction first (ADR-0023): granting somebody a
   * group and recording in the Operator's own tables who granted it commit together or
   * not at all.
   *
   * Unlike `revoke`, it **throws** when no User has that id rather than doing nothing.
   * Silence is right for a revocation because the postcondition holds either way — the
   * Token is gone whether or not this call removed it — and wrong here, because a
   * mistyped id would otherwise be an authorization grant that quietly did not happen.
   */
  setAttributes<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    user: string,
    attributes: unknown,
  ): Promise<void>;

  /**
   * Replaces a User's password, proving nothing.
   *
   * The whole of "account recovery" in this framework: an Operator sets a new one, from
   * their own code, having established out of band that they should. There is no route
   * for this on either server — `PUT /password` requires the current password, which is
   * what makes it self-service rather than recovery, and a User whose `password_hash` is
   * null has nothing to prove there at all (ADR-0014, ADR-0030).
   *
   * It also gives a password to a User who had none, which is the OIDC path run
   * backwards: somebody admitted through a deployment's own login route can be handed
   * one later without being created again.
   *
   * It **revokes nothing**, deliberately, and the same way `PUT /password` does not: an
   * Operator locking somebody out replaces the password *and* calls `revoke`, and one
   * that bundled the two would take that choice away from a routine rotation. The
   * ordering that matters is `revoke` last, since a Token issued between the two calls
   * would outlive both.
   *
   * A write, so it takes the caller's transaction first (ADR-0023), and it throws when
   * no User has that id for the reason `setAttributes` does.
   *
   * There is **no bound on the password's length** here, where the route has one: the
   * bound exists because scrypt reads its whole input on a route nothing rate limits,
   * and trusted code calling this is not that. Nor is the empty string refused — it
   * derives and stores like any other, and the login route's schema will not accept one,
   * so setting it leaves a User who cannot log in. Recorded rather than guarded against.
   */
  setPassword<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    user: string,
    password: string,
  ): Promise<void>;

  /**
   * Issues a Token to a User who presented nothing, and answers exactly what a login
   * answers.
   *
   * **This is the extension point that replaced the Authenticator** (ADR-0030). A
   * deployment wanting OIDC — or a wallet signature, or a corporate header — writes its
   * own login route on the Public server, establishes identity however it likes, and
   * calls this. What comes back is an ordinary Token, and nothing downstream, including
   * `requireUser`, the Operator's own routes and the Messenger when it exists, can tell
   * how it was obtained. That is why there is no `verify(request)` interface to
   * implement: an implementation of one would still have had to answer "and where does
   * the credential live?", and would have reimplemented this storage to satisfy it.
   *
   * The User needs **no password**, and `password_hash` is nullable exactly so that such
   * a User need never have one. Their Token is not a lesser Token: it expires from the
   * same construction-time lifetime, is revoked by the same two routes, and is
   * indistinguishable from one a password bought.
   *
   * A write, so it takes the caller's transaction first (ADR-0023) — which also means
   * the User it names may be one the same transaction just created, since this reads on
   * the caller's connection. So an OIDC callback that admits somebody on first sight and
   * hands them a Token is one transaction, and a rollback leaves neither.
   *
   * It throws when no User has that id, for the reason `setAttributes` does and because
   * there is no Token it could answer with.
   */
  issueToken<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    user: string,
  ): Promise<IssuedToken>;

  /**
   * Revokes every Token of one User, so that none of them works again.
   *
   * The same thing `DELETE /tokens` does, reachable without HTTP: an Operator who
   * learns from their own systems that somebody's credential has leaked revokes it
   * from the code that learned, rather than logging in as them to do it. Since nothing
   * removes a User (ADR-0029), this is also the closest thing to shutting one out that
   * exists — they keep their password, and it will mint a new Token the moment they
   * use it, so an Operator locking somebody out revokes *and* replaces the password.
   *
   * A write, so it takes the caller's transaction first (ADR-0023): revoking and
   * recording why in the Operator's own tables commit together or not at all. It is
   * idempotent and answers nothing, including a count — a Token is gone afterwards
   * whether or not this call is what removed it, and a User with none is not an error.
   *
   * The rows are **deleted rather than marked**, which is the only compaction anything
   * has over that table: nothing reaps expired Tokens either (ADR-0030).
   */
  revoke<TSchema extends Record<string, unknown>>(tx: Handle<TSchema>, user: string): Promise<void>;

  /**
   * One User by id, or `undefined`.
   *
   * A read, so it takes no transaction and **cannot see the caller's own uncommitted
   * write** — `create` returns the User for exactly that reason.
   */
  get(id: string): Promise<UserRecord | undefined>;

  /**
   * Users, newest first, limited.
   *
   * A read, with the same consequence `get` carries. `limit` defaults to the number
   * the route defaults to and is **not** capped here: the cap on the route bounds a
   * response body the agent reads, which is not the case trusted code asking for a
   * thousand Users is in.
   */
  list(options?: { readonly limit?: number }): Promise<UserRecord[]>;
};

export function createUsers(options: UsersOptions): Users {
  // The part's own handle, typed to its own tables. `pg` never leaves the Store
  // (ADR-0022).
  const handle = options.store.handle(usersTables);
  const tokenTtl = checkedTokenTtl(options.tokenTtl);
  const parameters = checkedScryptParameters(options.scrypt ?? defaultScryptParameters);
  const dummy = dummyDigest(parameters);
  // One hook, built once and shared by `GET /me` and by every route of the
  // Operator's: the surface the quickstart documents and the surface the Public
  // plugin's own route uses are the same object, not two implementations that could
  // drift.
  const presentedUser = requireUser({ authenticate: (token) => userForToken(handle, token) });

  return {
    agentRoutes: agentUserRoutes({
      // The route's create runs on the part's own handle: one insert is atomic by
      // itself, and a request that creates a User has nothing else to keep it with.
      create: ({ password }) => insertUser(handle, password, parameters),
      get: (id) => selectUser(handle, id),
      list: ({ limit }) => selectUsers(handle, limit),
    }),

    publicRoutes: publicUserRoutes(
      {
        logIn: (credentials) => logIn(handle, credentials, { dummy, tokenTtl }),
        // The route's revocations run on the part's own handle, for the reason its
        // create does: one statement is atomic by itself, and a request that revokes
        // has nothing else to keep it with. The method below is where a caller with
        // something to keep it with reaches the same statement.
        revokeToken: (token) => deleteToken(handle, token),
        revokeTokens: (user) => deleteTokens(handle, user),
        changePassword: (change) => changePassword(handle, change, parameters),
      },
      presentedUser,
    ),

    requireUser: presentedUser,

    create: (tx) => insertUser(tx, undefined, parameters),
    setAttributes: (tx, user, attributes) => updateUser(tx, user, { attributes }),
    setPassword: async (tx, user, password) =>
      updateUser(tx, user, { passwordHash: await hashPassword(password, parameters) }),
    issueToken: (tx, user) => grantToken(tx, user, tokenTtl),
    revoke: (tx, user) => deleteTokens(tx, user),
    get: (id) => selectUser(handle, id),
    list: (asked) => selectUsers(handle, asked?.limit ?? limitSchema.default),
  };
}

/**
 * The insert, over whichever handle the caller reached it by.
 *
 * It takes one value and could take no other: every remaining column of a new User is
 * the database's default, so there is no parameter anywhere on this path for an
 * attribute to arrive through. The query-builder form, not the relational one, so it
 * works on a transaction carrying any part's schema (ADR-0023).
 *
 * The derivation happens before the insert and therefore inside the caller's
 * transaction, which holds it open for as long as scrypt takes. That is accepted: the
 * alternative is deriving first and inserting after, which is the same wall clock with
 * a wider window between the two statements the caller wanted kept together.
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
 * The one update statement behind both of the things trusted code may change about a
 * User, over whichever handle the caller reached it by.
 *
 * One function and not two, because the two differ only in which column they name and
 * everything else about them is the same decision: the query-builder form so it works
 * on a transaction carrying any part's schema (ADR-0023), and a `returning` so that
 * "there is no such User" is distinguishable from "there was nothing to change".
 *
 * That distinction is why this throws where `deleteTokens` says nothing. A revocation's
 * postcondition holds whether or not it was this call that removed the row; an
 * authorization grant's does not, and an id with a typo in it would otherwise be a
 * permission quietly not given. The message names the id, because the caller is trusted
 * code reading a stack trace and not a stranger probing for who exists.
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
 * A Token issued to a User who presented nothing: the OIDC path, and the only path to a
 * Token that does not begin with a password.
 *
 * The read is on the **caller's** handle rather than the part's own, which is what lets
 * a transaction create a User and issue them a Token in one go — the read sees the
 * caller's own uncommitted write precisely because it is not on another connection. It
 * is also what makes the row this answers with the row as the caller's transaction will
 * commit it, Attributes and all.
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
 * Shared by the login route and by `issueToken`, which is the claim rather than a
 * saving: a Token minted for an OIDC callback and a Token bought with a password are
 * the same row written by the same statement, so nothing downstream could tell them
 * apart even if it wanted to.
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
      // The database's clock and not this process's, because the comparison that
      // will refuse this Token is made against the database's too. `make_interval`
      // takes seconds as a float, so a lifetime of a millisecond is expressible and
      // a test needs no clock to be moved.
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
 * A password traded for a Token, or `undefined`, and the same `undefined` for every
 * way it can fail.
 *
 * The shape of this function is the decision, not an accident of style. The
 * derivation is **unconditional**: a User that does not exist and a User whose
 * password hash is null are both verified against a fixed dummy digest written at the
 * same cost, so the response time answers nothing the body refused to (ADR-0030).
 * Reordering the lines below into an early return for a missing row would restore
 * exactly the enumeration this closes, which is why they are not written that way.
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

  // The same statement `issueToken` reaches, so a Token bought with a password and a
  // Token minted by an OIDC callback are one row written one way (ADR-0030).
  return insertToken(handle, row, directory.tokenTtl);
}

/**
 * Drops one Token: the one whose plaintext this is, and no other.
 *
 * By the hash and not by the User, so logging out of one device leaves every other
 * session working — the unique index finds the row, exactly as verification does, and
 * a Token nobody holds matches nothing and deletes nothing.
 *
 * The row is **removed**, not flagged. There is no revoked column to add and no read
 * that would have to start consulting one: a Token that is not in the table is
 * refused by the same lookup that refuses one that never existed, which is why a
 * revoked Token and an unknown one answer identically without either being made to.
 */
async function deleteToken(handle: UsersHandle, token: string): Promise<void> {
  await handle.delete(tokens).where(eq(tokens.tokenHash, hashToken(token)));
}

/**
 * Drops every Token of one User, over whichever handle the caller reached it by.
 *
 * The `tokens_user_idx` index exists for this statement, which is the reason it is not
 * redundant with the two PostgreSQL makes for us: it indexes the primary key and the
 * unique `token_hash`, and neither of them is the referencing side this reads.
 *
 * The query-builder form, not the relational one, so it works on a transaction
 * carrying any part's schema (ADR-0023) — that is what lets the public `revoke` and
 * the route share one statement rather than have one each.
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
 * The proof is the whole point: it is what makes this self-service rather than account
 * recovery, which is the thing this framework declined to build (ADR-0014, ADR-0030).
 * A User whose `password_hash` is null therefore cannot change it here — there is
 * nothing for them to prove — and the OIDC path this leaves them on is deliberate.
 *
 * Unlike `logIn`, this derives **nothing** when there is nothing to verify against.
 * There is no enumeration to close: the caller already presented a Token naming this
 * User, so a timing signal here would tell them only what they proved on the way in.
 *
 * It revokes nothing, and that is a decision rather than an omission (ADR-0030): a
 * User who changed their password because they feared a leak is served by revoking,
 * which is a request of its own, and taking every other session down with a routine
 * rotation is a surprise nobody asked for.
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
 * The User a presented Token names, or `undefined` — for an unknown Token and an
 * expired one alike.
 *
 * One statement, and every part of it is a decision. The lookup is **by the hash**, so
 * the unique index does the comparison: there is no scan, no per-row loop and no
 * constant-time compare, because a Token carries full entropy and a hash of it is not
 * a guessable thing (ADR-0030). The join is what makes this one round trip rather than
 * two, and it is within this part's own schema, which is the only place ADR-0022
 * allows one.
 *
 * The expiry is compared against **the database's clock**, which is the clock the
 * `expires_at` was written from. Reading it into this process and comparing it here
 * would make a Token's lifetime depend on the drift between two machines, and would
 * make the refusal something this code decides rather than something the row says.
 * Nothing reaps the expired rows; they simply stop matching (ADR-0030).
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
 * Derived once, lazily, and at the Directory's own cost, so that a miss costs what a
 * hit costs however the Operator constructed it: a dummy fixed in code would make
 * misses cheaper than hits for any deployment that raised the parameters, which is
 * the timing signal it exists to remove. The password it is written from is 32 random
 * bytes of this process's, so nothing verifies against it and nobody can present it.
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
    // Newest first, because "who has been admitted" is the question this answers.
    // `id` breaks the tie, so a limit never drops one of two Users created in the
    // same instant and includes the other.
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
