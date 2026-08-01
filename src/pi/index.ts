/**
 * The `pi` Runtime Adapter, from `shared-agent-framework/pi`.
 *
 * A subpath of its own so that what a deployment depends on is legible from its import
 * statements: the Core, the Store and the servers come from the package root and know
 * nothing about `pi`, and swapping the Agent Runtime is a change to one import and one
 * configuration object (ADR-0016, ADR-0026).
 *
 * `createPiAdapter` is the whole of it for an Operator: hand it the agent's
 * configuration, call `verifyMounts()` before starting the Core, and pass it as the
 * Core's `runtime`. Everything below is what it is made of, exported because each is
 * useful on its own and because that is what makes the adapter's own order — compose,
 * write, start, interpret — inspectable rather than a claim:
 *
 *  - `resolvePiConfiguration` settles and checks a configuration, so a deployment with
 *    a relative mount path is refused at startup rather than at its first Signal. What
 *    it settles it does not rewrite: `agentServerUrl` comes back exactly as supplied.
 *  - `composeInvocation` builds the container invocation for one Run.
 *  - `writeRunConfiguration` writes the agent's configuration files, fresh, and makes
 *    the Session its own directory.
 *  - `interpretPiOutput` reads the JSONL event stream into a Run outcome. This is where
 *    the three traps ADR-0025 records live, and it is worth reading before changing:
 *    the exit code says nothing, the terminal record is `agent_settled` and not
 *    `agent_end`, and the framing is LF-only.
 *
 * Everything but `createPiAdapter` is a pure function or a file write, and is exercised
 * in CI with no Docker, no credentials and no network.
 */

export type { PiAdapterOptions, PiRuntime } from "./adapter.ts";
export { createPiAdapter } from "./adapter.ts";
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
