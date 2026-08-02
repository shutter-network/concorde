/**
 * The `pi` Runtime, from `shared-agent-framework/pi`.
 *
 * A subpath of its own so that what a deployment depends on is legible from its import
 * statements: the Signal Worker and the Db come from the package root and know nothing about
 * `pi`, and swapping the Agent Implementation is a change to one import and one
 * configuration object (ADR-0016, ADR-0026).
 *
 * `createPiAdapter` is the whole of it for an Operator: hand it the agent's
 * configuration and pass what comes back as the Signal Worker's `runtime`. It is a plain
 * Runtime, with nothing to call before starting. Everything below is what it
 * is made of, exported because each is useful on its own and because that is what
 * makes the adapter's own order — compose, start, interpret — inspectable rather than
 * a claim:
 *
 *  - `resolvePiConfiguration` settles and checks a configuration, so a deployment with
 *    a relative container path or an unusable Mount Table is refused at startup rather
 *    than at its first Signal. The Mount Table itself is not `pi`'s and comes from the
 *    package root, not from here.
 *  - `composeInvocation` builds the container invocation for one Run.
 *  - `interpretPiOutput` reads the JSONL event stream into a Run outcome. This is where
 *    the three traps ADR-0025 records live, and it is worth reading before changing:
 *    the exit code says nothing, the terminal record is `agent_settled` and not
 *    `agent_end`, and the framing is LF-only.
 *
 * There is nothing here that writes the agent's configuration, because the framework
 * writes no files: `settings.json`, `models.json` and the `AGENTS.md` that tells the
 * agent about the Agent server are placed by the Operator in the directories they mount,
 * and `pi` finds all three by itself (ADR-0025, ADR-0028).
 *
 * Everything but `createPiAdapter` is a pure function, and is exercised in CI with no
 * Docker, no credentials and no network.
 */

export type { PiAdapterOptions } from "./adapter.ts";
export { createPiAdapter } from "./adapter.ts";
export type { PiConfiguration, ResolvedPiConfiguration } from "./configuration.ts";
export { resolvePiConfiguration } from "./configuration.ts";
export type { PiInvocation } from "./invocation.ts";
export { composeInvocation } from "./invocation.ts";
export { interpretPiOutput } from "./output.ts";
