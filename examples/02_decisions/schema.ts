// Every table this deployment's database holds. `drizzle.config.ts` points here and the
// `migrate` service pushes it before the Gateway starts.
//
// `export *` and not a wrapper object: `drizzle-kit` reads `Object.values` of this module and
// keeps what is a table or a schema. Tables gathered into a record push nothing, in silence.
//
// Five specifiers for six components. Signatures owns none, because a Signed Statement is never
// kept: the artifact is handed to whoever asked for it and no row records that it exists. The
// HTTP Channel owns none either, because HTTP delivery is the User asking, so there is nothing to
// store and nothing to queue. Decisions owns one and references no other component's table, a
// Decision being addressed to nobody.

export * from "shared-agent-framework/decisions";
export * from "shared-agent-framework/messenger";
export * from "shared-agent-framework/password-auth";
export * from "shared-agent-framework/signals";
export * from "shared-agent-framework/users";
