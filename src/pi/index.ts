/**
 * The `pi` Runtime Adapter, from `shared-agent-framework/pi`.
 *
 * A subpath of its own so that what a deployment depends on is legible from its import
 * statements: the Core, the Store and the servers come from the package root and know
 * nothing about `pi`, and swapping the Agent Runtime is a change to one import and one
 * configuration object (ADR-0016, ADR-0026).
 *
 * What is here is everything the adapter does *around* starting a container:
 *
 *  - `resolvePiConfiguration` settles and checks a configuration, so a deployment with
 *    a relative mount path or an unusable Agent server URL is refused at startup
 *    rather than at its first Signal.
 *  - `composeInvocation` builds the container invocation for one Run.
 *  - `writeRunConfiguration` writes the agent's configuration files, fresh, and makes
 *    the Session its own directory.
 *  - `interpretPiOutput` reads the JSONL event stream into a Run outcome. This is where
 *    the three traps ADR-0025 records live, and it is worth reading before changing:
 *    the exit code says nothing, the terminal record is `agent_settled` and not
 *    `agent_end`, and the framing is LF-only.
 *
 * Starting the container is not here yet. These are pure functions and file writes, so
 * every one of them is exercised in CI with no Docker, no credentials, and no network.
 */

export type {
  Mount,
  OpaqueJson,
  PiConfiguration,
  ResolvedMount,
  ResolvedPiConfiguration,
} from "./configuration.ts";
export { resolveMount, resolvePiConfiguration } from "./configuration.ts";
export type { PiInvocation } from "./invocation.ts";
export { composeInvocation, instructionsFileName } from "./invocation.ts";
export { interpretPiOutput } from "./output.ts";
export { writeRunConfiguration } from "./run-files.ts";
