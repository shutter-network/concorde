/**
 * The User Directory, from `shared-agent-framework/users`.
 *
 * A subpath of its own, like the `pi` adapter's, so that what a deployment depends
 * on is legible from its import statements: the Signal Worker and the Db come from the
 * package root and know nothing about Users, and a deployment with no identity in it
 * imports nothing from here (ADR-0029).
 *
 * `createUsers` is the whole of it for an Operator: hand it the Db and a Token
 * lifetime, register `usersMigrations` with that Db, and register `agentRoutes` on
 * the Agent server and `publicRoutes` on the Public one, each under a prefix of
 * your choosing.
 *
 * `IssuedToken` is here because `users.issueToken` answers with one, and that method is
 * the substitute for a pluggable Authenticator: a deployment's own OIDC route
 * establishes identity however it likes and answers with this exact shape, which is
 * also what `POST /auth/tokens` answers with (ADR-0030).
 *
 * One thing arrives here without being named in an import: the `declare module
 * "fastify"` augmentation that types `request.safUser`, which travels with the
 * `UserRecord` re-exported below. It is global, so a program that imports this subpath
 * at all has the field on every `FastifyRequest` in it — accepted in ADR-0030, since
 * the alternative is a cast at every one of the Operator's own handlers.
 */

export { usersMigrations } from "./migrations.ts";
export type { IssuedToken, UserRecord } from "./routes.ts";
export type { ScryptParameters } from "./secrets.ts";
export type { Users, UsersOptions } from "./users.ts";
export { createUsers } from "./users.ts";
