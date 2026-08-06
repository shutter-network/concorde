/**
 * The agent's container, from the package root.
 *
 * The package root rather than `./pi`, because nothing here knows about an Agent
 * Implementation. An Agent Container declares an image, what it sees on disk, and how it is
 * confined. A second Runtime needs the same declaration unchanged.
 *
 *  - `AgentContainer` is the declaration, and only its `image` is required.
 *  - `createAgentContainerRuntime` turns one plus a single function into a Runtime.
 *  - `mountArguments` turns what the container sees on disk into `--mount` arguments.
 */

export type {
  AgentContainer,
  AgentContainerRuntime,
  AgentContainerRuntimeSpec,
  ComposedCommand,
  RunPlan,
} from "./agent-container.ts";
export { createAgentContainerRuntime } from "./agent-container.ts";
export type { Mount, MountTable } from "./mount-table.ts";
export { mountArguments } from "./mount-table.ts";
