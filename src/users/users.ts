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

import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { limitSchema } from "../route-conventions.ts";
import type { Db, Store } from "../store/index.ts";
import { agentUserRoutes, type UserRecord } from "./routes.ts";
import { users, usersTables } from "./schema.ts";

/** A handle typed to this part's own tables, and to no other part's (ADR-0022). */
type UsersDb = Db<typeof usersTables>;

export type UsersOptions = {
  readonly store: Store;
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

  return {
    agentRoutes: agentUserRoutes({
      // The route's create runs on the part's own handle: one insert is atomic by
      // itself, and a request that creates a User has nothing else to keep it with.
      create: () => insertUser(db),
      get: (id) => selectUser(db, id),
      list: ({ limit }) => selectUsers(db, limit),
    }),

    create: (tx) => insertUser(tx),
    get: (id) => selectUser(db, id),
    list: (asked) => selectUsers(db, asked?.limit ?? limitSchema.default),
  };
}

/**
 * The insert, over whichever handle the caller reached it by.
 *
 * It takes no values at all, which is the point: every column of a new User is the
 * database's default, so there is no parameter anywhere on this path for an
 * attribute to arrive through. The query-builder form, not the relational one, so it
 * works on a transaction carrying any part's schema (ADR-0023).
 */
async function insertUser<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
): Promise<UserRecord> {
  const [inserted] = await db.insert(users).values({}).returning();
  if (inserted === undefined) {
    throw new Error("creating a User inserted no row");
  }
  return asUserRecord(inserted);
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
