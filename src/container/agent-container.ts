/**
 * The Agent Container, and the Runtime that runs one.
 *
 * Everything about running an agent as a container lives here, and what an Agent
 * Implementation adds to it is **one function**
 * ([ADR-0033](../../docs/adr/0033-an-agent-is-a-container-and-one-function.md)). The
 * container is inert data an Operator writes; `createAgentContainerRuntime` turns it
 * plus that function into the seam the Signal Worker drives.
 *
 * Nothing here has heard of `pi`, or of any other agent, and that is the point rather
 * than a nicety: the eight fields below are what `docker run` takes, and a second Agent
 * Implementation needs all of them unchanged. It is exported from the package root for
 * the same reason the Mount Table is (ADR-0026, ADR-0028).
 *
 * What it owns: the argument assembly, `--rm --interactive --user`, the mounts, the
 * networks, the environment, the entry point, the unmodelled flags, spawning, stdin,
 * stderr, the exit status, and the diagnosis appended to a failure. What it refuses,
 * at construction rather than at the first Signal, is the three things decidable from
 * the value alone: a missing image, a relative container path, and a `hostPaths` gap.
 * Everything else a deployment can get wrong is a file the framework does not read, for
 * a program it does not depend on, and arrives as a permanently failed first Run
 * ([ADR-0017](../../docs/adr/0017-failed-runs-are-not-retried.md)).
 */

import { defaultLogger, type Logger } from "../logging.ts";
import type { RunOutcome, RunPrompt, Runtime } from "../signals/runtime.ts";
import { type MountTable, resolveMountTable } from "./mount-table.ts";
import { runContainer } from "./process.ts";

/**
 * The container one Run happens in, as an Operator declares it.
 *
 * Only `image` is required. Everything else is a default the Operator did not have to
 * think about, or a fact about their deployment that most deployments do not have.
 */
export type AgentContainer = {
  /** The container image. The one thing no deployment can leave out. */
  readonly image: string;
  /**
   * What the container sees on disk. Absent means nothing at all.
   *
   * That is a legitimate deployment rather than a mistake: an image that bakes in its
   * own configuration and keeps no state between Runs mounts nothing. The cost is
   * silent — no Session survives a `--rm` container, so every Run is a first Run and no
   * log line says so — which is why the reference deployment mounts what it does
   * (ADR-0028).
   */
  readonly mounts?: MountTable;
  /**
   * What to run inside the image, overriding its own `ENTRYPOINT`.
   *
   * The first word becomes `--entrypoint`, which takes exactly one; anything after it
   * is placed after the image name, ahead of what the agent's own function contributes.
   * An Agent Implementation supplies this as a default, so an image whose entry point is
   * something else needs no workaround in `extraArgs`.
   */
  readonly entrypoint?: readonly string[];
  /**
   * The container networks to join, one `--network` each.
   *
   * Plural because a container can join several, and with no default because there is
   * no good one: the container runtime's own is the shared bridge ADR-0025 argues
   * against, and no network at all breaks every Run, since the agent needs both its
   * model and the Agent server. A deployment that says nothing gets the bridge.
   */
  readonly networks?: readonly string[];
  /**
   * Environment variables for the agent's container — a provider API key, a proxy.
   *
   * Only what is named here reaches the agent. Nothing of the Gateway's own environment
   * does, which is the whole reason the agent runs in a container rather than in this
   * process: an in-process agent's shell tool would hand its children the Gateway's
   * `DATABASE_URL` (ADR-0025). Every **value** is hidden in the loggable copy of the
   * command line, with no exceptions.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Container flags the framework does not model, spliced **last** among the runtime's
   * own, so a flag here also overrides one the framework set.
   *
   * That is the single escape hatch, and it is also the documented way to countermand
   * `--user`: a later `--user` wins, verified on Docker 29.4.0. It reaches the container
   * runtime only — there is still no way to pass the agent itself a flag the framework
   * does not model, which ADR-0025 records as a gap rather than a decision.
   */
  readonly extraArgs?: readonly string[];
  /** How the container runtime is invoked. Defaults to `["docker"]`; `["podman"]` works. */
  readonly containerCommand?: readonly string[];
  /** Defaults to a `pino` instance on stdout. */
  readonly logger?: Logger;
};

/**
 * How to perform one Run, as the Agent Implementation needs it performed: what to put
 * after the image, what to write on stdin, and how to read what comes back.
 */
export type RunPlan = {
  /** The agent's own arguments, placed after the image name. */
  readonly args: readonly string[];
  /** Written to the container's stdin, which is then closed. */
  readonly stdin: string;
  /**
   * Reads the container's stdout into an outcome.
   *
   * Raw bytes rather than text, so a multi-byte character split across two chunks is
   * the reader's to reassemble. A reader is expected to report a bad stream as a failed
   * Run rather than throw.
   */
  outcome(stdout: AsyncIterable<Uint8Array>): Promise<RunOutcome>;
};

/**
 * What one containerised agent is: a box, and how to drive an agent inside it.
 *
 * `container` is **contained rather than intersected**, so the two kinds of thing stay
 * visibly apart — a declaration an Operator writes, and a behaviour an author supplies.
 * It also means an Agent Implementation's own defaults visibly apply to the *container*
 * rather than being smeared across the whole spec, and a field written in the wrong half
 * is a type error rather than something absorbed silently.
 */
export type AgentContainerRuntimeSpec = {
  readonly container: AgentContainer;
  /**
   * The whole of what an Agent Implementation adds.
   *
   * One function rather than two, and the reason is not tidiness: `outcome` is produced
   * **per Run**, so it can close over what this Run is — the Session it names — and say
   * so when it fails. A reader supplied once, at construction, cannot. It is called once
   * per Run and its result used for both the command line and the reader, so a `run`
   * that is not pure cannot be asked twice and disagree with itself.
   *
   * It is handed a `RunPrompt`, so the Session is a string and there is no fresh-Session
   * case to handle: the Signal Worker settled that before the Runtime was called.
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
   * The same arguments with every environment **value** replaced, for the log line an
   * Operator diagnoses a mount or a network problem from.
   *
   * Redacted here rather than left to whoever writes the log line: this is the one place
   * that knows which arguments are values and which are flags, and a key in a log file
   * is not something to discover later.
   */
  readonly redactedArgs: readonly string[];
  /** The Prompt, or whatever else the agent's function asked to have written to stdin. */
  readonly stdin: string;
};

/**
 * A Runtime, plus one pure method the seam itself does not need.
 *
 * `commandFor` is on the returned value because otherwise the only way to see a composed
 * command line is to start a container. Composing one from the parts instead means
 * restating the Runtime's own defaults in the caller, so a test could not observe the
 * default it exists to check — which the prototype demonstrated by producing a command
 * line with no entry point in it and nothing able to notice (ADR-0033).
 */
export type AgentContainerRuntime = Runtime & {
  commandFor(prompt: RunPrompt): ComposedCommand;
};

/**
 * A Runtime that runs the agent as one fresh container per Run.
 *
 * Construction composes a command line once, for its throwing alone, so a deployment
 * that cannot work is refused where the Operator wrote it rather than at its first
 * Signal — which matters because a Run that fails is never retried (ADR-0017).
 */
export function createAgentContainerRuntime(
  spec: AgentContainerRuntimeSpec,
): AgentContainerRuntime {
  const log = spec.container.logger ?? defaultLogger();
  // Called for its throwing, and the result deliberately dropped: nothing here holds a
  // composed command line, because every Run composes its own. Composing is pure and a
  // handful of string checks, and one result kept in a closure beside another computed
  // per Run is how the two come to disagree. What this call buys is the *when*.
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

      // No Run id on this line or the one below it, and that is a decision rather than an
      // oversight: the Run id is not at this seam at all any more (ADR-0033), and it does
      // not need to be. The Signal Worker is **serial globally** — one Signal, one Run in
      // flight, ever (ADR-0012) — and its own "Run started" and "Run finished" lines
      // bracket these two, so the Run a container line belongs to is the one immediately
      // above it and cannot be another. Putting the id back here means putting it back on
      // the seam, and widening the narrowest interface in the framework to serve a log
      // line; the Session is on the Worker's lines and in every failure message, and it
      // is what a transcript is found by.
      log.debug(
        // `redactedArgs`, never `args`: this line exists so a mount or a network problem
        // can be diagnosed without the framework's source, and the command line carries
        // whatever `env` holds — which is where a provider API key goes.
        { command: invocation.command, args: invocation.redactedArgs },
        "starting the agent's container",
      );

      const result = await runContainer(invocation, plan.outcome);
      // One line carrying the two things nothing else records: the exit status, which is
      // not the outcome, and stderr, where a first Run of a named Session often warns.
      const ended = { exitCode: result.exitCode, signal: result.signal };
      log.debug(
        result.stderr === "" ? ended : { ...ended, stderr: result.stderr },
        "the agent's container is gone",
      );

      if (result.value.ok) {
        if (result.exitCode !== 0) {
          // Not a failure — the stream said the agent answered, and the stream is what
          // decides. Said out loud because it is a combination that should not occur,
          // and the alternative is nobody ever knowing it happened.
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
 * The whole command line for one Run, and a copy safe to log. Pure, and the only place
 * argument order is decided.
 *
 * The order is the property a mistake breaks, because the process being started is the
 * container runtime and not the agent: everything before the image name is the
 * runtime's, everything after it is the agent's, and a flag on the wrong side of that
 * line reaches the wrong program.
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

  // `--mount type=bind` per entry and never `-v`, which is what makes the daemon refuse
  // a source that is not there instead of inventing it as a `root`-owned directory
  // (ADR-0028). An absent table contributes nothing at all.
  args.push(...resolveMountTable(container.mounts ?? { entries: [] }).containerArguments());

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
 * Every environment value hidden, with no exceptions list.
 *
 * A list of what is safe to log would have to be right about every provider's key name
 * forever, and being wrong about one puts a credential in a log file. It would also have
 * to name an Agent Implementation's own variables, inside a module that must not know
 * them (ADR-0033). So the names survive and the values do not, and what that costs is
 * the one line that used to say where the agent's directory was mounted.
 */
function redact(args: readonly string[]): readonly string[] {
  return args.map((arg, at) => {
    const flag = args[at - 1];
    if (flag !== "--env" && flag !== "-e") return arg;
    const [name, value] = arg.split(/=(.*)/s);
    if (name === undefined) return arg;
    // A variable set to nothing stays visibly empty: there is nothing in it to hide, and
    // "set to empty" and "set to something" are worth telling apart in a log.
    return `${name}=${value === undefined || value === "" ? "" : "…"}`;
  });
}

/**
 * What to add to a failure the stream already decided on.
 *
 * The exit code and stderr are diagnosis, and only ever reach a message that was already
 * going to say the Run failed. This is the difference between "Session user_42 produced
 * no output at all" and that plus "exit code 125: Unable to find image", which is the
 * whole of what an Operator needs to fix it — and the Run's `error` column is the only
 * place they will look.
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
 * This process's `uid:gid`, or nothing where the platform has no such thing, which is
 * Windows.
 *
 * Not configuration, and the behaviour is kept on evidence rather than on tidiness:
 * verified on Docker 29.4.0, without `--user` every file the agent writes into a bind
 * mount is owned by uid 0, and a Signal Handler running as the Gateway's uid can read it
 * and delete it but **cannot modify it in place**. That is the worst of the three
 * outcomes, because a Handler that only reads works, so the deployment looks correct
 * until something tries to edit (ADR-0025, ADR-0028).
 */
function ownUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}
