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
   * What the container sees, in the order it is declared.
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
 * Pure and total: it applies `hostPaths`, refuses a relative path on either side, and
 * refuses an entry no `hostPaths` prefix covers. It performs no I/O, so what it cannot
 * tell you is whether any of these paths exists — that is the daemon's answer at the
 * first Run, and deliberately nobody else's (ADR-0028).
 *
 * The result is one `--mount` per entry, in declaration order, and nothing else at all.
 * There is no reverse lookup beside it: one existed, for the Gateway-side path of a
 * Session's transcript, and its only caller was a debug line that went with the Session
 * root; an honest one is three-way anyway, since `hostPaths` gives every mount three
 * names, and a two-way one silently picks an answer (ADR-0028).
 *
 * `createAgentContainerRuntime` calls it during construction, so a table that cannot
 * work is refused where the Operator wrote it rather than at the first Signal.
 */
export function mountArguments(table: MountTable): readonly string[] {
  const hostPaths = table.hostPaths ?? {};
  return table.entries.flatMap((entry) => [
    "--mount",
    mountArgument(resolveEntry(entry, hostPaths)),
  ]);
}

/**
 * An entry with its defaults settled and its bind source resolved. Internal to this
 * module: nothing outside it names the structure, because the one consumer immediately
 * asks for the emitted arguments.
 */
type ResolvedEntry = {
  readonly agentPath: string;
  /**
   * What the daemon is given as the bind source: the `gatewayPath` through `hostPaths`.
   *
   * The same string as `gatewayPath` for a Gateway on the host, and the two are kept
   * apart anyway, because they are answers to different questions asked in different
   * filesystem namespaces and only one of them is the daemon's.
   */
  readonly hostPath: string;
  readonly readOnly: boolean;
};

function resolveEntry(entry: Mount, hostPaths: Readonly<Record<string, string>>): ResolvedEntry {
  // A path inside the container, which the container runtime requires to be absolute,
  // and which is POSIX whatever this platform is.
  if (!entry.agentPath.startsWith("/")) {
    throw new Error(
      `the mount's agentPath ${JSON.stringify(entry.agentPath)} is not absolute; it is a path inside the agent's container, which the container runtime requires to be absolute`,
    );
  }
  if (!path.isAbsolute(entry.gatewayPath)) {
    throw new Error(
      `the mount's gatewayPath ${JSON.stringify(entry.gatewayPath)} is not absolute, so which directory it names would depend on the working directory the Gateway was started from`,
    );
  }
  return {
    agentPath: entry.agentPath,
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
 * What is left of `candidate` below `prefix`, or `undefined` if it is not below it. `""`
 * where the two name the same thing, and otherwise leading-separated.
 *
 * A trailing separator on the prefix means nothing, since a directory is the same
 * directory either way and an Operator writing one out is not making a different
 * statement.
 */
function remainderUnder(candidate: string, prefix: string): string | undefined {
  const withoutTrailing = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (candidate === withoutTrailing) return "";
  return candidate.startsWith(`${withoutTrailing}/`)
    ? candidate.slice(withoutTrailing.length)
    : undefined;
}
