import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Db, Handle } from "../db/index.ts";
import type { Auth, AuthOutcome } from "../gateway/auth.ts";
import type { UserRecord } from "../users/routes.ts";
import { users } from "../users/schema/index.ts";
import type { Users } from "../users/users.ts";
import {
  type Credentials,
  type IssuedToken,
  namesBearer,
  type PasswordChange,
  passwordRoutes,
  presentedToken,
} from "./routes.ts";
import { passwordAuthTables, passwords, tokens } from "./schema/index.ts";
import {
  checkedScryptParameters,
  defaultScryptParameters,
  hashPassword,
  hashToken,
  mintToken,
  type ScryptParameters,
  verifyPassword,
} from "./secrets.ts";

type PasswordAuthHandle = Handle<typeof passwordAuthTables>;

const authPrefix = "/auth";

const bearerScheme = "Bearer";

export type PasswordAuthOptions = {
  readonly db: Db;
  readonly users: Users;
  readonly publicServer: {
    readonly fastify: FastifyInstance;
    registerAuth(auth: Auth): void;
    readonly requireUser: preHandlerAsyncHookHandler;
  };
  /** Token lifetime in milliseconds. Must be finite and positive. */
  readonly tokenTtl: number;
  readonly scrypt?: ScryptParameters;
};

export type PasswordAuth = Auth & {
  /** Creates or replaces the password without revoking existing tokens. Throws for an unknown user. */
  setPassword<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    user: string,
    password: string,
  ): Promise<void>;

  /** Issues a token without checking a password. Keep this capability in trusted deployment code. */
  issueToken<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    user: string,
  ): Promise<IssuedToken>;

  /** Revokes all tokens of this user issued by password auth. Keeps the password and other auth credentials. */
  revoke<TSchema extends Record<string, unknown>>(tx: Handle<TSchema>, user: string): Promise<void>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

export function createPasswordAuth(options: PasswordAuthOptions): PasswordAuth {
  const handle = options.db.handle(passwordAuthTables);
  const tokenTtl = checkedTokenTtl(options.tokenTtl);
  const parameters = checkedScryptParameters(options.scrypt ?? defaultScryptParameters);
  const dummy = dummyDigest(parameters);

  const auth: PasswordAuth = {
    scheme: bearerScheme,

    async authenticate(request): Promise<AuthOutcome> {
      const header = request.headers.authorization;
      if (!namesBearer(header)) return { kind: "absent" };

      const presented = presentedToken(header);
      if (presented === undefined) {
        return {
          kind: "refused",
          code: "invalid_request",
          detail: "the Authorization header named Bearer and carried no token after it",
        };
      }

      const user = await userForToken(handle, options.users, presented);
      return user === undefined
        ? { kind: "refused", code: "invalid_token" }
        : { kind: "authenticated", user };
    },

    setPassword: (tx, user, password) => writePassword(tx, user, password, parameters),
    issueToken: (tx, user) => grantToken(tx, user, tokenTtl),
    revoke: (tx, user) => deleteTokens(tx, user),

    start: async () => {},
    stop: async () => {},
  };

  const routes = passwordRoutes(
    {
      logIn: (credentials) => logIn(handle, options.users, credentials, { dummy, tokenTtl }),
      revokeToken: (token) => deleteToken(handle, token),
      revokeTokens: (user) => deleteTokens(handle, user),
      changePassword: (change) => changePassword(handle, change, parameters),
    },
    options.publicServer.requireUser,
  );

  options.publicServer.fastify.register(routes, { prefix: authPrefix });
  options.publicServer.registerAuth(auth);

  return auth;
}

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

async function logIn(
  handle: PasswordAuthHandle,
  directory: Users,
  credentials: Credentials,
  cost: { readonly dummy: () => Promise<string>; readonly tokenTtl: number },
): Promise<IssuedToken | undefined> {
  const [row] = await handle.select().from(passwords).where(eq(passwords.userId, credentials.user));
  // Unknown users still incur the password derivation cost to reduce timing differences.
  const stored = row?.passwordHash ?? (await cost.dummy());
  const matched = await verifyPassword(stored, credentials.password);
  if (row === undefined || !matched) return undefined;

  const user = await directory.get(credentials.user);
  if (user === undefined) return undefined;

  return insertToken(handle, user, cost.tokenTtl);
}

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
      expiresAt: sql`clock_timestamp() + make_interval(secs => ${tokenTtl / 1000})`,
    })
    .returning({ expiresAt: tokens.expiresAt });
  if (issued === undefined) {
    throw new Error("issuing a Token inserted no row");
  }
  return { token: minted.token, expiresAt: issued.expiresAt.toISOString(), user };
}

async function grantToken<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
  tokenTtl: number,
): Promise<IssuedToken> {
  return insertToken(handle, await userOnHandle(handle, user), tokenTtl);
}

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

async function deleteToken(handle: PasswordAuthHandle, token: string): Promise<void> {
  await handle.delete(tokens).where(eq(tokens.tokenHash, hashToken(token)));
}

async function deleteTokens<TSchema extends Record<string, unknown>>(
  handle: Handle<TSchema>,
  user: string,
): Promise<void> {
  await handle.delete(tokens).where(eq(tokens.userId, user));
}

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

function dummyDigest(parameters: ScryptParameters): () => Promise<string> {
  let derived: Promise<string> | undefined;
  return () => (derived ??= hashPassword(mintToken().token, parameters));
}

function checkedTokenTtl(tokenTtl: number): number {
  if (!Number.isFinite(tokenTtl) || tokenTtl <= 0) {
    throw new Error(`tokenTtl must be a positive number of milliseconds, not ${tokenTtl}`);
  }
  return tokenTtl;
}
