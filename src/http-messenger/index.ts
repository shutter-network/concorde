/**
 * The HTTP Messenger, from `shared-agent-framework/http-messenger`.
 *
 * A subpath of its own, like the User Manager's, so that what a deployment depends on is
 * legible from its import statements: a deployment with no messaging in it imports nothing
 * from here, and one that does is stating that it accepts this part's four declined
 * freedoms rather than the framework's last word on messaging (ADR-0034).
 *
 * `createHttpMessenger` is the whole of it for an Operator: hand it the Db, the User
 * Manager, the Signal Worker and both servers, and it registers its two route groups at
 * `/messages` on the two servers (ADR-0032). Then
 * put it in the Gateway's record like every other part: it is a Component whose `start` and
 * `stop` do nothing today, keyed **before** the Signal Worker so that it is stopped after
 * the drain, which is when a Signal Handler's post phase reaches it (ADR-0037, ADR-0038).
 *
 * What it answers with is worth holding, and it is two methods: `send`, which writes a
 * Message to one User from inside the caller's own transaction, and `history`, which reads
 * any User's log. Those are what trusted code has that no request does: a write that commits
 * with the Operator's own (ADR-0023), and a read a Signal Handler can build a Prompt from.
 * There is deliberately no method that writes an **inbound** Message: `direction` is decided
 * by the server a request arrived on, and nothing here puts words in a User's mouth
 * (ADR-0034).
 *
 * **Construction order against the User Manager no longer matters**, and that is the one
 * change ADR-0046 makes to ADR-0036. `messages.user_id` is still a foreign key onto
 * `saf_users.users.id`, but it is declared in `schema.ts` now and ordered by the single
 * generation an Operator runs, so nothing here applies DDL and nothing can apply it in the
 * wrong order. What survives is a requirement on the *barrel*: a deployment running this
 * part must also export the User Manager's schema, or generation references a table it does
 * not create.
 *
 * It registers **no migration**. The tables are exported from here beside
 * `createHttpMessenger`, and an Operator barrels this subpath and applies it with their own
 * `drizzle-kit` ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md),
 * [ADR-0047](../../docs/adr/0047-a-component-is-one-subpath.md)).
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
 * The reserved and deliberately unresolvable `./messenger` subpath is gone from the manifest.
 * It was the placeholder for *the* Messenger, and it retired with the `/schema` subpaths
 * (ADR-0047): the export map is eight entry points, each of them a thing that exists.
 */

export type { HttpMessenger, HttpMessengerOptions } from "./http-messenger.ts";
export { createHttpMessenger, messageReceivedKind } from "./http-messenger.ts";
export type { MessageRecord } from "./messages.ts";
// The table, on this subpath and no other, a component being one door (ADR-0047). A star
// rather than a list, because a table an Operator's `drizzle-kit` cannot see as a top-level
// name is a table it silently creates nothing for (ADR-0046). What it does **not** carry is
// the User Manager's tables — `schema.ts` imports them to declare the foreign key and
// re-exports nothing — so a barrel with this component and not that one generates a
// reference to a table it never creates.
export * from "./schema.ts";
