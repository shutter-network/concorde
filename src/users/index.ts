/**
 * The User Manager, from `shared-agent-framework/users`.
 *
 * A subpath of its own, like the `pi` adapter's, so that what a deployment depends
 * on is legible from its import statements: the Signal Worker comes from
 * `shared-agent-framework/signals` and the Db from the package root, neither knows anything
 * about Users, and a deployment with no identity in it imports nothing from here (ADR-0029).
 *
 * `createUsers` is the whole of it for an Operator: hand it the Db, a Token lifetime
 * and the servers its two route groups belong on, and it registers `agentRoutes` under
 * `/users` and `publicRoutes` under `/auth` (ADR-0032). Then put it in the Gateway's record
 * like every other part: it is a Component
 * whose `start` and `stop` do nothing, because the record holds every part and not only the
 * ones that run (ADR-0037).
 *
 * It registers **no migration** and applies no DDL: the tables it needs come from
 * `shared-agent-framework/users/schema`, which an Operator barrels into their own
 * `drizzle.config.ts` and applies with their own `drizzle-kit`
 * ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md)). The two route plugins
 * stay exported because a server option is a default rather than a policy: register either
 * yourself, under your own prefix or inside your own encapsulated plugin, and omit the
 * server it would have gone on.
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

export type { IssuedToken, UserRecord } from "./routes.ts";
export type { ScryptParameters } from "./secrets.ts";
export type { Users, UsersOptions } from "./users.ts";
export { createUsers } from "./users.ts";
