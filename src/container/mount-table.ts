/**
 * The Mount Table: what the agent's container sees on disk.
 *
 * A value and a pure function, and that is the whole of it. It creates nothing, writes nothing
 * and stats nothing. Resolution refuses a declaration that cannot mean what it says, and
 * emission turns the result into `--mount` arguments.
 *
 * Every mount is emitted as `--mount type=bind`, never `-v`. `-v` invents a missing source as a
 * `root`-owned directory, even where a file was meant. `--mount` refuses it and names the path.
 * So a typo is a daemon refusal an Operator can read. That refusal arrives at the first Run, and
 * a failed Run is never retried.
 */

import path from "node:path";

/**
 * One entry: a directory or a single file the agent's container can reach.
 *
 * The declaration does not say which of the two it is. Each path is named for the actor that
 * resolves it: `agentPath` the agent's own container, and `gatewayPath` the Gateway process.
 */
export type Mount = {
  /**
   * Where the agent's container resolves it: the mount point the agent sees. Absolute, and
   * always POSIX whatever this platform is.
   */
  readonly agentPath: string;
  /** Where the Gateway process resolves it, on its own side. Absolute. */
  readonly gatewayPath: string;
  /**
   * Whether the agent can write it. Defaults to `false`.
   *
   * A read-only **file** nested inside a read-write **directory** works. The container runtime
   * sorts bind mounts by destination depth. So the file is unwritable and unlinkable, and every
   * sibling operation still succeeds.
   */
  readonly readOnly?: boolean;
};

/**
 * The whole of the agent container's filesystem.
 *
 * Everything else about the container is the `AgentContainer`'s: the image, the entry point, the
 * networks and the environment.
 */
export type MountTable = {
  /**
   * What the container sees.
   *
   * Declaration order is preserved and means nothing. The daemon sorts bind mounts by
   * destination depth. A nested entry nests under its parent, whatever order they were written
   * in.
   *
   * An empty list is a deployment too, and is not refused. Nothing the agent writes outlives its
   * `--rm` container, so every Run is a first Run.
   */
  readonly entries: readonly Mount[];
  /**
   * How this Gateway's own filesystem maps to the host's, for a Gateway in a container.
   *
   * Absent means the Gateway runs on the host, which is the common case. Every entry's
   * `gatewayPath` is then its own source, because the daemon resolves the same string. The two
   * part company only when the Gateway is itself in a container. That is one fact about the
   * deployment, not a property of each mount.
   *
   * Present, it is exhaustive. A `gatewayPath` equal to the root resolves to `hostPath` whole,
   * and one below it resolves to `hostPath` plus the remainder. An entry falling **outside** the
   * root is refused at resolution, naming the entry and the root. `hostPath` is handed to the
   * daemon unread. Nothing discovers either value, so state both yourself.
   */
  readonly hostRoot?: {
    /** Where the shared tree sits inside this Gateway's own container. Absolute. */
    readonly gatewayPath: string;
    /** Where the daemon finds that same tree on the host. Absolute, and handed over unread. */
    readonly hostPath: string;
  };
};

/**
 * Turns a Mount Table into its `--mount` arguments, or refuses it.
 *
 * Pure and total. It applies `hostRoot`, and it refuses:
 *
 * - a relative path on either side;
 * - a `.` or `..` segment in any path it resolves;
 * - an entry falling outside the root;
 * - two entries naming one target.
 *
 * It performs no I/O, so it cannot tell you whether any path exists. That is the daemon's
 * answer at the first Run.
 *
 * `createAgentContainerRuntime` calls it during construction, so a table that cannot work is
 * refused where the Operator wrote it.
 *
 * @returns One `--mount` and its value per entry, in declaration order, and nothing else.
 * @throws On any of the four refusals above.
 *
 * @example
 * ```ts
 * import { mountArguments } from "shared-agent-framework";
 *
 * const args = mountArguments({
 *   entries: [
 *     { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
 *     { agentPath: "/workspace/AGENTS.md", gatewayPath: "/srv/saf/AGENTS.md", readOnly: true },
 *   ],
 *   hostRoot: { gatewayPath: "/srv/saf", hostPath: "/var/lib/saf" },
 * });
 * // ["--mount", "type=bind,source=/var/lib/saf/workspace,target=/workspace", …]
 * ```
 */
export function mountArguments(table: MountTable): readonly string[] {
  if (table.hostRoot !== undefined) {
    refuseDotSegment("hostRoot's gatewayPath", table.hostRoot.gatewayPath);
  }
  const resolved = table.entries.map((entry) => resolveEntry(entry, table.hostRoot));
  refuseDuplicateAgentPath(resolved);
  return resolved.flatMap((entry) => ["--mount", mountArgument(entry)]);
}

/** An entry with its defaults settled and its bind source resolved. Internal to this module. */
type ResolvedEntry = {
  readonly agentPath: string;
  /**
   * What the daemon is given as the bind source: the `gatewayPath` through `hostRoot`.
   *
   * The same string as `gatewayPath` for a Gateway on the host. The two are kept apart anyway,
   * because only one of them is the daemon's.
   */
  readonly hostPath: string;
  readonly readOnly: boolean;
};

function resolveEntry(entry: Mount, hostRoot: MountTable["hostRoot"]): ResolvedEntry {
  // A path inside the container. The container runtime requires it to be absolute, and it is
  // POSIX whatever this platform is.
  if (!entry.agentPath.startsWith("/")) {
    throw new Error(
      `the mount's agentPath ${JSON.stringify(entry.agentPath)} is not absolute; it is a path inside the agent's container, which the container runtime requires to be absolute`,
    );
  }
  refuseDotSegment("mount's agentPath", entry.agentPath);
  if (!path.isAbsolute(entry.gatewayPath)) {
    throw new Error(
      `the mount's gatewayPath ${JSON.stringify(entry.gatewayPath)} is not absolute, so which directory it names would depend on the working directory the Gateway was started from`,
    );
  }
  refuseDotSegment("mount's gatewayPath", entry.gatewayPath);
  return {
    agentPath: entry.agentPath,
    hostPath: hostPathFor(entry.gatewayPath, hostRoot),
    readOnly: entry.readOnly ?? false,
  };
}

/**
 * What the daemon is given for a Gateway-side path.
 *
 * Identity while `hostRoot` is absent, which is a Gateway on the host. Otherwise the one pair does
 * the whole translation, and a path outside the root is refused.
 */
function hostPathFor(gatewayPath: string, hostRoot: MountTable["hostRoot"]): string {
  if (hostRoot === undefined) return gatewayPath;

  const rest = remainderUnder(gatewayPath, hostRoot.gatewayPath);
  if (rest === undefined) {
    throw new Error(
      `the mount's gatewayPath ${JSON.stringify(gatewayPath)} falls outside the hostRoot ${JSON.stringify(hostRoot.gatewayPath)} this Gateway declared, so there is no host path the container runtime's daemon could resolve it to`,
    );
  }
  return `${hostRoot.hostPath}${rest}`;
}

/**
 * One `--mount` value: `type=bind,source=…,target=…`, and `readonly` where declared.
 *
 * The source is the entry's *host* path. The daemon resolves it on the host.
 */
function mountArgument(entry: ResolvedEntry): string {
  const fields = ["type=bind", field("source", entry.hostPath), field("target", entry.agentPath)];
  if (entry.readOnly) fields.push("readonly");
  return fields.join(",");
}

/**
 * One `key=value` of a `--mount` argument, quoted if it has to be.
 *
 * `--mount` parses its value as CSV. A comma inside a path would end the field and turn the
 * rest into an unknown option. CSV quoting is what the parser accepts.
 */
function field(name: string, value: string): string {
  const pair = `${name}=${value}`;
  if (!pair.includes(",") && !pair.includes('"')) return pair;
  return `"${pair.replaceAll('"', '""')}"`;
}

/**
 * Refuses a `.` or `..` **segment** in a path the framework resolves.
 *
 * A segment is a component between slashes, and only a whole `.` or `..` is one. A filename that
 * merely contains dots, such as `my.file` or `..hidden`, is not one. An empty segment from a
 * doubled slash is not one either.
 *
 * Resolution treats these paths as plain strings, so a dot segment makes every comparison
 * unsound. Under a `hostRoot`, a `..` string-prefixes a root it resolves outside of.
 */
function refuseDotSegment(label: string, value: string): void {
  if (value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(
      `the ${label} ${JSON.stringify(value)} has a "." or ".." segment; write it as a normalized path, because resolution treats these paths as plain strings and a "." or ".." makes matching one against another unsound`,
    );
  }
}

/**
 * Refuses two entries that resolve to one target.
 *
 * `agentPath`s are compared after one trailing slash is trimmed. The daemon would otherwise refuse
 * this at the first Run, and a failed Run is never retried.
 *
 * An image-internal symlink aliasing two distinct targets stays the daemon's business.
 */
function refuseDuplicateAgentPath(entries: readonly ResolvedEntry[]): void {
  const seen = new Set<string>();
  for (const { agentPath } of entries) {
    const target = withoutTrailingSlash(agentPath);
    if (seen.has(target)) {
      throw new Error(
        `two entries name the same agentPath ${JSON.stringify(target)}; a Mount Table cannot mount two sources at one target, and a trailing slash does not make them different directories`,
      );
    }
    seen.add(target);
  }
}

/** A path with one trailing separator removed. This is the one tolerance string matching grants. */
function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * What is left of `candidate` below `prefix`, or `undefined` if it is not below it.
 *
 * `""` where the two name the same thing, and otherwise leading-separated.
 */
function remainderUnder(candidate: string, prefix: string): string | undefined {
  const withoutTrailing = withoutTrailingSlash(prefix);
  if (candidate === withoutTrailing) return "";
  return candidate.startsWith(`${withoutTrailing}/`)
    ? candidate.slice(withoutTrailing.length)
    : undefined;
}
