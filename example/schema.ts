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
 * that needs them. So the six below are the parts with tables that `createGateway` builds
 * and `extend` returns — the Signal Worker, which the framework builds for every deployment,
 * and five of the seven components. Signatures and the HTTP Channel are not here and
 * have no schema: neither stores anything, and the log a Channel's Messages land in is the
 * Messenger's ([ADR-0042](../docs/adr/0042-a-signature-is-a-compact-jws.md),
 * [ADR-0048](../docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). A
 * Channel is not a tableless kind of thing, though: a deployment running the Nostr Channel in
 * place of the HTTP one adds `shared-agent-framework/nostr-channel` here for its three tables
 * ([ADR-0049](../docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)).
 *
 * **The Users component is not optional while the Messenger or Password Auth is here.**
 * `messages.user_id` references `saf_users.users.id` in code (ADR-0036, ADR-0046), and so do
 * Password Auth's `passwords.user_id` and `tokens.user_id`
 * ([ADR-0052](../docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)),
 * so a barrel carrying any of them without Users generates a foreign key onto a table it never
 * creates and the push dies with `schema "saf_users" does not exist`. The Nostr Channel's
 * `pubkeys.user_id` and `outbox.user_id` are the same requirement for a barrel that carries it
 * (ADR-0049).
 *
 * `export *` and not a wrapper object, because `drizzle-kit` reads `Object.values` of
 * this module and keeps whatever passes `is(x, PgTable)` or `is(x, PgSchema)` without
 * ever looking inside a plain object. A barrel that gathered the tables into one exported
 * record would push nothing at all, in silence.
 *
 * **Six component specifiers and no aliases**, because a component is one subpath: the tables
 * arrive from the same six specifiers `main.ts` imports from
 * ([ADR-0047](../docs/adr/0047-a-component-is-one-subpath.md)). `main.ts` names four more,
 * `/gateway`, `/pi`, `/http-channel` and `/signatures`, and none of those four owns a table.
 * There is no bare `shared-agent-framework` in either file, the package having no root export
 * ([ADR-0051](../docs/adr/0051-the-package-root-exports-nothing.md)). Each one carries its
 * constructor and its routes along with its tables, which costs this one-shot container a few
 * milliseconds and buys one specifier per component instead of two. No alias is needed because
 * every schema object keeps its component prefix, `usersSchema` beside `passwordAuthSchema`
 * and four more, and `export *` **drops a name that resolves to two bindings**, so six bare
 * `schema` exports would leave this barrel with none, the `schemaFilter` in `drizzle.config.ts`
 * empty, and a push that creates nothing and exits 0. The `tokens` table is the live case: it
 * is `saf_password_auth.tokens` and nothing else declares that name any more, which is what
 * lets this barrel carry both `/users` and `/password-auth` at all (ADR-0052).
 */

export * from "shared-agent-framework/decisions";
export * from "shared-agent-framework/messenger";
export * from "shared-agent-framework/scheduler";
export * from "shared-agent-framework/signals";
export * from "shared-agent-framework/users";
