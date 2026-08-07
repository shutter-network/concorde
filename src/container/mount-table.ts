/**
 * A value and a pure function, and keeping it that way is the whole decision (ADR-0028). It creates
 * nothing, writes nothing and stats nothing, so a pre-flight check on any of these paths does not
 * belong here however cheap it looks. Everything refused below is decidable from the value alone,
 * and that is the criterion the list of refusals is built on.
 *
 * Every mount is emitted as `--mount type=bind` and never `-v`. `-v` invents a missing source as a
 * `root`-owned directory, even where a file was meant, where `--mount` refuses and names the path.
 * That is the check this module is allowed not to write.
 *
 * Resolution treats every path as a plain string, which is why a `.` or `..` segment is refused
 * rather than normalized: `..` string-prefixes a root it resolves outside of, so an entry could
 * read as covered while mounting anywhere.
 */

import path from "node:path";

/**
 * One entry: a directory or a single file the agent's container can reach.
 *
 * Nothing here says which of the two it is, and nothing needs to. Each path is named for the actor
 * that resolves it: `agentPath` for the agent's own container, `gatewayPath` for the Gateway
 * process.
 */
export type Mount = {
  /**
   * The mount point the agent sees. Absolute, and POSIX whatever platform this is.
   *
   * Two entries naming one `agentPath` are refused, a trailing slash making no difference.
   */
  readonly agentPath: string;
  /** Where the Gateway process resolves the same thing, on its own side. Absolute. */
  readonly gatewayPath: string;
  /**
   * Whether the agent can write it. Defaults to `false`.
   *
   * A read-only **file** nested inside a read-write **directory** works, the container runtime
   * sorting bind mounts by destination depth: the file is unwritable and unlinkable while every
   * operation on its siblings still succeeds. That is how a file the agent must not change becomes
   * one it cannot.
   */
  readonly readOnly?: boolean;
};

/**
 * The whole of what the agent's container can reach on disk.
 *
 * Everything else about the container belongs to the `AgentContainer` that carries this: the image,
 * the entry point, the networks and the environment.
 */
export type MountTable = {
  /**
   * The entries, in whatever order suits the reader.
   *
   * Declaration order is preserved in the arguments and means nothing to the outcome. The daemon
   * sorts bind mounts by destination depth, so a nested entry nests under its parent however the
   * two were written.
   *
   * An empty list is a deployment too and is not refused. Nothing the agent writes then outlives
   * the container, so every Run is a first Run.
   */
  readonly entries: readonly Mount[];
  /**
   * How this Gateway's own filesystem maps to the host's, for a Gateway that is itself in a
   * container.
   *
   * Absent means the Gateway runs on the host, which is the common case: every entry's
   * `gatewayPath` is then its own bind source, the daemon resolving the same string this process
   * does. The two part company only for a containerised Gateway, and that is one fact about the
   * deployment rather than a property of each mount, which is why it is stated once here.
   *
   * Present, it is exhaustive. A `gatewayPath` equal to the root resolves to `hostPath` whole, one
   * below it resolves to `hostPath` with the remainder appended, and one falling **outside** the
   * root is refused, naming the entry and the root. Nothing discovers either value, so state both
   * yourself. A shared tree spanning more than one host mount cannot be expressed through one
   * pair: write daemon-namespace paths into each `gatewayPath` and declare no root at all, at the
   * price of paths this process cannot itself list.
   */
  readonly hostRoot?: {
    /** Where the shared tree sits inside this Gateway's own container. Absolute. */
    readonly gatewayPath: string;
    /** Where the daemon finds that same tree on the host. Absolute, and handed over unread. */
    readonly hostPath: string;
  };
};

/**
 * Turns a Mount Table into one `--mount` and its value per entry, in declaration order, or refuses
 * the table.
 *
 * Pure and total. It applies `hostRoot`, and it refuses a relative path on either side, a `.` or
 * `..` segment in any path it resolves, an entry falling outside the root, and two entries naming
 * one target.
 *
 * It performs no I/O, so it cannot say whether any of these paths exists. That answer comes from
 * the daemon at the first Run, as a Run that failed and will not be retried, which is why
 * `createAgentContainerRuntime` calls this at construction: the refusals it can make, it makes
 * where the Operator wrote the table.
 *
 * @throws On any of those four.
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
   * The bind source the daemon is given: the `gatewayPath` put through `hostRoot`. The same string
   * under identity mapping, and kept under a second name anyway, because only one of the two is
   * the daemon's to resolve.
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
 * Refuses a `.` or `..` **segment** in a path the framework resolves; the file header says why.
 *
 * A segment is what sits between two slashes, and only a whole `.` or `..` is one. A filename that
 * merely contains dots, `my.file` or `..hidden`, is not, and neither is the empty segment a doubled
 * slash leaves.
 */
function refuseDotSegment(label: string, value: string): void {
  if (value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(
      `the ${label} ${JSON.stringify(value)} has a "." or ".." segment; write it as a normalized path, because resolution treats these paths as plain strings and a "." or ".." makes matching one against another unsound`,
    );
  }
}

/**
 * Refuses two entries that resolve to one target, comparing `agentPath`s with one trailing slash
 * trimmed. It moves here from the daemon's side of the line only because it needs no I/O; an
 * image-internal symlink aliasing two distinct targets is undecidable from the value and stays the
 * daemon's business.
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
