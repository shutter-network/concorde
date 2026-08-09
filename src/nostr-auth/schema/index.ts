/**
 * What `shared-agent-framework/nostr-auth` creates in a database: the `grants` and `admitted`
 * tables, and the PostgreSQL schema they live in.
 *
 * A door and not a declaration: the tables are declared in `../schema.ts`, and this subpath
 * exists because `drizzle-kit`'s config takes file paths rather than objects, so an Operator
 * needs an entry in the export map to point at (ADR-0055). A star and not a list, so a table
 * added there arrives here without being named a second time.
 */

export * from "../schema.ts";
