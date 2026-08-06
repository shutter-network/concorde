/**
 * The `pi` Agent Implementation, from `shared-agent-framework/pi`.
 *
 * A subpath of its own so that what a deployment depends on is legible from its import
 * statements: the Signal Worker comes from `shared-agent-framework/signals` and the Db from
 * the package root, neither knows anything about `pi`, and swapping the Agent Implementation
 * is a change to one import and one function name (ADR-0016, ADR-0026).
 *
 * There are three things here, and two of them are pure functions:
 *
 *  - `createPiRuntime` is the whole of it for an Operator: hand it an **Agent Container**
 *    — from the package root, because nothing about a container is `pi`'s — and pass what
 *    comes back as the Signal Worker's `runtime`. It contributes two overridable defaults
 *    and `piRun`, and nothing else.
 *  - `piRun` is what makes it `pi` rather than any other agent: a Prompt in, and the
 *    flags, the stdin and the outcome reader for one Run out. Exported because it is what
 *    an author of a second Agent Implementation should read: this is the entire size of
 *    the job (ADR-0033).
 *  - `interpretPiOutput` reads the JSONL event stream into a Run outcome. This is where
 *    the three traps ADR-0025 records live, and it is worth reading before changing: the
 *    exit code says nothing, the terminal record is `agent_settled` and not `agent_end`,
 *    and the framing is LF-only.
 *
 * There is no configuration type, no resolver and no invocation composer, because there
 * is no `pi`-shaped configuration left: the image, the mounts, the networks, the
 * environment and the flags describe a container and come from the package root, and the
 * model, the provider, the working directory and the agent's own directory are the
 * Operator's to put in a `settings.json` they mount and a `Dockerfile` they build. The
 * framework writes no file and names no path (ADR-0025, ADR-0028, ADR-0033).
 *
 * Everything but the container it starts is pure, and is exercised in CI with no Docker,
 * no credentials and no network.
 */

export { interpretPiOutput } from "./output.ts";
export { createPiRuntime, piRun } from "./runtime.ts";
