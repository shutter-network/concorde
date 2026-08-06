/**
 * The User Manager, from `shared-agent-framework/users`.
 *
 * `createUsers` is the whole of it for an Operator. Hand it the Db, a Token lifetime and the
 * servers its two route groups belong on. It registers `agentRoutes` under `/users` and
 * `publicRoutes` under `/auth`. Then put it in the Gateway's record like every other Component.
 *
 * This subpath also carries the two tables, for the schema an Operator generates. It applies no
 * DDL itself. Importing it types `request.safUser` on every `FastifyRequest` in your program.
 *
 * @example
 * A Gateway with Users, and a User admitted from the Operator's own code.
 * ```ts
 * import { createGateway } from "shared-agent-framework";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   agentListen: { host: "127.0.0.1", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, agentServer, publicServer }) => ({
 *     users: createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer }),
 *   }),
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // A User with a password, which a client trades for a Token at `POST /auth/tokens`.
 * const { db, users } = gateway.components;
 * const admitted = await db.tx(async (tx) => {
 *   const user = await users.create(tx);
 *   await users.setPassword(tx, user.id, "correct horse battery staple");
 *   return user;
 * });
 * console.log(`admitted ${admitted.id}, and that id is what they log in with`);
 * ```
 *
 * @module
 */

export type { IssuedToken, UserRecord } from "./routes.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit` can
// see. It never looks inside a wrapper object. `usersSchema` keeps its prefix, because `export *`
// drops a name that resolves to two bindings. Five components exporting a bare `schema` give a
// barrel that exports none. That is a push which creates nothing and exits 0.
export * from "./schema.ts";
export type { ScryptParameters } from "./secrets.ts";
export type { Users, UsersOptions } from "./users.ts";
export { createUsers } from "./users.ts";
