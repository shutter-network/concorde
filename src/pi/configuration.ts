/**
 * What an Operator configures the `pi` Runtime Adapter with.
 *
 * Named fields rather than a command line, so changing the model is a one-line edit
 * and a deployment never restates a whole `docker run`. This is not the
 * runtime-neutral shape [ADR-0016](../../docs/adr/0016-agent-configuration-is-opaque-to-the-framework.md)
 * rejects: these options are `pi`-shaped on purpose, and an OpenClaw adapter would
 * have entirely different ones. What the framework does not do is *interpret* them —
 * `settings` and `models` are written out as given ([ADR-0025](../../docs/adr/0025-the-pi-adapter-spawns-one-confined-process-per-run.md)).
 *
 * One escape hatch, `extraArgs`, for container flags the framework does not model, so
 * an unanticipated requirement never forces a fork of the adapter.
 */

import path from "node:path";

/**
 * A directory the agent's container needs, in the up-to-three places it is named.
 *
 * A bare string is the shorthand for all three coinciding, which is the case when the
 * Gateway runs on the host and the Operator is content with matching paths.
 */
export type Mount =
  | string
  | {
      /** Where the Gateway process itself reads and writes it. */
      readonly localPath: string;
      /** Where it appears inside the agent's container. Defaults to `localPath`. */
      readonly agentPath?: string;
      /**
       * What the container runtime resolves. Defaults to `localPath`.
       *
       * The daemon resolves this **on the host, not inside the calling container**, so
       * a containerised Gateway must state a host path or a named volume here. Get it
       * wrong and Docker silently creates an empty directory: the agent sees an empty
       * Workspace and nothing errors anywhere. Nothing checks that, here or anywhere —
       * the cost [ADR-0028](../../docs/adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)
       * accepts, and the case it defers to a translation table stated once.
       */
      readonly source?: string;
    };

/** A mount with all three names filled in. */
export type ResolvedMount = {
  readonly localPath: string;
  readonly agentPath: string;
  readonly source: string;
};

/**
 * The three directories the agent's container needs, under the names they are
 * configured and reported by.
 *
 * A union rather than a string, because every part of the adapter that says which
 * mount it means — the `--volume` arguments, the failure message that names one — has
 * to agree with the others about the set, and a typo in any of them would otherwise be
 * a mount silently left out.
 */
export type MountRole = "workspace" | "agentDir" | "sessionRoot";

/** Arbitrary JSON the framework writes out without reading (ADR-0016). */
export type OpaqueJson = Readonly<Record<string, unknown>>;

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
  /** The Workspace: shared with Signal Handlers, and the container's working directory. */
  readonly workspace: Mount;
  /**
   * The agent's own directory — `~/.pi/agent`'s contents.
   *
   * Holds what persists between Runs and belongs to the agent: `auth.json` with OAuth
   * tokens that refresh mid-Run, `trust.json`, installed tooling under `bin/`. The
   * framework writes its own three files in here before every Run and touches nothing
   * else, so whatever a future `pi` version keeps here comes along without us knowing
   * about it.
   */
  readonly agentDir: Mount;
  /**
   * The directory the Agent Runtime creates Session directories under, one per Session.
   *
   * Per Session rather than one flat directory because resolving a Session by id
   * parses every Session file in its directory, whole message text included — so a
   * flat directory makes every Run scan every Session the deployment ever
   * accumulated, on the hot path (ADR-0025).
   *
   * The framework creates nothing here, neither this root nor a Session's own
   * directory inside it. The Operator creates the root
   * ([ADR-0028](../../docs/adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md));
   * the Agent Runtime creates each Session's directory from inside the container.
   */
  readonly sessionRoot: Mount;
  /**
   * The base URL the agent's container reaches the Agent server at. Write it with no
   * trailing slash: `/signals` and `/runs` are appended to it as written.
   *
   * Nothing can derive it, which is why it is required and why it is stated rather than
   * inferred from where that server binds: the two are separate values, and neither
   * follows from the other. `http://host.docker.internal:7411` under Docker Desktop,
   * `http://<compose service>:7411` on a shared network, the bridge address under a
   * plain Linux daemon.
   *
   * It reaches the instructions file **verbatim**: unparsed, unchecked, and unrewritten,
   * because the framework does not interpret the agent's configuration
   * ([ADR-0016](../../docs/adr/0016-agent-configuration-is-opaque-to-the-framework.md))
   * and this is configuration like any other. What a parser would have caught is a
   * typo'd scheme, which nobody types by accident, and not a typo'd hostname, which is
   * the mistake this value actually attracts. So a trailing slash survives too, and the
   * double-slashed paths it produces match no route: the agent's reads 404 and the Run
   * fails, permanently, since nothing is retried
   * ([ADR-0017](../../docs/adr/0017-failed-runs-are-not-retried.md)). Either way the
   * symptom is the agent saying it cannot reach the Gateway, which points back here.
   *
   * Required at all because the agent has no other way to read prior Signals and Runs,
   * and [ADR-0010](../../docs/adr/0010-the-agent-reaches-the-gateway-over-http.md) says
   * the shape of that API has to be described to the agent in its own configuration —
   * which is what the instructions file written before each Run does.
   */
  readonly agentServerUrl: string;
  /**
   * The Operator's instructions to the agent, appended to `pi`'s own system prompt.
   *
   * Appended rather than replacing it: `pi`'s prompt is what makes its seven built-in
   * tools usable, and `--append-system-prompt` is also the only one of the two flags
   * that takes a file, so a long prompt does not have to survive an argument list.
   */
  readonly instructions?: string;
  /** Written to `settings.json` before every Run, exactly as given. */
  readonly settings?: OpaqueJson;
  /** Written to `models.json` before every Run, exactly as given: custom providers. */
  readonly models?: OpaqueJson;
  /**
   * Environment variables for the agent's container — provider API keys, a proxy.
   *
   * Only what is named here reaches the agent. Nothing of the Gateway's own
   * environment does, which is the whole reason the agent runs in a container rather
   * than in this process: `pi`'s shell tool hands its child `{ ...process.env }`, so
   * an in-process agent would hold the Store's `DATABASE_URL` (ADR-0025).
   *
   * `PI_CODING_AGENT_DIR` and `PI_OFFLINE` are the framework's and win over anything
   * set here: the first is where the configuration written before each Run lands, and
   * the agent reading a different directory would run unconfigured.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The container network. A network containing only the agent and the Gateway is the
   * intended shape, so that the Store is not even reachable by service name.
   */
  readonly network?: string;
  /**
   * The user the container runs as, `uid:gid`. Defaults to this process's own.
   *
   * With bind mounts the files the agent writes are owned by the container's user, so
   * a mismatch leaves Signal Handlers unable to read what the agent wrote in the
   * shared Workspace, and the agent unable to read theirs.
   */
  readonly user?: string;
  /**
   * Container flags the framework does not model, placed last so they also override
   * the ones it does. The single escape hatch ADR-0025 provides instead of a fork.
   */
  readonly extraArgs?: readonly string[];
  /** How the container runtime is invoked. Defaults to `["docker"]`; `["podman"]` works. */
  readonly containerCommand?: readonly string[];
};

/** A configuration whose mounts and defaults have been settled and checked. */
export type ResolvedPiConfiguration = {
  readonly image: string;
  readonly model: string;
  readonly provider: string | undefined;
  readonly workspace: ResolvedMount;
  readonly agentDir: ResolvedMount;
  readonly sessionRoot: ResolvedMount;
  readonly agentServerUrl: string;
  readonly instructions: string | undefined;
  readonly settings: OpaqueJson;
  readonly models: OpaqueJson;
  readonly env: Readonly<Record<string, string>>;
  readonly network: string | undefined;
  readonly user: string | undefined;
  readonly extraArgs: readonly string[];
  /** The program and its own arguments, never empty — checked at resolution. */
  readonly containerCommand: readonly [string, ...string[]];
};

/**
 * The three mounts in the order they are mounted, each under its role.
 *
 * One place that knows the set, so that a fourth mount is one edit and not four. It
 * had a second reason — keeping the `--volume` arguments and the startup check's own
 * mounting from disagreeing — and that one went with the check (ADR-0028).
 */
export function mountsOf(
  config: ResolvedPiConfiguration,
): readonly { readonly role: MountRole; readonly mount: ResolvedMount }[] {
  return [
    { role: "workspace", mount: config.workspace },
    { role: "agentDir", mount: config.agentDir },
    { role: "sessionRoot", mount: config.sessionRoot },
  ];
}

/**
 * Fills in a mount's three names and refuses one that cannot mean what it says.
 *
 * `role` names the mount in a failure message, since "not an absolute path" is
 * useless when a deployment has three of them.
 *
 * `source` is deliberately *not* required to be a path: a deployment using a named
 * volume mounts it into the Gateway too, so the Gateway sees an ordinary directory and
 * the volume is only ever a value for `source` (ADR-0025). What a wrong `source`
 * produces — an empty directory and no error — is caught by nothing at all: no pattern
 * here could tell, and the container that used to check is gone (ADR-0028).
 */
export function resolveMount(mount: Mount, role = "mount"): ResolvedMount {
  const given = typeof mount === "string" ? { localPath: mount } : mount;
  const resolved: ResolvedMount = {
    localPath: given.localPath,
    agentPath: given.agentPath ?? given.localPath,
    source: given.source ?? given.localPath,
  };

  if (resolved.localPath === "") {
    throw new Error(`the ${role} mount has no localPath`);
  }
  if (!path.isAbsolute(resolved.localPath)) {
    throw new Error(
      `the ${role} mount's localPath ${JSON.stringify(resolved.localPath)} is not absolute, so where the Gateway reads it would depend on the working directory it was started from`,
    );
  }
  if (!resolved.agentPath.startsWith("/")) {
    throw new Error(
      `the ${role} mount's agentPath ${JSON.stringify(resolved.agentPath)} is not absolute; it is a path inside the agent's container, which the container runtime requires to be absolute`,
    );
  }
  if (resolved.source === "") {
    throw new Error(`the ${role} mount has an empty source`);
  }
  for (const [name, value] of Object.entries(resolved)) {
    // A colon is what separates the three fields of a `--volume` argument, so one
    // inside a value silently makes the argument mean something else.
    if (value.includes(":")) {
      throw new Error(
        `the ${role} mount's ${name} ${JSON.stringify(value)} contains a colon, which is what separates the parts of a --volume argument`,
      );
    }
  }
  return resolved;
}

/**
 * Settles a configuration, or refuses it.
 *
 * Exported so that the adapter's own construction can refuse a bad deployment where the
 * Operator wrote it, rather than leaving it to arrive as a permanently failed Run, since
 * nothing is ever retried (ADR-0017). Composing an invocation and writing a Run's
 * configuration each call it again: it is pure and it is a handful of string checks, so
 * repeating it costs nothing and means neither can work from a configuration that was
 * never checked.
 */
export function resolvePiConfiguration(config: PiConfiguration): ResolvedPiConfiguration {
  if (config.image === "") throw new Error("the pi adapter needs an image to run");
  if (config.model === "") throw new Error("the pi adapter needs a model");

  return {
    image: config.image,
    model: config.model,
    provider: config.provider,
    workspace: resolveMount(config.workspace, "workspace"),
    agentDir: resolveMount(config.agentDir, "agentDir"),
    sessionRoot: resolveMount(config.sessionRoot, "sessionRoot"),
    // Untouched: resolution settles paths and fills defaults, and a string the Operator
    // supplied is neither. See the field's own documentation for why nothing checks it.
    agentServerUrl: config.agentServerUrl,
    instructions: config.instructions,
    settings: config.settings ?? {},
    models: config.models ?? {},
    env: config.env ?? {},
    network: config.network,
    user: config.user ?? ownUser(),
    extraArgs: config.extraArgs ?? [],
    containerCommand: containerCommandOf(config.containerCommand),
  };
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
 * from it and reject names a second Agent Runtime accepts (ADR-0024, ADR-0016).
 */
export function sessionFor(session: string | null, runId: string): string {
  return session ?? `run_${runId}`;
}

/**
 * Where a Session's own directory will sit, on both sides of the mount. Neither side is
 * created from here: `--session-dir` is given the agent's, and the Gateway's is for the
 * log line that says where the transcript landed on the Operator's own disk.
 *
 * Both at once and from one place, because the two are joined differently: the agent's
 * is a path inside the container and always POSIX, and the Gateway's is whatever this
 * platform separates paths with. Computing them apart is how they come to disagree.
 */
export function sessionDirectoryFor(
  sessionRoot: ResolvedMount,
  session: string,
): { readonly localPath: string; readonly agentPath: string } {
  return {
    localPath: path.join(sessionRoot.localPath, session),
    agentPath: path.posix.join(sessionRoot.agentPath, session),
  };
}

/**
 * This process's `uid:gid`, or nothing where the platform has no such thing.
 *
 * The default rather than a documented step, because the failure a mismatch produces
 * is a Signal Handler that cannot read a file the agent definitely wrote.
 */
function ownUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}
