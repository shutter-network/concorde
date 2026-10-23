import { desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import type { Db, Handle } from "../db/index.ts";
import type { Component } from "../gateway/components.ts";
import { limitSchema } from "../route-conventions.ts";
import { agentUserRoutes, publicUserRoutes, type UserRecord } from "./routes.ts";
import { users, usersTables } from "./schema/index.ts";

type UsersHandle = Handle<typeof usersTables>;

const usersPrefix = "/users";

export type UsersOptions = {
  readonly db: Db;
  readonly agentServer?: {
    readonly fastify: FastifyInstance;
  };
  readonly publicServer?: {
    readonly fastify: FastifyInstance;
    readonly requireUser: preHandlerAsyncHookHandler;
  };
};

export type Users = Component & {
  readonly agentRoutes: FastifyPluginAsync;

  create<TSchema extends Record<string, unknown>>(tx: Handle<TSchema>): Promise<UserRecord>;

  /** Replaces all attributes. Throws if the user does not exist. */
  setAttributes<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    user: string,
    attributes: unknown,
  ): Promise<void>;

  get(id: string): Promise<UserRecord | undefined>;

  /** Returns newest users first; defaults to 50 records. */
  list(options?: { readonly limit?: number }): Promise<UserRecord[]>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

export function createUsers(options: UsersOptions): Users {
  const handle = options.db.handle(usersTables);

  const agentRoutes = agentUserRoutes({
    get: (id) => selectUser(handle, id),
    list: ({ limit }) => selectUsers(handle, limit),
  });

  options.agentServer?.fastify.register(agentRoutes, { prefix: usersPrefix });
  if (options.publicServer !== undefined) {
    const publicRoutes = publicUserRoutes(options.publicServer.requireUser);
    options.publicServer.fastify.register(publicRoutes, { prefix: usersPrefix });
  }

  return {
    agentRoutes,

    create: (tx) => insertUser(tx),
    setAttributes: (tx, user, attributes) => updateUser(tx, user, attributes),
    get: (id) => selectUser(handle, id),
    list: (asked) => selectUsers(handle, asked?.limit ?? limitSchema.default),

    start: async () => {},
    stop: async () => {},
  };
}

async function insertUser<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
): Promise<UserRecord> {
  const [inserted] = await handle.insert(users).values({}).returning();
  if (inserted === undefined) {
    throw new Error("User insert returned no row");
  }
  return asUserRecord(inserted);
}

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
    throw new Error(`No user ${user} exists`);
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
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(limit);
  return rows.map(asUserRecord);
}

function asUserRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    attributes: row.attributes,
    createdAt: row.createdAt.toISOString(),
  };
}
