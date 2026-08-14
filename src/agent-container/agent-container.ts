/**
 * Nothing in this file may learn what an Agent Implementation is, and the same holds for every
 * other file in this directory. Every field below is one `docker run` takes, and the whole bet of
 * this directory is that the next agent program needs all of them unchanged and contributes only a `run`
 * function. `src/pi/` is the other half and imports from here. Nothing here may import back, and an
 * import of `../pi/` is the thing to refuse in review; no lint rule enforces it.
 *
 * `composeArgv` is the one place argument order is decided, and it is called twice for two
 * different reasons: once at construction for its throwing alone, with the result dropped, and
 * once per Run for the command line. Keeping a composed result in a closure beside one computed
 * per Run is how the two come to disagree, and composing is pure and a handful of string checks,
 * so the duplicate work is not worth removing.
 *
 * Environment values are redacted with no exceptions list. Such a list would have to be right
 * about every provider's key name forever, and it would have to name `pi`'s own variables inside a
 * module that must not know them.
 */

import { defaultLogger, type Logger } from "../logging/logging.ts";
import type { RunOutcome, RunPrompt, Runtime } from "../signals/runtime.ts";
import { type MountTable, mountArguments } from "./mount-table.ts";
import { runContainer } from "./process.ts";

/**
 * The container one Run happens in, as an Operator declares it. Inert: it creates nothing, checks
 * no path and starts nothing.
 *
 * Everything but `image` is a default worth overriding, or a fact about a deployment that most
 * deployments do not have.
 *
 * The container is always run with `--rm`, with stdin open and no TTY, and as this process's own
 * uid and gid. None of the three is configurable: a TTY makes an agent decide it is being used
 * interactively, and a container running as root leaves files in a bind mount that a Signal
 * Handler can read and delete but cannot change.
 */
export type AgentContainer = {
  /**
   * The container image, handed to the container runtime as written, so a tag or a digest pins what
   * runs.
   */
  readonly image: string;
  /**
   * What the container can reach on disk. Absent means nothing at all.
   *
   * That is a real deployment: an image that bakes in its own configuration and keeps no state
   * mounts nothing. What it costs is silent, because nothing written survives the container. Every
   * Run is then a first Run, whatever Session it names, and no log line says so.
   */
  readonly mounts?: MountTable;
  /**
   * What to run inside the image, in place of its own `ENTRYPOINT`.
   *
   * The first word becomes `--entrypoint`, which takes exactly one. Anything after it is the
   * container's command and lands after the image name, ahead of what the agent's own function
   * contributes.
   */
  readonly entrypoint?: readonly string[];
  /**
   * The container networks to join, one `--network` each.
   *
   * Plural, a container being able to join several. There is no default and no good one: the
   * container runtime's own is the shared bridge, and no network at all breaks every Run, the
   * agent needing both its model and the Agent server.
   */
  readonly networks?: readonly string[];
  /**
   * Environment variables for the agent's container, such as a provider API key or a proxy.
   *
   * Only what is named here reaches the agent, and none of the Gateway's own environment does,
   * which is most of why the agent runs in a container at all. Every **value** is hidden in the
   * loggable copy of the command line, with no exception for a name that looks harmless.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Container flags the framework does not model, spliced in last so that one here overrides one
   * the framework set.
   *
   * The one escape hatch, and how to countermand `--user`, a later `--user` winning. It reaches
   * the container runtime only: there is still no way to pass the agent itself an unmodelled flag.
   */
  readonly extraArgs?: readonly string[];
  /** How the container runtime is invoked. Defaults to `["docker"]`, and `["podman"]` works. */
  readonly containerCommand?: readonly string[];
  /**
   * Where this Runtime logs its two `debug` lines per Run, the composed command line and how the
   * container ended. Defaults to a `pino` instance on stdout, which drops both.
   */
  readonly logger?: Logger;
};

/** How to perform one Run: the agent's arguments, its stdin, and how to read what comes back. */
export type RunPlan = {
  /** The agent's own arguments, placed after the image name. */
  readonly args: readonly string[];
  /** Written to the container's stdin, which is then closed. */
  readonly stdin: string;
  /**
   * Reads the container's stdout into an outcome, and decides whether the Run succeeded.
   *
   * Raw bytes rather than text, so a multi-byte character split across two chunks is this
   * function's to reassemble. Report a bad stream as a failed Run rather than throwing: a throw
   * kills the container and propagates, where a failure is recorded against the Run with the exit
   * status and stderr appended to the message.
   *
   * The stream is what decides. A reader that answers success is believed even if the container
   * then exits non-zero, which is logged as the contradiction it is.
   */
  outcome(stdout: AsyncIterable<Uint8Array>): Promise<RunOutcome>;
};

/**
 * What one containerised agent is: the box an Operator declares, and the one function that drives
 * an agent inside it.
 *
 * The two are separate fields rather than one flat object, so a field written in the wrong half is
 * a type error rather than a container flag nothing reads.
 */
export type AgentContainerRuntimeSpec = {
  readonly container: AgentContainer;
  /**
   * The whole of what an Agent Implementation adds. Called once per Run, and its result drives both
   * the command line and the reading of stdout.
   *
   * One function and not two, because `outcome` comes out of it per Run and can therefore close
   * over which Run this is and name the Session when it fails.
   *
   * `prompt.session` is always a string here. A Signal Handler may ask for a fresh Session, and
   * the Signal Worker has already settled that and named it before anything reaches this.
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
   * The same arguments with every environment **value** replaced. Log this and never `args`.
   *
   * Redacted here because this is the one place that knows which argument is a value and which is
   * a flag. A variable set to nothing stays visibly empty, there being nothing in it to hide.
   */
  readonly redactedArgs: readonly string[];
  /** The Prompt, or whatever else the agent's own function asked to have written to stdin. */
  readonly stdin: string;
};

/**
 * A Runtime, plus one pure method the seam itself has no use for.
 *
 * `commandFor` composes the command line for a Prompt without starting anything, which is the only
 * way to see this Runtime's own defaults applied to a declaration.
 */
export type AgentContainerRuntime = Runtime & {
  commandFor(prompt: RunPrompt): ComposedCommand;
};

/**
 * Builds a Runtime that runs the agent as one fresh container per Run, discarding the container
 * afterwards.
 *
 * A command line is composed once here and thrown away, so that a declaration which cannot work is
 * refused where the Operator wrote it. That is worth a startup failure because the alternative is
 * a Run that fails at the first Signal and is never retried.
 *
 * @throws If the image is empty, or if the Mount Table cannot mean what it says.
 */
export function createAgentContainerRuntime(
  spec: AgentContainerRuntimeSpec,
): AgentContainerRuntime {
  const log = spec.container.logger ?? defaultLogger();
  // Called for its throwing, and the result deliberately dropped; see the file header. What this
  // call buys is the *when*.
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
 * The process being started is the container runtime and not the agent, so everything before the
 * image name belongs to the runtime and everything after it to the agent. A flag put on the wrong
 * side reaches the wrong program and is not refused by anything.
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
  // nothing at all, and is not stood in for by an empty one: a Mount Table names a Runtime
  // Directory, and no deployment is made to name a directory it has no entries under.
  if (container.mounts !== undefined) args.push(...mountArguments(container.mounts));

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

/** Hides every environment value: the names survive a log line and the values do not. */
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
 * What to add to a failure the stream already decided on. The exit code and stderr are diagnosis
 * and never a verdict, so they only ever reach a message that already says the Run failed, and the
 * Run's `error` column is where an Operator reads it.
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
 * This process's `uid:gid`, or nothing on a platform that has no such thing. Not configuration, and
 * the reason is filesystem ownership: without `--user` the agent's files in a bind mount are owned by uid 0,
 * and a Signal Handler running as the Gateway's uid can then read and delete such a file but never
 * change it in place. `extraArgs` is the documented countermand.
 */
function ownUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}
