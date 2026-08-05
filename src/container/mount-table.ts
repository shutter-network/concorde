/**
 * The Mount Table: what the agent's container sees on disk.
 *
 * A value and a pure function, and that is the whole of it
 * ([ADR-0028](../../docs/adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)).
 * It creates nothing, writes nothing, starts nothing and checks nothing: resolution
 * refuses a declaration that cannot mean what it says, and emission turns the result
 * into `--mount` arguments and nothing else. Nothing here stats a path, so an Operator
 * composing their own table needs no temporary directory and no container to test it.
 *
 * It used to carry the container's user too, on the argument that what is shared and
 * who shares it are two halves of one fact. That argument is recorded and overruled in
 * ADR-0028: the user stopped being configuration at all, and the Agent Container Runtime
 * emits this process's own unconditionally.
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
 *
 * Each path is named for the actor that resolves it — `agentPath` the agent's own
 * container, `gatewayPath` the Gateway process, and through the translation the host —
 * so "container" is never the claimed word for one of them and the next path field
 * arrives named the same way, after who reads it rather than where it happens to run.
 */
export type Mount = {
  /**
   * Where the agent's container resolves it: the mount point the agent sees. Absolute,
   * and always POSIX whatever this platform is.
   */
  readonly agentPath: string;
  /** Where the Gateway process resolves it, on its own side. Absolute. */
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
 * The whole of the agent container's filesystem.
 *
 * Everything else about the container — the image, the entry point, the networks, the
 * environment, the flags the framework does not model — is the Agent Container's, which
 * carries one of these or carries none. The line is "the shared filesystem", not "every
 * container flag" and no longer "the shared filesystem and who shares it".
 */
export type MountTable = {
  /**
   * What the container sees.
   *
   * The order they are written in is preserved but means nothing: the daemon sorts bind
   * mounts by destination depth, so a nested entry nests under its parent whatever order
   * the two were declared in, and reordering the list changes no mount.
   *
   * An empty list is a deployment too, and is not refused: an image that bakes in its
   * own configuration and keeps no state between Runs mounts nothing. The cost is
   * silent — nothing the agent writes outlives its `--rm` container, so every Run is a
   * first Run — which is why ADR-0028 writes it down rather than guarding against it.
   */
  readonly entries: readonly Mount[];
  /**
   * How this Gateway's own filesystem maps to the host's, for a Gateway in a container.
   *
   * Absent means the Gateway runs on the host, which is the common case and costs
   * nothing to say: every entry's `gatewayPath` is its own source, because the daemon
   * resolves the same string this process does.
   *
   * They part company only when the Gateway is itself in a container, and that is **one
   * fact about the deployment** rather than a property of each mount — so it is one pair,
   * not a map. `gatewayPath` is where the shared tree sits inside this container;
   * `hostPath` is where the daemon finds that same tree on the host. Stated here, it is
   * stated in the place where it is true.
   *
   * Present, it is exhaustive. A `gatewayPath` equal to the root resolves to `hostPath`
   * whole; one below it resolves to `hostPath` plus the remainder; a trailing slash on
   * the root's `gatewayPath` is the same directory and means nothing. An entry falling
   * **outside** the root is **refused at resolution**, naming the entry's path and the
   * declared root, rather than falling back to identity — because a fallback is what turns
   * forgetting to widen the root into a deployment that starts, serves, and has one
   * silently empty directory in it.
   *
   * `hostPath` is handed to the daemon unread: nothing here requires it to look like a
   * path or checks that a subpath of it can exist. A Gateway whose shared tree spans more
   * than one host mount cannot say so through one pair; its escape is to declare no
   * `hostRoot` and write daemon-namespace paths straight into `gatewayPath`, which works
   * because translation is the only thing done with `gatewayPath` (ADR-0028), at the price
   * of entries this process cannot itself `ls`.
   *
   * Nothing discovers this. Reading the process's own mount information returns a
   * confident wrong path whenever a directory sits on a separate filesystem, a subvolume
   * or a virtual machine, and the round trip that once would have caught a bad guess is
   * gone. ADR-0028 records the deferral and the constraint on whoever picks it up: an
   * exact mechanism that fails loudly, or none.
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
 * One exported function and no structured intermediate between the table and the
 * arguments: the only consumer asks for the arguments and nothing else, and even the
 * tests assert on the emitted strings. An exported resolved layer would be a value with
 * no caller that uses its structure — a claim nothing tests — so it goes by the same
 * logic ADR-0028 used to delete `gatewayPathFor`.
 *
 * Pure and total: it applies `hostRoot`, refuses a relative path on either side, refuses
 * a `.` or `..` segment in any path it resolves, refuses an entry falling outside the
 * root, and refuses two entries naming one target. It performs no I/O, so what it cannot
 * tell you is whether any of these paths exists — that is the daemon's answer at the
 * first Run, and deliberately nobody else's (ADR-0028).
 *
 * The result is one `--mount` per entry, in declaration order, and nothing else at all.
 * There is no reverse lookup beside it: one existed, for the Gateway-side path of a
 * Session's transcript, and its only caller was a debug line that went with the Session
 * root; an honest one is three-way anyway, since `hostRoot` gives every mount three
 * names, and a two-way one silently picks an answer (ADR-0028).
 *
 * `createAgentContainerRuntime` calls it during construction, so a table that cannot
 * work is refused where the Operator wrote it rather than at the first Signal.
 */
export function mountArguments(table: MountTable): readonly string[] {
  if (table.hostRoot !== undefined) {
    refuseDotSegment("hostRoot's gatewayPath", table.hostRoot.gatewayPath);
  }
  const resolved = table.entries.map((entry) => resolveEntry(entry, table.hostRoot));
  refuseDuplicateAgentPath(resolved);
  return resolved.flatMap((entry) => ["--mount", mountArgument(entry)]);
}

/**
 * An entry with its defaults settled and its bind source resolved. Internal to this
 * module: nothing outside it names the structure, because the one consumer immediately
 * asks for the emitted arguments.
 */
type ResolvedEntry = {
  readonly agentPath: string;
  /**
   * What the daemon is given as the bind source: the `gatewayPath` through `hostRoot`.
   *
   * The same string as `gatewayPath` for a Gateway on the host, and the two are kept
   * apart anyway, because they are answers to different questions asked in different
   * filesystem namespaces and only one of them is the daemon's.
   */
  readonly hostPath: string;
  readonly readOnly: boolean;
};

function resolveEntry(entry: Mount, hostRoot: MountTable["hostRoot"]): ResolvedEntry {
  // A path inside the container, which the container runtime requires to be absolute,
  // and which is POSIX whatever this platform is.
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
 * What the daemon should be given for a Gateway-side path.
 *
 * Identity while `hostRoot` is absent, which is a Gateway on the host. Otherwise the one
 * pair does the whole translation: a `gatewayPath` equal to the root's resolves to
 * `hostPath` whole, one below it resolves to `hostPath` with the remainder appended, and
 * one outside the root is refused. A trailing slash on the root's `gatewayPath` is the
 * same directory and changes nothing.
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
 * The source is the entry's *host* path, because the daemon resolves it on the host and
 * not in whatever namespace this process is in. For a Gateway on the host the two are
 * one string, and `hostRoot` is what tells them apart when they are not.
 */
function mountArgument(entry: ResolvedEntry): string {
  const fields = ["type=bind", field("source", entry.hostPath), field("target", entry.agentPath)];
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

/**
 * Refuses a `.` or `..` **segment** in a path the framework resolves, naming the path and
 * telling the Operator to write it normalized rather than normalizing it for them.
 *
 * A segment is a component between slashes; only a whole `.` or `..` is one. A filename
 * that merely contains dots — `my.file`, `..hidden` — is not, and an empty segment from a
 * doubled slash is not either: `//` cannot escape the root and the daemon collapses it.
 *
 * Resolution treats these paths as plain strings and never normalizes them, so a dot
 * segment makes every comparison it does unsound. It is worst for `gatewayPath` under a
 * `hostRoot`, where `..` string-prefixes a root it resolves outside of and an entry reads
 * as covered while mounting anywhere; but it also defeats the duplicate-target check, for
 * which `/work/../etc` and `/etc` are one target the strings disagree on. Decidable from
 * the value with no I/O, which is ADR-0028's criterion for what resolution refuses.
 * `hostPath` is exempt: it is handed to the daemon unread, so it is not passed here.
 */
function refuseDotSegment(label: string, value: string): void {
  if (value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(
      `the ${label} ${JSON.stringify(value)} has a "." or ".." segment; write it as a normalized path, because resolution treats these paths as plain strings and a "." or ".." makes matching one against another unsound`,
    );
  }
}

/**
 * Refuses two entries that resolve to one target: `agentPath`s equal after the one
 * trailing-slash trim the prefix matching also grants, since a directory is the same
 * directory written with or without it.
 *
 * Mounting two sources at one target is otherwise the daemon's refusal at the first Run,
 * which under [ADR-0017](../../docs/adr/0017-failed-runs-are-not-retried.md) is a
 * permanently dead Signal — and it needs no I/O to see, which is ADR-0028's criterion. An
 * image-internal symlink aliasing two distinct targets stays the daemon's business: the
 * value never names what the image's own filesystem links where, so it is undecidable
 * from here.
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

/**
 * A path with one trailing separator removed, since a directory is the same directory
 * written with or without it. This is the one tolerance the string matching grants, and
 * both the prefix matching and the duplicate check grant exactly it.
 */
function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * What is left of `candidate` below `prefix`, or `undefined` if it is not below it. `""`
 * where the two name the same thing, and otherwise leading-separated.
 *
 * A trailing separator on the prefix means nothing, since a directory is the same
 * directory either way and an Operator writing one out is not making a different
 * statement.
 */
function remainderUnder(candidate: string, prefix: string): string | undefined {
  const withoutTrailing = withoutTrailingSlash(prefix);
  if (candidate === withoutTrailing) return "";
  return candidate.startsWith(`${withoutTrailing}/`)
    ? candidate.slice(withoutTrailing.length)
    : undefined;
}
