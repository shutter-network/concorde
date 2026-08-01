/**
 * What the agent's container sees on disk, from the package root.
 *
 * The package root rather than `./pi`, because nothing here knows about an Agent
 * Runtime: a Mount Table is a declaration of directories, files and a user, and the same
 * one would serve a second Runtime Adapter unchanged (ADR-0026, ADR-0028).
 */

export type { Mount, MountTable, ResolvedMount, ResolvedMountTable } from "./mount-table.ts";
export { resolveMountTable } from "./mount-table.ts";
