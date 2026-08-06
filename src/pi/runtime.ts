/**
 * The `pi` Agent Implementation: an Agent Container, and one function.
 *
 * There is no configuration here and no orchestration either. Everything about running an agent as
 * a container is the Agent Container Runtime's, and it knows nothing about `pi`. That covers the
 * argument assembly, the confinement flags, the mounts, the networks and the environment. It also
 * covers spawning, stdin, stderr, the exit status and the diagnosis appended to a failure. What is
 * left, and the whole of what `pi` adds, is `piRun`. Given a Prompt, it says what to put after the
 * image name and what to write on stdin. It also says how to read the answer.
 *
 * A container rather than this process, which is the load-bearing decision underneath all of it.
 * `pi`'s shell tool hands its child `{ ...process.env }`. So an in-process agent would hold the
 * Gateway's `DATABASE_URL` and could write to every table directly. Only what the container's `env`
 * names reaches the agent.
 *
 * Nothing here names a path, a model or a provider. The model and the provider are `defaultModel`
 * and `defaultProvider` in a `settings.json` the Operator mounts. The working directory and the
 * agent's own directory are `WORKDIR` and `PI_CODING_AGENT_DIR` in the image. Every deployment
 * builds that image, because no `pi` image is published. The Session directory is `pi`'s own to
 * resolve.
 *
 * The framework carries none of them, which also means it can refuse none of them. A deployment
 * missing any is a Gateway that starts, serves, and fails its first Run permanently.
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
 * Two defaults, spread beneath the Operator's own, which is the whole extension mechanism. There is
 * no registration, no base to extend and no lifecycle to implement. Both are conveniences rather
 * than rules, and an Operator who states either gets what they asked for:
 *
 *  - `entrypoint: ["pi"]`, for an image that starts something else. A `pi` installed somewhere
 *    unusual is then a field rather than a workaround in `extraArgs`.
 *  - `PI_OFFLINE`, because a Gateway has no use for `pi`'s version check and its update
 *    telemetry. A Run must not depend on reaching `pi.dev`.
 *
 * @param container The container one Run happens in. Only `image` is required.
 * @returns A Runtime to pass as `createGateway`'s `runtime`, plus `commandFor` for reading the
 *   composed command line without starting anything.
 * @throws If the image is empty, or if the Mount Table cannot mean what it says.
 *
 * @example
 * ```ts
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 *
 * const runtime = createPiRuntime({
 *   image: "my-agent:1",
 *   networks: ["saf_default"],
 *   env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
 * });
 *
 * // The command line, without starting a container: the one way to see the defaults applied.
 * console.log(runtime.commandFor({ session: "notes", text: "say hello" }).redactedArgs);
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime,
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   handlers: () => ({
 *     "note.written": templateHandler({
 *       template: new URL("./prompts/note-written.hbs", import.meta.url),
 *       session: () => "notes",
 *       data: (signal) => signal.payload,
 *     }),
 *   }),
 * });
 *
 * await gateway.start();
 * ```
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
 * One Run, as `pi` needs it performed: three flags and the Prompt.
 *
 * The Prompt goes on stdin, never argv, and that is not a style choice. `pi` reads a leading
 * `@word` as a file to include. It refuses an argument starting with `-` as an unknown option. Both
 * are ordinary Handlebars output. Piped stdin becomes the initial message with neither treatment
 * applied.
 *
 * Pure, and a total function of its Prompt. The Session is already a name by the time it gets here.
 * The Signal Worker resolved a Handler's request for a fresh one against the Run row it had just
 * written. There is nothing to generate and no naming convention of `pi`'s own.
 *
 * Read this when writing a second Agent Implementation. It is the entire size of the job.
 *
 * @param prompt The Prompt and the Session it belongs to.
 * @returns The agent's arguments, its stdin, and the reader for its stdout.
 * @throws If the Prompt has no text. The agent drops an empty message rather than answering it.
 *
 * @example
 * ```ts
 * import { piRun } from "shared-agent-framework/pi";
 *
 * const plan = piRun({ session: "user_42", text: "summarise the log" });
 * console.log(plan.args); // ["--mode", "json", "--session-id", "user_42", "--no-approve"]
 * console.log(plan.stdin); // "summarise the log"
 * ```
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
