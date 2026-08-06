/**
 * The Agent Container, and the Runtime that runs one.
 *
 * The container is inert data an Operator writes. `createAgentContainerRuntime` turns it,
 * plus one function, into the seam the Signal Worker drives. That one function is the whole of
 * what an Agent Implementation adds.
 *
 * Nothing here has heard of `pi` or of any other agent. The fields below are what `docker run`
 * takes, and a second Agent Implementation needs all of them unchanged.
 */

import { defaultLogger, type Logger } from "../logging.ts";
import type { RunOutcome, RunPrompt, Runtime } from "../signals/runtime.ts";
import { type MountTable, mountArguments } from "./mount-table.ts";
import { runContainer } from "./process.ts";

/**
 * The container one Run happens in, as an Operator declares it.
 *
 * Only `image` is required. Everything else is a default, or a fact about a deployment that
 * most deployments do not have.
 */
export type AgentContainer = {
  /** The container image. The one thing no deployment can leave out. */
  readonly image: string;
  /**
   * What the container sees on disk. Absent means nothing at all.
   *
   * That is a legitimate deployment. An image that bakes in its own configuration and keeps no
   * state mounts nothing. The cost is silent, because no Session survives a
   * `--rm` container. Every Run is then a first Run, and no log line says so.
   */
  readonly mounts?: MountTable;
  /**
   * What to run inside the image, overriding its own `ENTRYPOINT`.
   *
   * The first word becomes `--entrypoint`, which takes exactly one. Anything after it goes
   * after the image name, ahead of what the agent's own function contributes.
   */
  readonly entrypoint?: readonly string[];
  /**
   * The container networks to join, one `--network` each.
   *
   * Plural, because a container can join several. There is no default: the container runtime's
   * own is the shared bridge, and no network at all breaks every Run. The agent needs both its
   * model and the Agent server.
   */
  readonly networks?: readonly string[];
  /**
   * Environment variables for the agent's container, such as a provider API key or a proxy.
   *
   * Only what is named here reaches the agent. None of the Gateway's own environment does. That
   * is why the agent runs in a container rather than in this process. Every **value** is
   * hidden in the loggable copy of the command line.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Container flags the framework does not model, spliced last, so a flag here overrides one
   * the framework set.
   *
   * This is the one escape hatch, and it is also how to countermand `--user`: a later `--user`
   * wins. It reaches the container runtime only. There is still no way to pass the agent itself an
   * unmodelled flag.
   */
  readonly extraArgs?: readonly string[];
  /** How the container runtime is invoked. Defaults to `["docker"]`, and `["podman"]` works. */
  readonly containerCommand?: readonly string[];
  /** Defaults to a `pino` instance on stdout. */
  readonly logger?: Logger;
};

/**
 * How to perform one Run: the agent's arguments, its stdin, and how to read what comes back.
 */
export type RunPlan = {
  /** The agent's own arguments, placed after the image name. */
  readonly args: readonly string[];
  /** Written to the container's stdin, which is then closed. */
  readonly stdin: string;
  /**
   * Reads the container's stdout into an outcome.
   *
   * Raw bytes rather than text, so a multi-byte character split across two chunks is the
   * reader's to reassemble. Report a bad stream as a failed Run rather than throwing.
   */
  outcome(stdout: AsyncIterable<Uint8Array>): Promise<RunOutcome>;
};

/**
 * What one containerised agent is: a box, and how to drive an agent inside it.
 *
 * `container` is contained rather than intersected. So an Operator's declaration and an
 * author's behaviour stay visibly apart. A field written in the wrong half is a
 * type error.
 */
export type AgentContainerRuntimeSpec = {
  readonly container: AgentContainer;
  /**
   * The whole of what an Agent Implementation adds.
   *
   * One function rather than two, because `outcome` is produced per Run. It can therefore close
   * over what this Run is and name the Session when it fails. It is called once per Run, and
   * its result drives both the command line and the reader.
   *
   * It is handed a `RunPrompt`, so the Session is always a string. The Signal Worker settled
   * the fresh-Session case before the Runtime was called.
   */
  run(prompt: RunPrompt): RunPlan;
};

/** One Run's command line, and what to feed it. */
export type ComposedCommand = {
  /** The program: the container runtime. */
  readonly command: string;
  /** Its arguments: the container's flags, then the image, then the agent's own. */
  readonly args: readonly string[];
  /**
   * The same arguments with every environment **value** replaced, for a log line.
   *
   * Redacted here, because this is the one place that knows which arguments are values and
   * which are flags. Log this rather than `args`.
   */
  readonly redactedArgs: readonly string[];
  /** The Prompt, or whatever else the agent's function asked to have written to stdin. */
  readonly stdin: string;
};

/**
 * A Runtime, plus one pure method the seam itself does not need.
 *
 * `commandFor` composes a command line without starting a container. It is the only way to
 * see the Runtime's own defaults applied.
 */
export type AgentContainerRuntime = Runtime & {
  commandFor(prompt: RunPrompt): ComposedCommand;
};

/**
 * Builds a Runtime that runs the agent as one fresh container per Run.
 *
 * Construction composes a command line once, for its throwing alone. So a deployment that
 * cannot work is refused where the Operator wrote it. That matters, because a failed Run is
 * never retried.
 *
 * @param spec The container to run, and the one function that drives the agent inside it.
 * @throws If the image is empty, or if the Mount Table cannot mean what it says.
 *
 * @example
 * ```ts
 * import { createAgentContainerRuntime } from "shared-agent-framework";
 *
 * const runtime = createAgentContainerRuntime({
 *   container: {
 *     image: "my-agent:1",
 *     networks: ["saf_agent"],
 *     env: { MY_API_KEY: process.env.MY_API_KEY ?? "" },
 *     mounts: { entries: [{ agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" }] },
 *   },
 *   run: (prompt) => ({
 *     args: ["--session", prompt.session],
 *     stdin: prompt.text,
 *     outcome: async () => ({ ok: true }),
 *   }),
 * });
 * ```
 */
export function createAgentContainerRuntime(
  spec: AgentContainerRuntimeSpec,
): AgentContainerRuntime {
  const log = spec.container.logger ?? defaultLogger();
  // Called for its throwing, and the result deliberately dropped: every Run composes its own.
  // Composing is pure and a handful of string checks. One result kept in a closure beside
  // another computed per Run is how the two come to disagree. What this call buys is the *when*.
  composeArgv(spec.container, []);

  const compose = (plan: RunPlan): ComposedCommand => ({
    ...composeArgv(spec.container, plan.args),
    stdin: plan.stdin,
  });

  return {
    commandFor: (prompt) => compose(spec.run(prompt)),

    async run(prompt: RunPrompt): Promise<RunOutcome> {
      // Asked once, and its answer used for both the command line and the reader.
      const plan = spec.run(prompt);
      const invocation = compose(plan);

      // No Run id on this line or the one below it. The Signal Worker is serial globally, so its
      // own "Run started" and "Run finished" lines bracket these two. The Run a container line
      // belongs to is the one immediately above it. The Session is on the Worker's lines and in
      // every failure message, and a transcript is found by it.
      log.debug(
        // `redactedArgs`, never `args`. This line exists so a mount or a network problem can be
        // diagnosed without the framework's source. The command line carries whatever `env`
        // holds, which is where a provider API key goes.
        { command: invocation.command, args: invocation.redactedArgs },
        "starting the agent's container",
      );

      const result = await runContainer(invocation, plan.outcome);
      // One line carrying the two things nothing else records. The exit status is not the
      // outcome, and stderr is where a first Run of a named Session often warns.
      const ended = { exitCode: result.exitCode, signal: result.signal };
      log.debug(
        result.stderr === "" ? ended : { ...ended, stderr: result.stderr },
        "the agent's container is gone",
      );

      if (result.value.ok) {
        if (result.exitCode !== 0) {
          // Not a failure: the stream said the agent answered, and the stream is what decides.
          // Said out loud because it is a combination that should not occur.
          log.warn(
            ended,
            "the agent's container reported a successful Run and then exited non-zero",
          );
        }
        return result.value;
      }

      return { ok: false, error: [result.value.error, ...diagnosis(result)].join(" ") };
    },
  };
}

/**
 * The whole command line for one Run, and a copy safe to log. The only place argument order is
 * decided.
 *
 * The process being started is the container runtime, not the agent. Everything before the image
 * name is the runtime's, and everything after it is the agent's. A flag on the wrong side reaches
 * the wrong program.
 */
function composeArgv(
  container: AgentContainer,
  agentArgs: readonly string[],
): Omit<ComposedCommand, "stdin"> {
  if (container.image === "") {
    throw new Error("the agent's container has no image, so there is nothing to run");
  }

  const [command = "docker", ...runtimeArgs] = container.containerCommand ?? ["docker"];
  const args: string[] = [
    ...runtimeArgs,
    "run",
    // One fresh container per Run, and nothing kept afterwards but what the mounts hold.
    "--rm",
    // Keeps stdin open so the Prompt can be written to it. Deliberately without `--tty`:
    // a TTY makes an agent decide it is being used interactively.
    "--interactive",
  ];

  // `--mount type=bind` per entry and never `-v`. That is what makes the daemon refuse a missing
  // source, rather than invent it as a `root`-owned directory. An absent table contributes
  // nothing at all.
  args.push(...mountArguments(container.mounts ?? { entries: [] }));

  const user = ownUser();
  if (user !== undefined) args.push("--user", user);

  for (const network of container.networks ?? []) args.push("--network", network);
  for (const [name, value] of Object.entries(container.env ?? {})) {
    args.push("--env", `${name}=${value}`);
  }

  // `--entrypoint` takes one word. Anything after it is the container's *command* and
  // goes after the image, ahead of the agent's own arguments.
  const [program, ...rest] = container.entrypoint ?? [];
  if (program !== undefined) args.push("--entrypoint", program);

  // Last among the runtime's own flags, so these override the ones composed above.
  args.push(...(container.extraArgs ?? []));
  args.push(container.image, ...rest, ...agentArgs);

  return { command, args, redactedArgs: redact(args) };
}

/**
 * Hides every environment value, with no exceptions list.
 *
 * A list of what is safe to log would have to know every provider's key name. So the names
 * survive and the values do not.
 */
function redact(args: readonly string[]): readonly string[] {
  return args.map((arg, at) => {
    const flag = args[at - 1];
    if (flag !== "--env" && flag !== "-e") return arg;
    const [name, value] = arg.split(/=(.*)/s);
    if (name === undefined) return arg;
    // A variable set to nothing stays visibly empty. There is nothing in it to hide, and the two
    // cases are worth telling apart in a log.
    return `${name}=${value === undefined || value === "" ? "" : "…"}`;
  });
}

/**
 * What to add to a failure the stream already decided on.
 *
 * The exit code and stderr are diagnosis. They only ever reach a message that already says the Run
 * failed. The Run's `error` column is where an Operator reads it.
 */
function diagnosis(result: {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}): string[] {
  const notes: string[] = [];
  if (result.signal !== null) {
    notes.push(`The container was killed by ${result.signal}.`);
  } else if (result.exitCode !== 0) {
    notes.push(`The container exited with code ${result.exitCode}.`);
  }
  if (result.stderr !== "") notes.push(`Its stderr said: ${result.stderr.trim()}`);
  return notes;
}

/**
 * This process's `uid:gid`, or nothing on a platform that has no such thing. Not configuration.
 *
 * Without `--user`, the agent's files in a bind mount are owned by uid 0. A Signal Handler running
 * as the Gateway's uid can then read and delete such a file. It cannot modify it in place.
 */
function ownUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}
