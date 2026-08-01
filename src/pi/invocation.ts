/**
 * Composing the container invocation for one Run.
 *
 * Pure: it reads a configuration and a Prompt and returns argv. Nothing is spawned
 * here, which is what lets every property of the composed command be a fast test.
 *
 * Two of the choices in here are the ones ADR-0025 says get silently got wrong:
 * `--session-id` rather than `--session`, because the latter only resolves an
 * *existing* Session and exits 1 otherwise; and one Session directory per Session,
 * because resolving a Session by id parses every Session file in its directory.
 */

import type { Prompt } from "../core/handlers.ts";
import {
  mountsOf,
  type PiConfiguration,
  type ResolvedPiConfiguration,
  resolvePiConfiguration,
  sessionDirectoryFor,
  sessionFor,
} from "./configuration.ts";

/** The command to run for one Run, and what to feed it. */
export type PiInvocation = {
  /** The program: the container runtime. */
  readonly command: string;
  /** Its arguments, container flags first, then the image, then `pi`'s own flags. */
  readonly args: readonly string[];
  /**
   * The same arguments with every environment variable's **value** replaced, for the
   * log line the Operator diagnoses a mount or a network problem from.
   *
   * The composed invocation is logged, and it carries whatever `env` holds — which is
   * where a provider API key goes. Redacting here rather than leaving it to whoever
   * writes the log line: this is the one place that knows which arguments are values
   * and which are flags, and a key in a log file is not something to discover later.
   */
  readonly redactedArgs: readonly string[];
  /**
   * The Prompt text, to be written to the process's stdin and the stream then closed.
   *
   * On stdin rather than as an argument, and that is not a style choice: `pi` reads a
   * leading `@word` as a *file* to include and refuses an argument starting with `-`
   * as an unknown option, so a Prompt beginning with either — which is ordinary
   * Handlebars output — would be silently rewritten or would fail the Run. Piped
   * stdin becomes the initial message with neither treatment applied.
   */
  readonly stdin: string;
  /**
   * The Session this Run targets, generated when the Prompt asked for a fresh one.
   *
   * Reported here so the adapter and its log lines have one source for it rather than
   * two implementations of the same rule.
   */
  readonly session: string;
  /**
   * Where that Session's own directory will be, as the Gateway sees it.
   *
   * Nothing creates it: the Agent Runtime does, inside the container, into the mounted
   * Session root. This is here **for the adapter's debug line alone**. "Where is this
   * Session's transcript on my disk" is the question asked while diagnosing the
   * forgetful-agent failure ADR-0025 describes, and the container path in the logged
   * argv does not answer it.
   */
  readonly sessionDirectory: string;
};

/** Where the framework's instructions file lands inside the agent's directory. */
export const instructionsFileName = "gateway-instructions.md";

/**
 * Composes the invocation for one Run.
 *
 * Takes the same two values as `RuntimeAdapter.run` so there is no third spelling of
 * what a Run is, and resolves the configuration itself — resolving is a handful of
 * string checks, and doing it per Run means the invocation cannot be composed from a
 * configuration that was never checked.
 */
export function composeInvocation(
  config: PiConfiguration,
  prompt: Prompt,
  runId: string,
): PiInvocation {
  const resolved = resolvePiConfiguration(config);
  const session = sessionFor(prompt.session, runId);

  if (prompt.text.trim() === "") {
    throw new Error(
      "the Prompt has no text, and the Agent Runtime drops an empty message rather than answering it, so the Run would settle having said nothing",
    );
  }

  const [command, ...runtimeArgs] = resolved.containerCommand;
  const args = [
    ...runtimeArgs,
    ...containerArgs(resolved),
    resolved.image,
    ...agentArgs(resolved, session),
  ];

  return {
    command,
    args,
    redactedArgs: redact(args),
    stdin: prompt.text,
    session,
    sessionDirectory: sessionDirectoryFor(resolved.sessionRoot, session).localPath,
  };
}

/**
 * The framework's own environment variables, whose values are kept in the log line.
 *
 * Everything else is redacted, including a variable nobody here has heard of: a list of
 * what to hide would have to be right about every provider's key, and being wrong about
 * one puts it in a log file. This way being wrong only costs a value in a log.
 *
 * `PI_CODING_AGENT_DIR` in particular is one of the two values a mount problem is
 * diagnosed from, which is what the invocation is logged for in the first place.
 */
const loggableEnv = new Set(["PI_CODING_AGENT_DIR", "PI_OFFLINE"]);

/** The arguments with environment values taken out, so the invocation can be logged. */
function redact(args: readonly string[]): string[] {
  return args.map((arg, at) => {
    const flag = args[at - 1];
    if (flag !== "--env" && flag !== "-e") return arg;
    const [name, value] = arg.split(/=(.*)/s);
    if (name === undefined || loggableEnv.has(name)) return arg;
    // A variable set to nothing stays visibly empty: there is nothing in it to hide,
    // and "set to empty" and "set to something" are worth telling apart in a log.
    return `${name}=${value === undefined || value === "" ? "" : "…"}`;
  });
}

/** Everything before the image name: the flags belonging to the container runtime. */
function containerArgs(config: ResolvedPiConfiguration): string[] {
  const args = [
    "run",
    // One fresh process per Run, and nothing kept afterwards but what the mounts hold.
    "--rm",
    // Keeps stdin open so the Prompt can be written to it. Deliberately without
    // `--tty`: a TTY would make `pi` decide it is being used interactively.
    "--interactive",
    "--workdir",
    config.workspace.agentPath,
  ];
  if (config.user !== undefined) args.push("--user", config.user);
  if (config.network !== undefined) args.push("--network", config.network);

  for (const { mount } of mountsOf(config)) {
    args.push("--volume", `${mount.source}:${mount.agentPath}`);
  }
  for (const [name, value] of Object.entries(environment(config))) {
    args.push("--env", `${name}=${value}`);
  }
  // Last, so an Operator can also override a flag the framework set.
  args.push(...config.extraArgs);
  return args;
}

/** Everything after the image name: `pi`'s own flags. */
function agentArgs(config: ResolvedPiConfiguration, session: string): string[] {
  const args = [
    // The machine-readable event stream. Note it exits 0 on model and API errors, so
    // the outcome is read from the stream rather than the exit code (see output.ts).
    "--mode",
    "json",
    "--model",
    config.model,
  ];
  if (config.provider !== undefined) args.push("--provider", config.provider);
  args.push(
    // `--session-id`, never `--session`: this one creates the Session if it is
    // missing, which is exactly the fresh-or-named semantics a Prompt asks for. The
    // other resolves only an existing Session and exits 1 otherwise (ADR-0006).
    "--session-id",
    session,
    "--session-dir",
    sessionDirectoryFor(config.sessionRoot, session).agentPath,
    "--append-system-prompt",
    `${config.agentDir.agentPath}/${instructionsFileName}`,
    // Project-local `.pi` settings and extensions are ignored, and that is load-bearing
    // rather than tidy: the Workspace is writable by the agent, and a saved trust
    // decision in the persisted `trust.json` would otherwise let one Run arrange for
    // the next one to load configuration out of the Workspace — a durable
    // reconfiguration by injection, which is what rewriting the configuration every
    // Run exists to prevent (ADR-0003, ADR-0025).
    "--no-approve",
  );
  return args;
}

/**
 * The container's environment, in the order that decides who wins a collision.
 *
 * `PI_OFFLINE` is a **default**: a Gateway has no use for `pi`'s startup version check
 * and update telemetry, and a Run should not depend on reaching `pi.dev` — but that is
 * a preference, and an Operator who sets it themselves gets what they asked for.
 *
 * `PI_CODING_AGENT_DIR` is **not** a default and comes last. It is where the
 * configuration written before this Run actually is, and an agent pointed at any other
 * directory would find none of it and run unconfigured rather than fail.
 */
function environment(config: ResolvedPiConfiguration): Record<string, string> {
  return {
    PI_OFFLINE: "1",
    ...config.env,
    PI_CODING_AGENT_DIR: config.agentDir.agentPath,
  };
}
