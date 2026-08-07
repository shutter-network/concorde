// Every table this deployment's database holds. `drizzle.config.ts` points here and the
// `migrate` service pushes it before the Gateway starts.
//
// `export *` and not a wrapper object: `drizzle-kit` reads `Object.values` of this module and
// keeps what is a table or a schema. Tables gathered into a record push nothing, in silence.
//
// Two specifiers, and no `shared-agent-framework/users`. Users is what the Messenger, the
// Channels, Signatures and Decisions reference, and this deployment builds none of them.

export * from "shared-agent-framework/scheduler";
export * from "shared-agent-framework/signals";
