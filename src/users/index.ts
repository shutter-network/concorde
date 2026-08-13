/**
 * The Users component holds the identities a Gateway knows and **nothing a person presents**. A
 * User is an opaque Gateway-issued id, a set of Attributes the Operator writes, and the moment they
 * were admitted. There is no email and no username anywhere, so the id is the only handle a User
 * has. Attributes are arbitrary JSON that nothing in the framework interprets, and they are where a
 * deployment's grouping and therefore its authorization live.
 *
 * It authenticates nobody. A credential belongs to an Auth, which owns one scheme's secret and
 * registers itself with the Public server, and that server composes every registered Auth into the
 * one `requireUser` a protected route takes. `@shutter-network/concorde/password-auth` is the
 * scheme a person logs into with a password.
 *
 * {@link createUsers} makes one. {@link Users} is what comes back, carrying a programmatic API that
 * admits a User, sets their Attributes and reads both. Neither write has a route anywhere: an agent
 * that could mint a User and give it a credential has minted itself an account, so admitting one is
 * the Operator's own code. {@link UserRecord} is what every surface here answers with.
 *
 * The agent's routes are `GET /users` and `GET /users/:id`, and the one Public route is
 * `GET /users/me`, which echoes the authenticated User whichever scheme named them.
 *
 * The tables are not here. `@shutter-network/concorde/users/schema` is the subpath an Operator
 * points their `drizzle-kit` at, and it is the only place the `users` table is reachable from. The
 * Messenger, the Nostr Channel, Password Auth and Nostr Auth all point a foreign key at that table,
 * so a configuration listing any of their schema subpaths without this one generates a constraint
 * onto a table it never creates.
 *
 * Importing this subpath declares `request.concordeUser` on every `FastifyRequest` in the program,
 * whether or not the program constructs this component.
 *
 * @example
 * A Gateway with Users and a password login, and a person admitted from the Operator's own code.
 * ```ts
 * import { createGateway } from "@shutter-network/concorde/gateway";
 * import { createPasswordAuth } from "@shutter-network/concorde/password-auth";
 * import { createPiRuntime } from "@shutter-network/concorde/pi";
 * import { createUsers } from "@shutter-network/concorde/users";
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
export type { Users, UsersOptions } from "./users.ts";
export { createUsers } from "./users.ts";
