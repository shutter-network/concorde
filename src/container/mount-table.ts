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
 * package root rather than the `./pi` subpath: a second Runtime Adapter would need
 * exactly this and nothing of it would change.
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
 * The user belongs here rather than with the Runtime Adapter because every reason it
 * exists is a filesystem reason: with bind mounts the files the agent writes are owned
 * by the container's user, so a mismatch leaves Signal Handlers unable to read what the
 * agent wrote in the shared Workspace and the agent unable to read theirs. What is
 * shared and who shares it are the two halves of one fact, and they cannot come apart if
 * they are declared together.
 *
 * `network`, `workdir`, `extraArgs`, the image and the container command deliberately
 * stay with the Runtime Adapter. The line is "the shared filesystem and who shares it",
 * not "every container flag".
 */
export type MountTable = {
  /** At least one. An empty table is refused rather than producing a bare container. */
  readonly entries: readonly Mount[];
  /** The container's user, `uid:gid`. Defaults to this process's own. */
  readonly user?: string;
};

/** An entry with its defaults settled. */
export type ResolvedMount = {
  readonly containerPath: string;
  readonly gatewayPath: string;
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
   * mounts the Session root. It exists for the Runtime Adapter's debug line, which is
   * the only thing that can answer "where is this Session's transcript on my disk" — the
   * question ADR-0025 records the forgetful-agent failure as being diagnosed with. A
   * Runtime Adapter that still writes files of its own uses it for those too, and that
   * is the whole of what a container path is ever turned back into.
   */
  gatewayPathFor(containerPath: string): string | undefined;
};

/**
 * Settles a Mount Table, or refuses it.
 *
 * Pure and total: it defaults the user, refuses a relative path on either side, and
 * refuses a table with no entries. It performs no I/O, so what it cannot tell you is
 * whether any of these paths exists — that is the daemon's answer at the first Run, and
 * deliberately nobody else's (ADR-0028).
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

  const entries = table.entries.map(resolveEntry);
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

function resolveEntry(entry: Mount): ResolvedMount {
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
    readOnly: entry.readOnly ?? false,
  };
}

/**
 * One `--mount` value: `type=bind,source=…,target=…`, and `readonly` where declared.
 *
 * The source is the entry's Gateway-side path, because the mapping between the two is
 * the identity — which is a Gateway running on the host, and the only case there is
 * until a translation table exists for the one where it is not.
 */
function mountArgument(entry: ResolvedMount): string {
  const fields = [
    "type=bind",
    field("source", entry.gatewayPath),
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
  let best: ResolvedMount | undefined;
  for (const entry of entries) {
    if (!isUnder(containerPath, entry.containerPath)) continue;
    if (best === undefined || entry.containerPath.length > best.containerPath.length) {
      best = entry;
    }
  }
  if (best === undefined) return undefined;

  // The remainder is a container path and therefore POSIX; the answer is a path on this
  // platform, so the two are joined with what this platform separates paths with.
  const rest = containerPath.slice(best.containerPath.length).replace(/^\/+/, "");
  return rest === "" ? best.gatewayPath : path.join(best.gatewayPath, ...rest.split("/"));
}

/** Whether `candidate` is the mount point itself or something inside it. */
function isUnder(candidate: string, mountPoint: string): boolean {
  if (candidate === mountPoint) return true;
  return candidate.startsWith(mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`);
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
