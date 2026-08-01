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

import { desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { limitSchema } from "../route-conventions.ts";
import type { Db, Store } from "../store/index.ts";
import {
  agentUserRoutes,
  type Credentials,
  type IssuedToken,
  publicUserRoutes,
  type UserRecord,
} from "./routes.ts";
import { tokens, users, usersTables } from "./schema.ts";
import {
  checkedScryptParameters,
  defaultScryptParameters,
  hashPassword,
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

  return {
    agentRoutes: agentUserRoutes({
      // The route's create runs on the part's own handle: one insert is atomic by
      // itself, and a request that creates a User has nothing else to keep it with.
      create: ({ password }) => insertUser(db, password, parameters),
      get: (id) => selectUser(db, id),
      list: ({ limit }) => selectUsers(db, limit),
    }),

    publicRoutes: publicUserRoutes({
      logIn: (credentials) => logIn(db, credentials, { dummy, tokenTtl }),
    }),

    create: (tx) => insertUser(tx, undefined, parameters),
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
