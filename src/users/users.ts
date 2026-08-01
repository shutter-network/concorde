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
 * The consequence of the first is worth stating where it will be met: a caller
 * **cannot read its own uncommitted write**. A Handler that creates a User inside a
 * transaction and then calls `get` gets nothing, because the read is on a different
 * connection. `create` returns the User, so the read-back has no reason to exist.
 */

import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import { limitSchema } from "../route-conventions.ts";
import type { Db, Store } from "../store/index.ts";
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
type UsersDb = Db<typeof usersTables>;

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
  create<TSchema extends Record<string, unknown>>(tx: Db<TSchema>): Promise<UserRecord>;

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
  revoke<TSchema extends Record<string, unknown>>(tx: Db<TSchema>, user: string): Promise<void>;

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
  const db = options.store.handle(usersTables);
  const tokenTtl = checkedTokenTtl(options.tokenTtl);
  const parameters = checkedScryptParameters(options.scrypt ?? defaultScryptParameters);
  const dummy = dummyDigest(parameters);
  // One hook, built once and shared by `GET /me` and by every route of the
  // Operator's: the surface the quickstart documents and the surface the Public
  // plugin's own route uses are the same object, not two implementations that could
  // drift.
  const presentedUser = requireUser({ authenticate: (token) => userForToken(db, token) });

  return {
    agentRoutes: agentUserRoutes({
      // The route's create runs on the part's own handle: one insert is atomic by
      // itself, and a request that creates a User has nothing else to keep it with.
      create: ({ password }) => insertUser(db, password, parameters),
      get: (id) => selectUser(db, id),
      list: ({ limit }) => selectUsers(db, limit),
    }),

    publicRoutes: publicUserRoutes(
      {
        logIn: (credentials) => logIn(db, credentials, { dummy, tokenTtl }),
        // The route's revocations run on the part's own handle, for the reason its
        // create does: one statement is atomic by itself, and a request that revokes
        // has nothing else to keep it with. The method below is where a caller with
        // something to keep it with reaches the same statement.
        revokeToken: (token) => deleteToken(db, token),
        revokeTokens: (user) => deleteTokens(db, user),
        changePassword: (change) => changePassword(db, change, parameters),
      },
      presentedUser,
    ),

    requireUser: presentedUser,

    create: (tx) => insertUser(tx, undefined, parameters),
    revoke: (tx, user) => deleteTokens(tx, user),
    get: (id) => selectUser(db, id),
    list: (asked) => selectUsers(db, asked?.limit ?? limitSchema.default),
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
  db: Db<TSchema>,
  password: string | undefined,
  parameters: ScryptParameters,
): Promise<UserRecord> {
  const passwordHash = password === undefined ? null : await hashPassword(password, parameters);
  const [inserted] = await db.insert(users).values({ passwordHash }).returning();
  if (inserted === undefined) {
    throw new Error("creating a User inserted no row");
  }
  return asUserRecord(inserted);
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
  db: UsersDb,
  credentials: Credentials,
  directory: { readonly dummy: () => Promise<string>; readonly tokenTtl: number },
): Promise<IssuedToken | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, credentials.user));
  const stored = row?.passwordHash ?? (await directory.dummy());
  const matched = await verifyPassword(stored, credentials.password);
  if (row === undefined || row.passwordHash === null || !matched) return undefined;

  const minted = mintToken();
  const [issued] = await db
    .insert(tokens)
    .values({
      userId: row.id,
      tokenHash: minted.hash,
      // The database's clock and not this process's, because the comparison that
      // will refuse this Token is made against the database's too. `make_interval`
      // takes seconds as a float, so a lifetime of a millisecond is expressible and
      // a test needs no clock to be moved.
      expiresAt: sql`clock_timestamp() + make_interval(secs => ${directory.tokenTtl / 1000})`,
    })
    .returning({ expiresAt: tokens.expiresAt });
  if (issued === undefined) {
    throw new Error("issuing a Token inserted no row");
  }
  return {
    token: minted.token,
    expiresAt: issued.expiresAt.toISOString(),
    user: asUserRecord(row),
  };
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
async function deleteToken(db: UsersDb, token: string): Promise<void> {
  await db.delete(tokens).where(eq(tokens.tokenHash, hashToken(token)));
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
  db: Db<TSchema>,
  user: string,
): Promise<void> {
  await db.delete(tokens).where(eq(tokens.userId, user));
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
  db: UsersDb,
  change: PasswordChange,
  parameters: ScryptParameters,
): Promise<boolean> {
  const [row] = await db.select().from(users).where(eq(users.id, change.user));
  const stored = row?.passwordHash ?? undefined;
  if (stored === undefined) return false;
  if (!(await verifyPassword(stored, change.currentPassword))) return false;

  const passwordHash = await hashPassword(change.newPassword, parameters);
  await db.update(users).set({ passwordHash }).where(eq(users.id, change.user));
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
async function userForToken(db: UsersDb, token: string): Promise<UserRecord | undefined> {
  const [row] = await db
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

async function selectUser(db: UsersDb, id: string): Promise<UserRecord | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row === undefined ? undefined : asUserRecord(row);
}

async function selectUsers(db: UsersDb, limit: number): Promise<UserRecord[]> {
  const rows = await db
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
