/**
 * The Users component holds the identities a Gateway knows and **nothing a person presents**. A
 * User is an opaque Gateway-issued id, a set of Attributes the Operator writes, and the moment they
 * were admitted. There is no email and no username anywhere, so the id is the only handle a User
 * has. Attributes are arbitrary JSON that nothing in the framework interprets, and they are where a
 * deployment's grouping and therefore its authorization live.
 *
 * It authenticates nobody. A credential belongs to an Auth, which owns one scheme's secret and
 * registers itself with the Public server, and that server composes every registered Auth into the
 * one `requireUser` a protected route takes. `shared-agent-framework/password-auth` is the scheme a
 * person logs into with a password.
 *
 * {@link createUsers} makes one. {@link Users} is what comes back, carrying a programmatic API that
 * admits a User, sets their Attributes and reads both. Neither write has a route anywhere: an agent
 * that could mint a User and give it a credential has minted itself an account, so admitting one is
 * the Operator's own code. {@link UserRecord} is what every surface here answers with.
 *
 * The agent's routes are `GET /users` and `GET /users/:id`, and the one Public route is
 * `GET /users/me`, which echoes the authenticated User whichever scheme named them.
 *
 * The subpath exports the `users` table beside the constructor, for the schema an Operator generates
 * their migrations from. The Messenger, the Nostr Channel, Password Auth and Nostr Auth all point a
 * foreign key at it, so a schema carrying any of them without this subpath generates a constraint
 * onto a table it never creates.
 *
 * Importing this subpath declares `request.safUser` on every `FastifyRequest` in the program,
 * whether or not the program constructs this component.
 *
 * @example
 * A Gateway with Users and a password login, and a person admitted from the Operator's own code.
 * ```ts
 * import { createGateway } from "shared-agent-framework/gateway";
 * import { createPasswordAuth } from "shared-agent-framework/password-auth";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, agentServer, publicServer }) => {
 *     const users = createUsers({ db, agentServer, publicServer });
 *     return {
 *       users,
 *       // Without an Auth on that server, GET /users/me refuses every request.
 *       passwordAuth: createPasswordAuth({ db, users, publicServer, tokenTtl: 86_400_000 }),
 *     };
 *   },
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // One transaction, so a User nobody can log in as never reaches the table.
 * const { db, users, passwordAuth } = gateway.components;
 * const admitted = await db.tx(async (tx) => {
 *   const user = await users.create(tx);
 *   await passwordAuth.setPassword(tx, user.id, "correct horse battery staple");
 *   return user;
 * });
 * console.log(`admitted ${admitted.id}, and that id is what they log in with`);
 * ```
 *
 * @module
 */

export type { UserRecord } from "./routes.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit` can
// see. It never looks inside a wrapper object. `usersSchema` keeps its prefix, because `export *`
// drops a name that resolves to two bindings. Eight components exporting a bare `schema` give a
// barrel that exports none. That is a push which creates nothing and exits 0.
export * from "./schema.ts";
export type { Users, UsersOptions } from "./users.ts";
export { createUsers } from "./users.ts";
