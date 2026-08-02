/**
 * The Mount Table: what the agent's container sees on disk, and who it runs as.
 *
 * A value and a pure function, and that is the whole of it
 * ([ADR-0028](../../docs/adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)).
 * It creates nothing, writes nothing, starts nothing and checks nothing: resolution
 * fills in the user and refuses a declaration that cannot mean what it says, and emission
 * turns the result into container arguments. Nothing here stats a path, so an Operator
 * composing their own table needs no temporary directory and no container to test it.
 *
 * Nothing in it knows about `pi`, which is why it lives here and is exported from the
 * package root rather than the `./pi` subpath: a second Runtime would need exactly
 * this and nothing of it would change.
 *
 * What replaces the checking is the container runtime itself. Every mount is emitted as
 * `--mount type=bind`, never `-v`, and that is load-bearing rather than stylistic:
 * verified against Docker 29.4.0, `-v` invents a missing source as a `root`-owned
 * *directory* — even where a file was meant — while `--mount` refuses it, naming the
 * path. So a typo is a daemon refusal an Operator can read, not an empty directory the
 * agent reads happily. The cost, which ADR-0028 accepts rather than hides: that refusal
 * arrives at the first Run, and a failed Run is never retried
 * ([ADR-0017](../../docs/adr/0017-failed-runs-are-not-retried.md)).
 */

import path from "node:path";

/**
 * One entry: a directory or a single file the agent's container can reach.
 *
 * The declaration does not say which of the two it is, because nothing here stats
 * anything and the daemon does not need to be told.
 */
export type Mount = {
  /** Where it appears inside the agent's container. Absolute, and always POSIX. */
  readonly containerPath: string;
  /** Where it is on the Gateway's own side. Absolute. */
  readonly gatewayPath: string;
  /**
   * Whether the agent may write it. Defaults to `false`.
   *
   * A read-only **file** nested inside a read-write **directory** is the shape this
   * exists for, and it works: the container runtime sorts bind mounts by destination
   * depth, so the file is unwritable (`EROFS`) and unlinkable (`EBUSY`) while every
   * sibling operation in the directory around it still succeeds. That is what lets a
   * file the agent must not change be a file it *cannot* change, without taking the
   * directory's writability away from it.
   */
  readonly readOnly?: boolean;
};

/**
 * The whole of the agent container's filesystem, and the user that shares it.
 *
 * The user belongs here rather than with the Runtime because every reason it
 * exists is a filesystem reason: with bind mounts the files the agent writes are owned
 * by the container's user, so a mismatch leaves Signal Handlers unable to read what the
 * agent wrote in the shared Workspace and the agent unable to read theirs. What is
 * shared and who shares it are the two halves of one fact, and they cannot come apart if
 * they are declared together.
 *
 * `network`, `workdir`, `extraArgs`, the image and the container command deliberately
 * stay with the Runtime. The line is "the shared filesystem and who shares it",
 * not "every container flag".
 */
export type MountTable = {
  /** At least one. An empty table is refused rather than producing a bare container. */
  readonly entries: readonly Mount[];
  /**
   * How this Gateway's own filesystem maps to the host's, for a Gateway in a container.
   *
   * Absent or empty means the Gateway runs on the host, which is the common case and
   * costs nothing to say: every entry's `gatewayPath` is its own source, because the
   * daemon resolves the same string this process does.
   *
   * They part company only when the Gateway is itself in a container, and that is **one
   * fact about the deployment** rather than a property of each mount. Stated here, it is
   * stated in the place where it is true: a map from a `gatewayPath` prefix to the host
   * source it corresponds to, matched longest-first.
   *
   * Once non-empty it is exhaustive. An entry falling under no key is **refused at
   * resolution**, naming the path and listing the prefixes declared, rather than falling
   * back to identity. A fallback is what turns forgetting the third of three mappings
   * into a deployment that starts, serves, and has one silently empty directory in it.
   *
   * A key matched exactly resolves to its value **whole**, with nothing appended. That is
   * how a named volume is expressed: a runtime will not mount a *subpath* of one, so a
   * composed source would look right and be wrong, and only an exact key never composes.
   * Values are handed to the daemon unread. Nothing here requires one to look like a
   * path, checks that a subpath of it can exist, or knows what a volume is: a volume
   * stays a value, and whether a given runtime accepts the value is between the Operator
   * and their runtime. Note that mounts are emitted as `type=bind`, whose source a daemon
   * does resolve as a path, so under Docker the value for a volume is where that volume
   * lives on the host rather than its name.
   *
   * Nothing discovers this. Reading the process's own mount information returns a
   * confident wrong path whenever a directory sits on a separate filesystem, a subvolume
   * or a virtual machine, and the round trip that once would have caught a bad guess is
   * gone. ADR-0028 records the deferral and the constraint on whoever picks it up: an
   * exact mechanism that fails loudly, or none.
   */
  readonly hostPaths?: Readonly<Record<string, string>>;
  /** The container's user, `uid:gid`. Defaults to this process's own. */
  readonly user?: string;
};

/** An entry with its defaults settled. */
export type ResolvedMount = {
  readonly containerPath: string;
  readonly gatewayPath: string;
  /**
   * What the daemon is given as the bind source: the `gatewayPath` through `hostPaths`.
   *
   * The same string as `gatewayPath` for a Gateway on the host, and the two are kept
   * apart anyway, because `gatewayPathFor` has to keep answering in *this* process's
   * namespace while the daemon is told about the host's.
   */
  readonly hostPath: string;
  readonly readOnly: boolean;
};

/** A Mount Table that has been settled and found usable. */
export type ResolvedMountTable = {
  readonly entries: readonly ResolvedMount[];
  /** `undefined` only where the platform has no uid and no gid, which is Windows. */
  readonly user: string | undefined;
  /** The container-runtime arguments this table contributes: the mounts, and the user. */
  containerArguments(): readonly string[];
  /**
   * Where a path inside the container is on the Gateway's own disk, or `undefined`.
   *
   * Longest-prefix match, so a Session's own directory resolves through the entry that
   * mounts the Session root. It exists for the Runtime's debug line, which is the only
   * thing that can answer "where is this Session's transcript on my disk" — the question
   * ADR-0025 records the forgetful-agent failure as being diagnosed with. A Runtime that
   * still writes files of its own uses it for those too, and that is the whole of what a
   * container path is ever turned back into.
   */
  gatewayPathFor(containerPath: string): string | undefined;
};

/**
 * Settles a Mount Table, or refuses it.
 *
 * Pure and total: it applies `hostPaths`, defaults the user, refuses a relative path on
 * either side, refuses an entry no `hostPaths` prefix covers, and refuses a table with no
 * entries. It performs no I/O, so what it cannot tell you is whether any of these paths
 * exists — that is the daemon's answer at the first Run, and deliberately nobody else's
 * (ADR-0028).
 *
 * `createPiAdapter` calls it during construction, so a table that cannot work is refused
 * where the Operator wrote it rather than at the first Signal.
 */
export function resolveMountTable(table: MountTable): ResolvedMountTable {
  if (table.entries.length === 0) {
    throw new Error(
      "the Mount Table has no entries, so the agent's container would see none of the Operator's filesystem at all",
    );
  }

  const hostPaths = table.hostPaths ?? {};
  const entries = table.entries.map((entry) => resolveEntry(entry, hostPaths));
  const user = table.user ?? ownUser();

  return {
    entries,
    user,
    containerArguments: () => {
      const args = entries.flatMap((entry) => ["--mount", mountArgument(entry)]);
      if (user !== undefined) args.push("--user", user);
      return args;
    },
    gatewayPathFor: (containerPath) => gatewayPathIn(entries, containerPath),
  };
}

function resolveEntry(entry: Mount, hostPaths: Readonly<Record<string, string>>): ResolvedMount {
  // A path inside the container, which the container runtime requires to be absolute,
  // and which is POSIX whatever this platform is.
  if (!entry.containerPath.startsWith("/")) {
    throw new Error(
      `the mount's containerPath ${JSON.stringify(entry.containerPath)} is not absolute; it is a path inside the agent's container, which the container runtime requires to be absolute`,
    );
  }
  if (!path.isAbsolute(entry.gatewayPath)) {
    throw new Error(
      `the mount's gatewayPath ${JSON.stringify(entry.gatewayPath)} is not absolute, so which directory it names would depend on the working directory the Gateway was started from`,
    );
  }
  return {
    containerPath: entry.containerPath,
    gatewayPath: entry.gatewayPath,
    hostPath: hostPathFor(entry.gatewayPath, hostPaths),
    readOnly: entry.readOnly ?? false,
  };
}

/**
 * What the daemon should be given for a Gateway-side path.
 *
 * Identity while `hostPaths` is empty, which is a Gateway on the host. Otherwise the
 * longest key covering the path, with whatever is left of the path appended, and nothing
 * appended at all where the key matched exactly, so a value that is not a path survives
 * whole.
 */
function hostPathFor(gatewayPath: string, hostPaths: Readonly<Record<string, string>>): string {
  const prefixes = Object.keys(hostPaths);
  if (prefixes.length === 0) return gatewayPath;

  const longestFirst = [...prefixes].sort((a, b) => b.length - a.length);
  for (const prefix of longestFirst) {
    const rest = remainderUnder(gatewayPath, prefix);
    if (rest !== undefined) return `${hostPaths[prefix]}${rest}`;
  }

  throw new Error(
    `the mount's gatewayPath ${JSON.stringify(gatewayPath)} falls under none of the hostPaths prefixes this Gateway declared (${prefixes.map((prefix) => JSON.stringify(prefix)).join(", ")}), so there is no host path the container runtime's daemon could resolve it to`,
  );
}

/**
 * One `--mount` value: `type=bind,source=…,target=…`, and `readonly` where declared.
 *
 * The source is the entry's *host* path, because the daemon resolves it on the host and
 * not in whatever namespace this process is in. For a Gateway on the host the two are
 * one string, and `hostPaths` is what tells them apart when they are not.
 */
function mountArgument(entry: ResolvedMount): string {
  const fields = [
    "type=bind",
    field("source", entry.hostPath),
    field("target", entry.containerPath),
  ];
  if (entry.readOnly) fields.push("readonly");
  return fields.join(",");
}

/**
 * One `key=value` of a `--mount` argument, quoted if it has to be.
 *
 * `--mount` parses its value as CSV, so a comma inside a path would otherwise end the
 * field and turn the rest of the path into an unknown option. CSV quoting is what the
 * parser accepts, and it was verified to work rather than assumed. This is the hazard
 * traded for the colon one that `-v` had, and it is the better trade: a colon in a path
 * is ordinary and a comma is rare.
 */
function field(name: string, value: string): string {
  const pair = `${name}=${value}`;
  if (!pair.includes(",") && !pair.includes('"')) return pair;
  return `"${pair.replaceAll('"', '""')}"`;
}

function gatewayPathIn(
  entries: readonly ResolvedMount[],
  containerPath: string,
): string | undefined {
  let best: { readonly entry: ResolvedMount; readonly rest: string } | undefined;
  for (const entry of entries) {
    const rest = remainderUnder(containerPath, entry.containerPath);
    if (rest === undefined) continue;
    if (best === undefined || entry.containerPath.length > best.entry.containerPath.length) {
      best = { entry, rest };
    }
  }
  if (best === undefined) return undefined;

  // The remainder is a container path and therefore POSIX; the answer is a path on this
  // platform, so the two are joined with what this platform separates paths with.
  const rest = best.rest.replace(/^\/+/, "");
  return rest === ""
    ? best.entry.gatewayPath
    : path.join(best.entry.gatewayPath, ...rest.split("/"));
}

/**
 * What is left of `candidate` below `prefix`, or `undefined` if it is not below it. `""`
 * where the two name the same thing, and otherwise leading-separated.
 *
 * Both longest-prefix matches in this module ask this one question: the one turning a
 * Gateway path into a host path, and the one turning a container path back into a
 * Gateway path. They still choose their own winner among the matches, but what counts as
 * a match, and what is left over once one is taken, is settled here for both. A trailing
 * separator on the prefix means nothing, since a directory is the same directory either
 * way and an Operator writing one out is not making a different statement.
 */
function remainderUnder(candidate: string, prefix: string): string | undefined {
  const withoutTrailing = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (candidate === withoutTrailing) return "";
  return candidate.startsWith(`${withoutTrailing}/`)
    ? candidate.slice(withoutTrailing.length)
    : undefined;
}

/**
 * This process's `uid:gid`, or nothing where the platform has no such thing.
 *
 * The default rather than a documented step, because the failure a mismatch produces is
 * a Signal Handler that cannot read a file the agent definitely wrote.
 */
function ownUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}
