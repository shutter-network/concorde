// Every table this deployment's database holds. `drizzle.config.ts` points here and the
// `migrate` service pushes it before the Gateway starts.
//
// `export *` and not a wrapper object: `drizzle-kit` reads `Object.values` of this module and
// keeps what is a table or a schema. Tables gathered into a record push nothing, in silence.
//
// The Nostr Channel is the only Channel with tables of its own, and two of its three reference
// `saf_users.users.id`. Users is therefore not optional in this barrel: without it the push
// generates a foreign key onto a table nothing creates.

export * from "shared-agent-framework/messenger";
export * from "shared-agent-framework/nostr-channel";
export * from "shared-agent-framework/signals";
export * from "shared-agent-framework/users";
