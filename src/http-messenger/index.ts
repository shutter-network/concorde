/**
 * The HTTP Messenger, from `shared-agent-framework/http-messenger`.
 *
 * A subpath of its own, like the User Directory's, so that what a deployment depends on is
 * legible from its import statements: a deployment with no messaging in it imports nothing
 * from here, and one that does is stating that it accepts this part's four declined
 * freedoms rather than the framework's last word on messaging (ADR-0034).
 *
 * `createHttpMessenger` is the whole of it for an Operator: hand it the Db, the User
 * Directory, the Signal Worker and both servers, and it registers `httpMessagesMigrations`
 * with that Db and its two route groups at `/messages` on the two servers (ADR-0032). It is
 * not a Component and goes in no start order: there is nothing here to start and nothing to
 * release.
 *
 * **Construct it after the User Directory.** `messages.user_id` is a foreign key onto
 * `saf_users.users.id`, `db.migrate()` applies descriptors in registration order, and
 * registration order is construction order — so the other way round fails with PostgreSQL's
 * `schema "saf_users" does not exist` (ADR-0036).
 *
 * `httpMessagesMigrations` is exported because a pre-deploy migration entry point should not
 * have to construct the part that owns the tables — and, for this part, should not have to
 * construct a Signal Worker and a Runtime to get at them.
 *
 * **No route plugin is exported**, unlike every other part's, and no prefix is configurable.
 * That is this part's stated departure from ADR-0032's door-out pattern: an Operator who
 * needs these routes somewhere else wants a different messaging Producer (ADR-0034,
 * ADR-0021).
 *
 * The reserved and deliberately unresolvable `./messenger` subpath stays reserved, and now
 * says something it did not say before: that *the* Messenger is not what shipped.
 */

export type { HttpMessenger, HttpMessengerOptions } from "./http-messenger.ts";
export { createHttpMessenger } from "./http-messenger.ts";
export type { MessageRecord } from "./messages.ts";
export { httpMessagesMigrations } from "./migrations.ts";
