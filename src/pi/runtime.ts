/**
 * A container rather than this process, which is the load-bearing decision underneath all of
 * `src/pi/`. Driving `pi` in-process through its TypeScript SDK is real, and it was rejected on
 * exposure: `pi`'s shell tool hands its child `{ ...process.env }`, so an in-process agent would
 * hold the Gateway's `DATABASE_URL` and could write to every table directly, bypassing the Agent
 * server. Only what the container's `env` names reaches the agent.
 *
 * The split with `src/agent-container/` runs one way. Everything about running an agent as a
 * container lives there and knows nothing about `pi`: the argument assembly, the confinement flags,
 * the mounts, the networks, the environment, the spawning, stdin, stderr, the exit status and the
 * diagnosis appended to a failure. This file imports from it and nothing there imports back, and an
 * import of `../pi/` into that directory is the thing to refuse in review, because the whole point
 * of the split is that a second Agent Implementation takes it unchanged.
 */

import {
  type AgentContainer,
  type AgentContainerRuntime,
  createAgentContainerRuntime,
  type RunPlan,
} from "../agent-container/index.ts";
import type { RunPrompt } from "../signals/runtime.ts";
import { interpretPiOutput } from "./output.ts";

/**
 * Builds a Runtime that runs `pi` as one fresh container per Run, of the image the container names.
 *
 * Two defaults sit beneath the Operator's own, and a container stating either one gets what it
 * asked for. `entrypoint` is `["pi"]`, so an image that starts something else, or a `pi` installed
 * somewhere unusual, is a field rather than a workaround. `PI_OFFLINE` is set, because a Gateway has
 * no use for `pi`'s version check and its update telemetry, and a Run must not depend on reaching
 * `pi.dev`.
 *
 * @throws If the container names no image, or if its Mount Table cannot mean what it says.
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
 * Plans one Run as `pi` needs it performed: three flags, the Prompt on stdin, and a reader for the
 * JSONL that comes back. The flags are `--mode json`, `--session-id <session>` and `--no-approve`,
 * and nothing else is passed.
 *
 * The Prompt goes on stdin, never argv, and that is not a style choice. `pi` reads a leading `@word`
 * on argv as a file to include, and refuses an argument starting with `-` as an unknown option. Both
 * are ordinary Handlebars output. Piped stdin becomes the initial message with neither treatment
 * applied.
 *
 * Pure, and a total function of its Prompt. Nothing is started, nothing is written, and no Session
 * name is invented: the Session is already a name by the time it arrives here, the Signal Worker
 * having answered a Handler's request for a fresh one against the Run row it had just written. The
 * reader is {@link interpretPiOutput}, closed over that Session, so a failure says which Session it
 * was.
 *
 * @throws If the Prompt has no text. The agent drops an empty message rather than answering it, so
 *   the Run would settle having said nothing.
 */
export function piRun(prompt: RunPrompt): RunPlan {
  if (prompt.text.trim() === "") {
    throw new Error(
      "the Prompt has no text, and the Agent Implementation drops an empty message rather than answering it, so the Run would settle having said nothing",
    );
  }

  return {
    args: [
      // The machine-readable event stream. Note it exits 0 on model and API errors, so the outcome
      // is read from the stream and never from the exit code (see output.ts).
      "--mode",
      "json",
      // `--session-id`, never `--session`: this one creates the Session if it is missing, which is
      // the fresh-or-named behaviour a Prompt asks for. The other resolves only an existing Session
      // and exits 1 otherwise.
      "--session-id",
      prompt.session,
      // No `--model`, no `--provider`, no `--session-dir`, and no flag naming a file. The first two
      // are `defaultModel` and `defaultProvider` in a `settings.json` the Operator mounts. The third
      // is `pi`'s own to resolve, under the agent directory the image declares. The framework writes
      // no file, so it has none to name. That last one would make things worse rather than merely
      // being unnecessary: `--append-system-prompt` resolves a missing path to its own literal
      // argument, and the Run then settles happily knowing nothing.
      //
      // Project-local `.pi` settings and extensions are ignored, and that is load-bearing rather
      // than tidy. The Workspace is writable by the agent, so a saved trust decision in the
      // persisted `trust.json` would let one Run arrange for the next one to load configuration out
      // of the Workspace. Context files are not project-local configuration and are unaffected,
      // which is what makes a read-only `AGENTS.md` both readable and unchangeable.
      "--no-approve",
    ],
    stdin: prompt.text,
    // Closed over the Session, which is the whole reason the reader is produced per Run: a failure
    // says which Session it was, and that is what a Run's `error` column needs to be worth reading.
    outcome: (stdout) => interpretPiOutput(stdout, prompt.session),
  };
}
