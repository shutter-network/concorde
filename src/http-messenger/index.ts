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
 * What it answers with is worth holding, and it is two methods: `send`, which writes a
 * Message to one User from inside the caller's own transaction, and `history`, which reads
 * any User's log. Those are what trusted code has that no request does: a write that commits
 * with the Operator's own (ADR-0023), and a read a Signal Handler can build a Prompt from.
 * There is deliberately no method that writes an **inbound** Message: `direction` is decided
 * by the server a request arrived on, and nothing here puts words in a User's mouth
 * (ADR-0034).
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
 * `messageReceivedKind` and `MessageRecord` are the two halves of this part's Signal
 * contract, and they are here so that an Operator's Handler map is neither a string literal
 * that can drift nor a payload shape re-declared by hand: a Handler for a submitted Message
 * is `SignalHandler<MessageRecord>`, and `templateHandler<MessageRecord>` type-checks its
 * template's data function against the same record every surface of this part answers with
 * (ADR-0034). Registering no Handler for that `kind` is a 201 followed by a permanently
 * failed Signal: the Message is stored and readable and the agent never sees it (ADR-0017).
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
export { createHttpMessenger, messageReceivedKind } from "./http-messenger.ts";
export type { MessageRecord } from "./messages.ts";
export { httpMessagesMigrations } from "./migrations.ts";
