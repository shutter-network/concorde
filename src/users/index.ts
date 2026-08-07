/**
 * Users, the component that holds the identities a Gateway authenticates. A User is an
 * opaque Gateway-issued id, a set of Attributes the Operator writes, and a set of Tokens. There is
 * no email and no username anywhere, so the id is the only handle a User has. Attributes are
 * arbitrary JSON that nothing in the framework interprets, and they are where a deployment's
 * grouping and therefore its authorization live.
 *
 * {@link createUsers} makes one. {@link Users} is what comes back, and it carries the methods and
 * the `requireUser` hook that the rest of a deployment reaches for. {@link UserRecord} is what
 * every surface here answers with.
 *
 * Other components take that hook rather than authenticating anybody themselves, so build this one
 * before them. Two of them also point a foreign key at the `users` table, so an Operator's barrel
 * that carries the Messenger's tables or the Nostr Channel's without this subpath's generates a
 * constraint onto a table it never creates.
 *
 * The subpath also exports the `users` and `tokens` tables, for the barrel an Operator's
 * `drizzle-kit` reads, and importing it declares `request.safUser` on every `FastifyRequest` in
 * the program, whether or not the program builds this component.
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
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, agentServer, publicServer }) => ({
 *     users: createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer }),
 *   }),
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // One transaction, so a User with no password never reaches the table.
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
