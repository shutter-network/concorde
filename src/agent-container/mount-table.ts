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
 * Resolution is one `path.posix.join` of the Runtime Directory and an entry's path, and that is why
 * the two ways out of that directory are refused rather than resolved (ADR-0054): a `..` segment
 * joins away into a path above the root with nothing left to see it, and a leading `/` lands under
 * the root a second time. The second refusal is what catches the shape this replaced, where an
 * entry named an absolute path of its own; do not soften it into normalization, because the wrong
 * path it produces is a plausible one and the daemon refuses it at the first Run, not here.
 */

import path from "node:path";

/**
 * One entry: a directory or a single file the agent's container can reach.
 *
 * Nothing here says which of the two it is, and nothing needs to. There are two paths because there
 * are two namespaces: `agentPath` is the agent's own container, and `path` is the host's, written
 * against the table's {@link MountTable.runtimeDir}.
 */
export type Mount = {
  /**
   * The mount point the agent sees. Absolute, and POSIX whatever platform this is.
   *
   * Two entries naming one `agentPath` are refused, a trailing slash making no difference.
   */
  readonly agentPath: string;
  /**
   * Where the same thing sits inside the Runtime Directory, **relative** to it.
   *
   * A leading `/` is refused, because an absolute path here would resolve under that directory a
   * second time rather than fail. The empty string is the Runtime Directory itself.
   */
  readonly path: string;
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
   * The **host's** path to the Runtime Directory every entry is written against.
   *
   * This is the one namespace the table has: the container runtime's daemon resolves a bind source
   * on the host, so this is the string it is handed, unread. Where the Gateway process itself
   * reaches that directory is not stated here and, for a Gateway in a container, is not in general
   * reachable at all, so anything the Gateway reads for itself comes from its own image or from a
   * path it holds separately. Nothing discovers this value.
   *
   * `"/"` is how a shared tree spanning more than one host mount is expressed: an entry then reads
   * `mnt/b/thing` and resolves to `/mnt/b/thing`. It is an ordinary value of the same rule and not
   * a special case. A trailing separator makes no difference.
   */
  readonly runtimeDir: string;
};

/**
 * Turns a Mount Table into one `--mount` and its value per entry, in declaration order, or refuses
 * the table.
 *
 * Pure and total. It joins each entry's path onto `runtimeDir`, and it refuses a relative
 * `agentPath`, a leading `/` on an entry's path, a `.` or `..` segment in any path it resolves, and
 * two entries naming one target.
 *
 * It performs no I/O, so it cannot say whether any of these paths exists. That answer comes from
 * the daemon at the first Run, as a Run that failed and will not be retried, which is why
 * `createAgentContainerRuntime` calls this at construction: the refusals it can make, it makes
 * where the Operator wrote the table.
 *
 * @throws On any of those four.
 */
export function mountArguments(table: MountTable): readonly string[] {
  refuseDotSegment("Mount Table's runtimeDir", table.runtimeDir);
  const resolved = table.entries.map((entry) => resolveEntry(entry, table.runtimeDir));
  refuseDuplicateAgentPath(resolved);
  return resolved.flatMap((entry) => ["--mount", mountArgument(entry)]);
}

/** An entry with its defaults settled and its bind source resolved. Internal to this module. */
type ResolvedEntry = {
  readonly agentPath: string;
  /** The bind source the daemon is given: the entry's path joined onto the Runtime Directory. */
  readonly hostPath: string;
  readonly readOnly: boolean;
};

function resolveEntry(entry: Mount, runtimeDir: string): ResolvedEntry {
  // A path inside the container. The container runtime requires it to be absolute, and it is
  // POSIX whatever this platform is.
  if (!entry.agentPath.startsWith("/")) {
    throw new Error(
      `the mount's agentPath ${JSON.stringify(entry.agentPath)} is not absolute; it is a path inside the agent's container, which the container runtime requires to be absolute`,
    );
  }
  refuseDotSegment("mount's agentPath", entry.agentPath);
  if (entry.path.startsWith("/")) {
    throw new Error(
      `the mount's path ${JSON.stringify(entry.path)} begins with "/", and every entry's path is relative to the runtimeDir ${JSON.stringify(runtimeDir)}; joining the two resolves it under that directory a second time rather than failing, so write it relative`,
    );
  }
  refuseDotSegment("mount's path", entry.path);
  return {
    agentPath: entry.agentPath,
    // POSIX whatever this platform is: the daemon this string reaches resolves it as one.
    hostPath: path.posix.join(runtimeDir, entry.path),
    readOnly: entry.readOnly ?? false,
  };
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
      `the ${label} ${JSON.stringify(value)} has a "." or ".." segment; write it as a normalized path, because resolution joins the runtime directory and an entry's path and a ".." would resolve away silently, out of the one directory this table describes`,
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

/** A path with one trailing separator removed. */
function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
