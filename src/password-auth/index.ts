/**
 * The Password Auth component authenticates a person by a password they traded once for a bearer
 * Token. It owns that scheme's two secrets, the scrypt digest of the password and the digest of
 * the Token, and it turns `Authorization: Bearer <token>` into the User the request acts as. It is
 * an Auth, so the Public server holds it beside every other scheme a deployment accepts and
 * composes them into the one hook a protected route takes.
 *
 * {@link createPasswordAuth} makes one, and {@link PasswordAuthOptions} is what it takes.
 * {@link PasswordAuth} is what comes back, carrying a programmatic API that replaces a password,
 * mints a Token and revokes every Token of one User. None of the three has a route anywhere.
 * {@link IssuedToken} is what a login answers with.
 *
 * The constructor registers four routes at `/auth` on the Public server: `POST /auth/tokens` is
 * the login, `PUT /auth/password` is self-service rotation, and the two `DELETE`s drop the
 * presented Token and every Token of the User. Reading back which User is authenticated is not
 * here: it is scheme-independent, so it belongs to the Users component.
 *
 * Construct Users first, whose record every outcome carries. Nothing else takes this: a component
 * with a protected route reads the Public server's hook, so which schemes a deployment accepts is
 * which Auths it constructs, and construction order inside `extend` only decides the order they
 * are asked in.
 *
 * The subpath exports the `passwords` and `tokens` tables beside the constructor, for the schema
 * an Operator generates their migrations from. Both point a foreign key at the `users` table, so a
 * schema carrying this subpath without `shared-agent-framework/users` generates a constraint onto
 * a table it never creates.
 *
 * @example
 * A Gateway a person logs into, and one route of the Operator's own behind the server's hook.
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
 *
 * // A route of the Operator's own, behind the schemes this deployment accepts.
 * gateway.components.publicServer.fastify.get(
 *   "/whoami",
 *   { preHandler: gateway.components.publicServer.requireUser },
 *   async (request) => ({ id: request.safUser.id }),
 * );
 * ```
 *
 * @module
 */

export type { PasswordAuth, PasswordAuthOptions } from "./password-auth.ts";
export { createPasswordAuth } from "./password-auth.ts";
export type { IssuedToken } from "./routes.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit` can
// see. It never looks inside a wrapper object. `passwordAuthSchema` keeps its prefix, because
// `export *` drops a name that resolves to two bindings, and a barrel exporting a bare `schema`
// from two components exports none of them. That is a push which creates nothing and exits 0.
export * from "./schema.ts";
export type { ScryptParameters } from "./secrets.ts";
