/**
 * Everything under this directory is exported from the **package root** and not from `./pi`,
 * because nothing in it has heard of an Agent Implementation: it is what `docker run` takes and
 * what to do with the process, and a second Agent Implementation needs all of it unchanged
 * (ADR-0033). `src/pi/` is the other half and imports from here. Nothing here may import back, and
 * an import of `../pi/` is the thing to refuse in review; no lint rule enforces it.
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
