/**
 * The `pi` Agent Implementation: an Agent Container, and one function.
 *
 * There is no configuration here and no orchestration either. Everything about running
 * an agent as a container — the argument assembly, the confinement flags, the mounts,
 * the networks, the environment, spawning, stdin, stderr, the exit status and the
 * diagnosis appended to a failure — is the Agent Container Runtime's, and knows nothing
 * about `pi` ([ADR-0033](../../docs/adr/0033-an-agent-is-a-container-and-one-function.md)).
 * What is left, and the whole of what `pi` adds, is `piRun`: given a Prompt, what to put
 * after the image name, what to write on stdin, and how to read what comes back.
 *
 * A container rather than this process, which is the load-bearing decision underneath all
 * of it ([ADR-0025](../../docs/adr/0025-the-pi-adapter-spawns-one-confined-process-per-run.md)):
 * `pi`'s shell tool hands its child `{ ...process.env }`, so an in-process agent would
 * hold the Gateway's `DATABASE_URL` and could write to every table directly. That would
 * make [ADR-0010](../../docs/adr/0010-the-agent-reaches-the-gateway-over-http.md)
 * decorative and widen [ADR-0011](../../docs/adr/0011-the-agent-has-full-read-access.md)'s
 * blast radius from "what the read API exposes" to the whole Db, read and write. Only
 * what the container's `env` names reaches the agent.
 *
 * Nothing here names a path, a model or a provider. The model and the provider are
 * `defaultModel` and `defaultProvider` in a `settings.json` the Operator mounts; the
 * working directory and the agent's own directory are `WORKDIR` and `PI_CODING_AGENT_DIR`
 * in the image, which every deployment builds because no `pi` image is published; and the
 * Session directory is `pi`'s own to resolve. The framework carries none of them, which
 * also means it can refuse none of them: a deployment missing any is a Gateway that
 * starts, serves, and fails its first Run permanently (ADR-0017, ADR-0033).
 */

import {
  type AgentContainer,
  type AgentContainerRuntime,
  createAgentContainerRuntime,
  type RunPlan,
} from "../container/index.ts";
import type { RunPrompt } from "../signals/runtime.ts";
import { interpretPiOutput } from "./output.ts";

/**
 * The `pi` Runtime: one fresh container per Run, of the image the Operator named.
 *
 * Two defaults, spread **beneath** the Operator's own, which is the whole extension
 * mechanism — there is no registration, no base to extend and no lifecycle to implement.
 * Both are conveniences rather than rules, and an Operator who states either gets what
 * they asked for:
 *
 *  - `entrypoint: ["pi"]`, so an image that starts something else, or a `pi` installed
 *    somewhere unusual, is a field rather than a workaround in `extraArgs`.
 *  - `PI_OFFLINE`, because a Gateway has no use for `pi`'s startup version check and its
 *    update telemetry, and a Run should not depend on reaching `pi.dev`.
 */
export const createPiRuntime = (container: AgentContainer): AgentContainerRuntime =>
  createAgentContainerRuntime({
    container: {
      entrypoint: ["pi"],
      ...container,
      env: { PI_OFFLINE: "1", ...container.env },
    },
    run: piRun,
  });

/**
 * One Run, as `pi` needs it performed.
 *
 * Three flags and the Prompt. The Prompt goes on **stdin, never argv**, and that is not a
 * style choice: `pi` reads a leading `@word` as a *file* to include and refuses an
 * argument starting with `-` as an unknown option, and both are ordinary Handlebars
 * output (ADR-0027). Piped stdin becomes the initial message with neither treatment
 * applied.
 *
 * Pure, and a total function of its Prompt: the Session is already a name by the time it
 * gets here, because the Signal Worker resolved a Handler's request for a fresh one
 * against the Run row it had just written (ADR-0033). There is nothing to generate and no
 * naming convention of `pi`'s own — which is the point, since a second Agent
 * Implementation would otherwise have had to invent one too.
 */
export function piRun(prompt: RunPrompt): RunPlan {
  if (prompt.text.trim() === "") {
    throw new Error(
      "the Prompt has no text, and the Agent Implementation drops an empty message rather than answering it, so the Run would settle having said nothing",
    );
  }

  return {
    args: [
      // The machine-readable event stream. Note it exits 0 on model and API errors, so
      // the outcome is read from the stream and never from the exit code (see output.ts).
      "--mode",
      "json",
      // `--session-id`, never `--session`: this one creates the Session if it is missing,
      // which is exactly the fresh-or-named semantics a Prompt asks for. The other
      // resolves only an *existing* Session and exits 1 otherwise (ADR-0006).
      "--session-id",
      prompt.session,
      // No `--model`, no `--provider`, no `--session-dir`, and no flag naming a file. The
      // first two are `defaultModel` and `defaultProvider` in a `settings.json` the
      // Operator mounts; the third is `pi`'s own to resolve, under the agent directory the
      // image declares; and the framework writes no file, so it has none to name. That
      // last one would have made things *worse* rather than merely being unnecessary:
      // `--append-system-prompt` resolves a path that is not there to its own literal
      // argument, and the Run then settles happily knowing nothing (ADR-0025).
      //
      // Project-local `.pi` settings and extensions are ignored, and that is load-bearing
      // rather than tidy: the Workspace is writable by the agent, and a saved trust
      // decision in the persisted `trust.json` would otherwise let one Run arrange for the
      // next one to load configuration out of the Workspace — a reconfiguration by
      // injection that outlives the Run that managed it (ADR-0003, ADR-0025). Context
      // files are not project-local configuration and are unaffected, which is what makes
      // a read-only `AGENTS.md` both readable and unchangeable.
      "--no-approve",
    ],
    stdin: prompt.text,
    // Closed over the Session, which is the whole reason the reader is produced per Run:
    // a failure says which Session it was, and that is what a Run's `error` column needs
    // to be worth reading (ADR-0033).
    outcome: (stdout) => interpretPiOutput(stdout, prompt.session),
  };
}
