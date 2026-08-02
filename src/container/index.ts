/**
 * The agent's container, from the package root.
 *
 * The package root rather than `./pi`, because nothing here knows about an Agent
 * Implementation: an Agent Container is a declaration of an image, what it sees on disk
 * and how it is confined, and the same one would serve a second Runtime unchanged
 * (ADR-0026, ADR-0028, ADR-0033).
 *
 *  - `AgentContainer` is the declaration, and only its `image` is required.
 *  - `createAgentContainerRuntime` turns one plus a single function into a Runtime, and
 *    that function is the whole of what an Agent Implementation adds.
 *  - `resolveMountTable` settles what the container sees on disk into `--mount`
 *    arguments, and refuses a table that cannot mean what it says.
 */

export type {
  AgentContainer,
  AgentContainerRuntime,
  AgentContainerRuntimeSpec,
  ComposedCommand,
  RunPlan,
} from "./agent-container.ts";
export { createAgentContainerRuntime } from "./agent-container.ts";
export type { Mount, MountTable, ResolvedMount, ResolvedMountTable } from "./mount-table.ts";
export { resolveMountTable } from "./mount-table.ts";
