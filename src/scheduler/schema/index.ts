/**
 * What `shared-agent-framework/scheduler` creates in a database: the `schedules` table,
 * and the PostgreSQL schema it lives in.
 *
 * A door and not a declaration: the tables are declared in `../schema.ts`, and this subpath
 * exists because `drizzle-kit`'s config takes file paths rather than objects, so an Operator
 * needs an entry in the export map to point at (ADR-0055). A star and not a list, so a table
 * added there arrives here without being named a second time.
 */

export * from "../schema.ts";
