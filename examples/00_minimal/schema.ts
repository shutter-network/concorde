// Every table this deployment's database holds. `drizzle.config.ts` points here and the
// `migrate` service pushes it before the Gateway starts.
//
// `export *` and not a wrapper object: `drizzle-kit` reads `Object.values` of this module and
// keeps what is a table or a schema. Tables gathered into a record push nothing, in silence.
//
// Four specifiers for five components. The HTTP Channel owns no tables: it stores nothing and
// queues nothing, because HTTP delivery is the User asking. Password Auth owns two, the password
// digests and the Tokens, and both reference `saf_users.users.id`, as does the Messenger's one
// table. Leave any of the three out and the push builds a foreign key onto a table nothing
// creates, or leaves the first login asking for a relation that does not exist.

export * from "shared-agent-framework/messenger";
export * from "shared-agent-framework/password-auth";
export * from "shared-agent-framework/signals";
export * from "shared-agent-framework/users";
