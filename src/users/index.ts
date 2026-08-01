/**
 * The User Directory, from `shared-agent-framework/users`.
 *
 * A subpath of its own, like the `pi` adapter's, so that what a deployment depends
 * on is legible from its import statements: the Core and the Store come from the
 * package root and know nothing about Users, and a deployment with no identity in it
 * imports nothing from here (ADR-0029).
 *
 * `createUsers` is the whole of it for an Operator: hand it the Store and a Token
 * lifetime, add `usersMigrations` to the `store.migrate` call already being made, and
 * register `agentRoutes` on the Agent server and `publicRoutes` on the Public one,
 * each under a prefix of your choosing.
 */

export { usersMigrations } from "./migrations.ts";
export type { UserRecord } from "./routes.ts";
export type { ScryptParameters } from "./secrets.ts";
export type { Users, UsersOptions } from "./users.ts";
export { createUsers } from "./users.ts";
