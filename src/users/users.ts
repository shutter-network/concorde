/**
 * **This component authenticates nobody and holds nothing a person presents.** The password
 * digest, the Token table and the hook that verified one are Password Auth's
 * ([ADR-0052](../../docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)),
 * and what is left here is identity: the opaque id, the Attributes, and the reads of both. A
 * credential of any kind arriving in this file again is the thing to refuse in review, because the
 * seam the whole design rests on is who owns the secret.
 *
 * **Admitting a User and setting Attributes are methods and never routes**, and that is the shape
 * of what remains ([ADR-0029](../../docs/adr/0029-users-are-a-part-of-their-own.md)). Trusted code
 * holds the returned object; the Agent server is a surface an injected prompt reaches
 * ([ADR-0003](../../docs/adr/0003-prompt-injection-is-an-accepted-risk.md)). So the agent's routes
 * are two reads, and promoting either capability to a route is the thing to refuse in review.
 *
 * **This is not a Producer.** It emits no Signals and takes no reference to the Signal Worker. A
 * Signal on a User being admitted is refused rather than merely omitted: the worker is globally
 * serial ([ADR-0012](../../docs/adr/0012-the-gateway-is-a-serial-signal-worker.md)). A deployment
 * that wants one emits it itself, atomically, because writes take the transaction first
 * ([ADR-0023](../../docs/adr/0023-cross-component-writes-take-an-explicit-transaction.md)).
 *
 * `updateUser` uses `returning` so that "no such User" is distinct from "nothing to change", which
 * is why it throws: an id with a typo in it would otherwise be a permission quietly not given.
 */

import { desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import type { Db, Handle } from "../db/index.ts";
import type { Component } from "../gateway/components.ts";
import { limitSchema } from "../route-conventions.ts";
import { agentUserRoutes, publicUserRoutes, type UserRecord } from "./routes.ts";
import { users, usersTables } from "./schema/index.ts";

type UsersHandle = Handle<typeof usersTables>;

// Where the constructor puts each route group. A constant and not an option, so a client written
// for one deployment's Users works against every other one.
const usersPrefix = "/users";

export type UsersOptions = {
  readonly db: Db;
  /**
   * The Agent server, if the agent is to read Users.
   *
   * Given one, the constructor registers `agentRoutes` on it under `/users`: `GET /users` and
   * `GET /users/:id`. Omit it and nothing is registered there, which is how the agent's ability to
   * see who exists is denied. There is no flag and no route to guard.
   *
   * Structural: anything carrying a Fastify instance satisfies it. A server built on http2 does
   * not, and takes `agentRoutes` instead.
   */
  readonly agentServer?: {
    readonly fastify: FastifyInstance;
  };
  /**
   * The Public server, if a person is to read back which User they are.
   *
   * Given one, the constructor registers `GET /users/me` on it, behind that server's own
   * `requireUser`. Omit it and this component serves nothing outside at all.
   *
   * The hook is required rather than optional, because the route is unbuildable without one: this
   * component authenticates nobody, and which schemes the deployment accepts is what the server
   * holds. Construct an Auth with the same server, or the route throws `NoAuthRegisteredError` on
   * every request.
   */
  readonly publicServer?: {
    readonly fastify: FastifyInstance;
    readonly requireUser: preHandlerAsyncHookHandler;
  };
};

/**
 * The Users component as a Component: one route plugin the agent may take, and a programmatic API.
 *
 * It keeps a User's opaque id, their Attributes and when they were admitted, and nothing else.
 * Nothing removes a User: there is no delete, no deactivation, and no column recording either.
 *
 * Admitting a User and setting their Attributes are in the programmatic API and have no route
 * anywhere. The Agent server is the surface an injected prompt reaches, so the two capabilities
 * that escalate are not there to reach.
 *
 * Every write takes the caller's transaction as its first argument and every read takes none, so a
 * read cannot see the caller's own uncommitted write. That is why `create` answers with what it
 * wrote.
 *
 * Nothing is notified when a User is created. No Signal is emitted and no Handler wakes, so a
 * deployment that wants one emits it itself inside the same transaction.
 *
 * `start` and `stop` do nothing. A User is a committed row and outlives this process.
 */
export type Users = Component & {
  /**
   * The Agent server routes as a Fastify plugin: two reads, and nothing that writes.
   *
   * For an Operator who wants them somewhere other than where `agentServer` puts them. The plugin
   * carries no prefix of its own, so register it under a prefix of yours, inside your own
   * encapsulated plugin, or behind your own hook.
   *
   * Passing no Agent server and never registering this is how the agent's reads are switched off.
   * There is no matching member for the Public route: that one takes the Public server's hook, so
   * a plugin built without a server would have nothing to authenticate with.
   */
  readonly agentRoutes: FastifyPluginAsync;

  /**
   * Creates a User with no Attributes, and answers with the record.
   *
   * Takes the caller's transaction, so admitting a User and whatever gives them a credential
   * cannot come apart: create a User and call an Auth's `setPassword` on the same `tx`, and a
   * rollback loses both. The record comes back from here because a read cannot see that
   * uncommitted write.
   *
   * It accepts no id. A User has no natural key, so "create this User if absent" is not
   * expressible and seeding the first one is the Operator's own job, out of band and once.
   */
  create<TSchema extends Record<string, unknown>>(tx: Handle<TSchema>): Promise<UserRecord>;

  /**
   * Replaces a User's Attributes, wholesale, and throws when no User has that id.
   *
   * This is where authorization lives, and the agent cannot reach it: no route anywhere writes
   * this column, so an injected prompt cannot mint a privileged User.
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
   * One User by id, or `undefined`.
   *
   * A read, so it takes no transaction and cannot see the caller's own uncommitted write. `create`
   * answers with the User for that reason. It is also what an Auth calls to turn the identity it
   * verified into the record an outcome carries.
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
 */
export function createUsers(options: UsersOptions): Users {
  // The component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(usersTables);

  const agentRoutes = agentUserRoutes({
    get: (id) => selectUser(handle, id),
    list: ({ limit }) => selectUsers(handle, limit),
  });

  // The two acts of wiring, both of them here so that an Operator's entry point does neither.
  // Not awaited: Fastify defers a plugin until the server is ready. So this registration is made
  // at construction and loaded at `listen`. A server already listening refuses one. A server not
  // passed is a route group that does not exist.
  options.agentServer?.fastify.register(agentRoutes, { prefix: usersPrefix });
  if (options.publicServer !== undefined) {
    // The server's own composed hook, taken and not wrapped: `GET /users/me` echoes whichever
    // User the deployment's schemes named, and this component verifies nothing itself.
    const publicRoutes = publicUserRoutes(options.publicServer.requireUser);
    options.publicServer.fastify.register(publicRoutes, { prefix: usersPrefix });
  }

  return {
    agentRoutes,

    create: (tx) => insertUser(tx),
    setAttributes: (tx, user, attributes) => updateUser(tx, user, attributes),
    get: (id) => selectUser(handle, id),
    list: (asked) => selectUsers(handle, asked?.limit ?? limitSchema.default),

    // The two no-ops, whose reason is on the type above: membership in the Gateway's record,
    // and nothing else.
    start: async () => {},
    stop: async () => {},
  };
}

// No value can be taken here. Every column of a new User is the database's default, so nothing on
// this path can carry an attribute. The query-builder form, so it works on a transaction carrying
// any component's schema.
async function insertUser<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
): Promise<UserRecord> {
  const [inserted] = await handle.insert(users).values({}).returning();
  if (inserted === undefined) {
    throw new Error("creating a User inserted no row");
  }
  return asUserRecord(inserted);
}

// The one update statement behind the one thing trusted code may change about a User. For why it
// `returning`s and throws, see the file header. The message names the id, the caller being trusted
// code reading a stack trace.
async function updateUser<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
  attributes: unknown,
): Promise<void> {
  const updated = await handle
    .update(users)
    .set({ attributes })
    .where(eq(users.id, user))
    .returning({ id: users.id });
  if (updated.length === 0) {
    throw new Error(`no User ${user} exists`);
  }
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

// The row as every surface reads it, and the three columns are the whole row.
function asUserRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    attributes: row.attributes,
    createdAt: row.createdAt.toISOString(),
  };
}
