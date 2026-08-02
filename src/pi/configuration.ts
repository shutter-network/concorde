/**
 * What an Operator configures the `pi` Runtime with.
 *
 * Named fields rather than a command line, so changing the model is a one-line edit
 * and a deployment never restates a whole `docker run`. This is not the
 * agent-neutral shape [ADR-0016](../../docs/adr/0016-agent-configuration-is-opaque-to-the-framework.md)
 * rejects: these options are `pi`-shaped on purpose, and an OpenClaw adapter would
 * have entirely different ones. What the framework does not do is *carry* the agent's
 * own configuration: `settings.json`, `models.json` and whatever tells the agent about
 * the Agent server are the Operator's to place in a directory they mount, and nothing
 * here has heard of any of them
 * ([ADR-0025](../../docs/adr/0025-the-pi-adapter-spawns-one-confined-process-per-run.md)).
 *
 * Nothing here is a mount. The three paths below are paths **inside the container**, and
 * where they come from on the Operator's own disk is the [Mount
 * Table](../../docs/adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)'s
 * to say. That is the whole of the adapter's filesystem knowledge: it never learns
 * whether a path is a bind mount, and it performs no filesystem I/O of its own.
 *
 * One escape hatch, `extraArgs`, for container flags the framework does not model, so
 * an unanticipated requirement never forces a fork of the adapter.
 */

import path from "node:path";
import { type MountTable, type ResolvedMountTable, resolveMountTable } from "../container/index.ts";

export type PiConfiguration = {
  /**
   * The container image, whose entry point is `pi` itself — the adapter appends `pi`'s
   * own flags after the image name. An image that starts something else needs
   * `--entrypoint pi` in `extraArgs`.
   */
  readonly image: string;
  /** The model, as `pi` spells it: an id, a pattern, or `provider/id`. */
  readonly model: string;
  /** The provider, when the model is not already qualified with one. */
  readonly provider?: string;
  /**
   * Where the Workspace is **in the container**, which is the agent's working directory.
   *
   * The Workspace is shared with Signal Handlers, but only the Mount Table knows that:
   * from here it is a string that becomes `--workdir`.
   *
   * It is also where `pi` looks for an `AGENTS.md`, in this directory and its ancestors,
   * which is how an Operator tells the agent about the Agent server. The adapter passes
   * no flag for it and knows nothing about it (ADR-0025).
   */
  readonly workspacePath: string;
  /**
   * Where the agent's own directory is **in the container**, which becomes
   * `PI_CODING_AGENT_DIR`.
   *
   * It holds what persists between Runs and belongs to the agent: `auth.json` with OAuth
   * tokens that refresh mid-Run, `trust.json`, installed tooling under `bin/`.
   */
  readonly agentDirPath: string;
  /**
   * Where the Session root is **in the container**: the directory `--session-dir` names
   * one directory per Session under.
   *
   * Per Session rather than one flat directory because resolving a Session by id
   * parses every Session file in its directory, whole message text included — so a
   * flat directory makes every Run scan every Session the deployment ever
   * accumulated, on the hot path (ADR-0025).
   *
   * The framework creates nothing here, neither this root nor a Session's own
   * directory inside it. The Operator creates whatever their mounts point at
   * ([ADR-0028](../../docs/adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md));
   * the Agent Implementation creates each Session's directory from inside the container.
   */
  readonly sessionRootPath: string;
  /**
   * What the agent's container sees on disk, and which user it runs as.
   *
   * None of the three paths above is required to be in here: a container path nobody
   * mounted is a directory in the container's own writable layer, which is a legitimate
   * if unusual thing to want and is discarded with the container either way. The
   * Workspace almost always is one, since it is shared with Signal Handlers, and the
   * agent's directory almost always is too, since what it holds is meant to survive a
   * Run — but that is the Operator's business and not a rule of the adapter's.
   */
  readonly mounts: MountTable;
  /**
   * Environment variables for the agent's container — provider API keys, a proxy.
   *
   * Only what is named here reaches the agent. Nothing of the Gateway's own
   * environment does, which is the whole reason the agent runs in a container rather
   * than in this process: `pi`'s shell tool hands its child `{ ...process.env }`, so
   * an in-process agent would hold the Db's `DATABASE_URL` (ADR-0025).
   *
   * `PI_CODING_AGENT_DIR` and `PI_OFFLINE` are the framework's and win over anything
   * set here: the first is `agentDirPath`, and an agent pointed at a different directory
   * would find none of what the Operator placed there and run unconfigured.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The container network. A network containing only the agent and the Gateway is the
   * intended shape, so that the Db is not even reachable by service name.
   */
  readonly network?: string;
  /**
   * Container flags the framework does not model, placed last so they also override
   * the ones it does. The single escape hatch ADR-0025 provides instead of a fork.
   */
  readonly extraArgs?: readonly string[];
  /** How the container runtime is invoked. Defaults to `["docker"]`; `["podman"]` works. */
  readonly containerCommand?: readonly string[];
};

/** A configuration whose defaults have been settled and checked. */
export type ResolvedPiConfiguration = {
  readonly image: string;
  readonly model: string;
  readonly provider: string | undefined;
  readonly workspacePath: string;
  readonly agentDirPath: string;
  readonly sessionRootPath: string;
  readonly mounts: ResolvedMountTable;
  readonly env: Readonly<Record<string, string>>;
  readonly network: string | undefined;
  readonly extraArgs: readonly string[];
  /** The program and its own arguments, never empty — checked at resolution. */
  readonly containerCommand: readonly [string, ...string[]];
};

/**
 * Settles a configuration, or refuses it.
 *
 * Exported so that the adapter's own construction can refuse a bad deployment where the
 * Operator wrote it, rather than leaving it to arrive as a permanently failed Run, since
 * nothing is ever retried (ADR-0017). Composing an invocation calls it again: it is pure
 * and it is a handful of string checks, so repeating it costs nothing and means an
 * invocation cannot be composed from a configuration that was never checked.
 */
export function resolvePiConfiguration(config: PiConfiguration): ResolvedPiConfiguration {
  if (config.image === "") throw new Error("the pi adapter needs an image to run");
  if (config.model === "") throw new Error("the pi adapter needs a model");

  return {
    image: config.image,
    model: config.model,
    provider: config.provider,
    workspacePath: containerPath(config.workspacePath, "workspacePath"),
    agentDirPath: containerPath(config.agentDirPath, "agentDirPath"),
    sessionRootPath: containerPath(config.sessionRootPath, "sessionRootPath"),
    mounts: resolveMountTable(config.mounts),
    env: config.env ?? {},
    network: config.network,
    extraArgs: config.extraArgs ?? [],
    containerCommand: containerCommandOf(config.containerCommand),
  };
}

/**
 * A path inside the agent's container, or a refusal naming which one it was.
 *
 * `startsWith("/")` rather than `path.isAbsolute`, because this is a path in the
 * container and always POSIX however the Gateway's own platform spells one.
 */
function containerPath(given: string, name: string): string {
  if (!given.startsWith("/")) {
    throw new Error(
      `${name} ${JSON.stringify(given)} is not absolute; it is a path inside the agent's container, which the container runtime requires to be absolute`,
    );
  }
  return given;
}

/**
 * The container runtime and any arguments of its own, as a list with a first element.
 *
 * Checked here rather than where a process is started, so that every caller has a
 * command to run rather than each one guarding again — and so an empty list is refused
 * at startup like every other unusable configuration.
 */
function containerCommandOf(given: readonly string[] | undefined): readonly [string, ...string[]] {
  if (given === undefined) return ["docker"];
  const [command, ...rest] = given;
  if (command === undefined || command === "") {
    throw new Error(
      'containerCommand is empty, so there is nothing to run the agent\'s container with. It defaults to ["docker"]; ["podman"] and ["sudo", "docker"] are the other shapes it takes.',
    );
  }
  return [command, ...rest];
}

/**
 * The Session a Prompt runs in.
 *
 * A Prompt asking for a fresh Session gets a **generated name** derived from the Run,
 * rather than an ephemeral Session: the Session file then survives for debugging, and
 * it can be found from the Run row that names it — which is what the Run's own
 * `session` column cannot say, since it holds `null` for exactly this case.
 *
 * A name the Handler did choose is passed through untouched, whatever it is: `pi`
 * validates `--session-id` itself, and a copy of its grammar living here would drift
 * from it and reject names a second Agent Implementation accepts (ADR-0024, ADR-0016).
 */
export function sessionFor(session: string | null, runId: string): string {
  return session ?? `run_${runId}`;
}

/**
 * Where a Session's own directory will sit, on both sides of the mount. Neither side is
 * created from here: `--session-dir` is given the container's, and the Gateway's is for
 * the log line that says where the transcript landed on the Operator's own disk.
 *
 * The Gateway's side comes back from the Mount Table and can be `undefined`, which is
 * honest rather than unfortunate: a Session root nobody mounted has no Gateway-side path
 * to name, and so does a Session name that climbs out of the one that was mounted.
 */
export function sessionDirectoryFor(
  config: ResolvedPiConfiguration,
  session: string,
): { readonly containerPath: string; readonly gatewayPath: string | undefined } {
  const inContainer = path.posix.join(config.sessionRootPath, session);
  return { containerPath: inContainer, gatewayPath: config.mounts.gatewayPathFor(inContainer) };
}
