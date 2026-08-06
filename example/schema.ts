/**
 * Every table this deployment's database holds, in one place, because this deployment
 * owns its database and the framework applies nothing to it
 * ([ADR-0046](../docs/adr/0046-the-operator-owns-migrations.md)).
 *
 * `drizzle.config.ts` points at this file and `migrate/Dockerfile` pushes it. Nothing
 * imports it at runtime: the Gateway queries through each part's own handle and never
 * reads this barrel.
 *
 * **This list and the parts `main.ts` constructs are two lists, and nothing keeps them
 * in agreement** (ADR-0046, cost 2). Construct a part and forget it here and its tables
 * are simply absent, felt as a PostgreSQL "relation does not exist" on the first query
 * that needs them. So the five below are the five `createGateway` builds and `extend`
 * returns — the Signal Worker, which the framework builds for every deployment, and the
 * four opinionated parts. Signatures is not here and has no schema: it stores nothing
 * ([ADR-0042](../docs/adr/0042-a-signature-is-a-compact-jws.md)).
 *
 * **The User Manager is not optional while the HTTP Messenger is here.** `messages.user_id`
 * references `saf_users.users.id` in code (ADR-0036, ADR-0046), so a barrel carrying one
 * without the other generates a foreign key onto a table it never creates and the push
 * dies with `schema "saf_users" does not exist`.
 *
 * `export *` and not a wrapper object, because `drizzle-kit` reads `Object.values` of
 * this module and keeps whatever passes `is(x, PgTable)` or `is(x, PgSchema)` without
 * ever looking inside a plain object. A barrel that gathered the tables into one exported
 * record would push nothing at all, in silence.
 */

export * from "shared-agent-framework/decisions/schema";
export * from "shared-agent-framework/http-messenger/schema";
export * from "shared-agent-framework/scheduler/schema";
export * from "shared-agent-framework/signals/schema";
export * from "shared-agent-framework/users/schema";
