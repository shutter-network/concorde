/**
 * The startup check: does the agent's container actually see the directories the
 * Gateway thinks it mounted, and as the same user?
 *
 * This deliberately **replaces auto-detection**. Deciding "am I in a container" is a
 * heuristic — `/.dockerenv` is Docker-specific, `/proc/1/cgroup` parsing broke with
 * cgroup v2, Podman and Kubernetes differ — and a wrong guess produces exactly the
 * failure it was meant to prevent: the daemon resolves an unknown source **on the
 * host**, silently creates an empty directory, and the agent sees an empty Workspace
 * with nothing reported anywhere ([ADR-0025](../../docs/adr/0025-the-pi-adapter-spawns-one-confined-process-per-run.md)).
 *
 * So one throwaway container is started at boot and asked to prove it. The Gateway
 * writes a token into each mount, the container reads it back and writes one of its
 * own, and the Gateway reads that. Both directions, because both directions are used:
 * a Signal Handler writes a file for the agent, and the agent writes one for the
 * Handler's post phase.
 *
 * **All three mounts, not only the Workspace.** The Workspace failing is the loud
 * case — the agent reports that a file a Handler definitely wrote is missing. The
 * other two are worse:
 *
 *  - a wrong `agentDir` **cannot fail**. `pi` resolves `--append-system-prompt` with
 *    `existsSync(input) ? readFileSync(input) : input`, so a missing instructions
 *    file makes the agent's instructions the literal string
 *    `/…/gateway-instructions.md`. It then runs, answers, and settles successfully,
 *    knowing nothing about the Agent server it was supposed to be told about.
 *  - a wrong `sessionRoot` makes every Session start empty. Each Run succeeds; a
 *    named Session simply never remembers anything, which reads as the model being
 *    forgetful rather than as a broken deployment.
 *
 * What it cannot check is the network or the model: those fail loudly on the first
 * Run, with a message. These three fail silently and forever.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logging.ts";
import {
  type MountRole,
  mountsOf,
  type ResolvedMount,
  type ResolvedPiConfiguration,
} from "./configuration.ts";
import { readAllText, runContainer } from "./process.ts";

/**
 * One mount under test: everything the check writes, reads and says about it.
 *
 * Built once per mount so that the tokens, the two file names on this side, and the
 * same two as the container names them are computed together. The failure this check
 * exists for is two sides looking at different paths, which is not a thing to risk
 * recomputing in six places.
 */
type Probe = {
  readonly role: MountRole;
  readonly mount: ResolvedMount;
  /**
   * Whether the framework may create `localPath` when it is missing.
   *
   * The Workspace may not be: it is the Operator's, shared with their Signal
   * Handlers, and a Gateway that conjured it would hide a wrong path rather than fail
   * on it. The other two are the framework's own — it writes the agent's configuration
   * into one, and the Agent Runtime creates each Session's directory inside the other.
   *
   * That second one is why this is not merely convenience: a bind mount whose source
   * is missing is created by the daemon **as `root`**, and the agent's container, which
   * runs as the Gateway's uid, then cannot write inside it. Creating it here, from this
   * process, is what makes it the Gateway's.
   */
  readonly createLocally: boolean;
  /** What the Gateway writes, for the container to read back. */
  readonly gatewayToken: string;
  /** What the container writes, for the Gateway to read back. */
  readonly agentToken: string;
  /** What the container appends to the Gateway's own file. */
  readonly agentAppendix: string;
  /** The Gateway's file, named on both sides of the mount. */
  readonly gatewayFile: MountedFile;
  /** The container's file, named on both sides of the mount. */
  readonly agentFile: MountedFile;
};

/**
 * One file, as each side of a mount names it.
 *
 * Joined differently on purpose: the agent's is a path inside the container and always
 * POSIX, and the Gateway's is whatever this platform separates paths with.
 */
type MountedFile = { readonly local: string; readonly agent: string };

/** What the container is asked to say, one line per fact. */
type Reported = {
  readonly user: string | undefined;
  /** What the container read out of each mount, by role. */
  readonly read: Map<string, string>;
  /** The roles it could write a file into. */
  readonly wrote: Set<string>;
  /** The roles it could append to the Gateway's own file in. */
  readonly appended: Set<string>;
};

/** The mounts the framework creates when they are not there. Not the Workspace. */
const created: ReadonlySet<MountRole> = new Set<MountRole>(["agentDir", "sessionRoot"]);

/**
 * Verifies every mount, or throws naming the one that is wrong.
 *
 * Throwing is how startup is refused: the Operator calls this before starting the
 * Core, and an exception from their entry point stops the deploy. Nothing is retried
 * and nothing is degraded — a Gateway whose agent cannot see the Workspace has
 * nothing useful to do (ADR-0017).
 */
export async function verifyMounts(config: ResolvedPiConfiguration, log: Logger): Promise<void> {
  const probes = probesFor(config);

  try {
    for (const probe of probes) await writeGatewayToken(probe);

    const args = checkArgs(config, checkScript(probes));
    log.debug(
      // Without the script itself, which is the last argument and is long, mechanical,
      // and of no use to whoever is reading this line to compare a source path.
      { command: config.containerCommand[0], args: [...args.slice(0, -1), "<the check>"] },
      "verifying the agent's mounts with a throwaway container",
    );
    const result = await runContainer(
      { command: config.containerCommand[0], args, stdin: "" },
      readAllText,
    );

    const reported = parseReport(result.value);
    if (reported.user === undefined) {
      throw new Error(
        `the mount check could not be run in image ${JSON.stringify(config.image)}: it starts a throwaway container with --entrypoint sh and expects a few lines back, and got none. The image needs a POSIX shell for this check. The container exited with code ${result.exitCode}${result.stderr === "" ? "" : ` and said: ${result.stderr}`}`,
      );
    }

    for (const probe of probes) await verifyOne(probe, reported);

    log.info(
      {
        containerUser: reported.user,
        ...Object.fromEntries(probes.map((probe) => [probe.role, probe.mount.source])),
      },
      "the agent's container reads and writes every mount, as this process's own user",
    );
  } finally {
    // Best effort, and after a failure as much as after a success: these are six
    // dotfiles in directories an Operator's Handlers also use.
    await Promise.all(
      probes.flatMap((probe) =>
        [probe.gatewayFile.local, probe.agentFile.local].map((file) =>
          rm(file, { force: true }).catch(() => undefined),
        ),
      ),
    );
  }
}

/**
 * One probe per mount, all sharing one nonce.
 *
 * The nonce is what keeps a token left behind by a check that crashed halfway from
 * being read as this one's answer.
 */
function probesFor(config: ResolvedPiConfiguration): readonly Probe[] {
  const nonce = randomUUID();
  return mountsOf(config).map(({ role, mount }) => ({
    role,
    mount,
    createLocally: created.has(role),
    gatewayToken: `${nonce} ${role} written by the Gateway`,
    agentToken: `${nonce} ${role} written by the agent`,
    agentAppendix: `${nonce} ${role} appended by the agent`,
    gatewayFile: filesFor(mount, `.saf-mount-check-gateway-${nonce}`),
    agentFile: filesFor(mount, `.saf-mount-check-agent-${nonce}`),
  }));
}

function filesFor(mount: ResolvedMount, name: string): MountedFile {
  return {
    local: path.join(mount.localPath, name),
    agent: path.posix.join(mount.agentPath, name),
  };
}

/**
 * Why each mount has to be writable by this process, one sentence per role.
 *
 * Keyed by role rather than by whether the framework creates the directory, because the
 * two it creates are created for different reasons: it writes the agent's configuration
 * into one, and never writes anything at all into the other.
 */
const unwritable: Readonly<Record<MountRole, string>> = {
  workspace:
    "The Workspace is the Operator's, shared with their Signal Handlers, and the framework never creates it: a Gateway that conjured a missing one would hide a wrong path instead of failing on it.",
  agentDir: "That is where the framework writes the agent's configuration before every Run.",
  sessionRoot:
    "That is where the agent's container creates each Session's own directory, as this process's own user — so what cannot write here is the agent, and a Signal Handler reading a transcript back.",
};

async function writeGatewayToken(probe: Probe): Promise<void> {
  if (probe.createLocally) {
    await mkdir(probe.mount.localPath, { recursive: true }).catch((error: unknown) => {
      throw new Error(
        mountProblem(
          probe,
          `the Gateway cannot create its localPath: ${describe(error)}`,
          "This directory is the framework's own — the agent's configuration is written into one and the Agent Runtime creates its Session directories inside the other — so it is created rather than required to exist.",
        ),
        { cause: error },
      );
    });
  }
  await writeFile(probe.gatewayFile.local, probe.gatewayToken, "utf8").catch((error: unknown) => {
    throw new Error(
      mountProblem(
        probe,
        `the Gateway cannot write into its localPath: ${describe(error)}`,
        unwritable[probe.role],
      ),
      { cause: error },
    );
  });
}

/**
 * The shell the throwaway container runs.
 *
 * Deliberately without `set -e`: every mount is reported on, so an Operator whose
 * `source` values are all wrong learns that once rather than three deploys running.
 * Each line is `key=value`, and the values are tokens with no newline in them, so the
 * report survives being read as lines.
 */
function checkScript(probes: readonly Probe[]): string {
  const lines = ["set -u", `printf 'user=%s:%s\\n' "$(id -u)" "$(id -g)"`];
  for (const { role, gatewayFile, agentFile, agentToken, agentAppendix } of probes) {
    lines.push(
      // Read before appending, or the append would be in what is read back.
      `if token=$(cat ${quote(gatewayFile.agent)} 2>/dev/null); then printf 'read=%s=%s\\n' ${quote(role)} "$token"; else printf 'unreadable=%s\\n' ${quote(role)}; fi`,
      `if printf '%s' ${quote(agentToken)} > ${quote(agentFile.agent)} 2>/dev/null; then printf 'wrote=%s\\n' ${quote(role)}; else printf 'unwritable=%s\\n' ${quote(role)}; fi`,
      `if printf '\\n%s' ${quote(agentAppendix)} >> ${quote(gatewayFile.agent)} 2>/dev/null; then printf 'appended=%s\\n' ${quote(role)}; else printf 'unappendable=%s\\n' ${quote(role)}; fi`,
    );
  }
  return lines.join("\n");
}

/** A value the shell will take literally, whatever is in it. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The throwaway container's own invocation, which is not a Run's.
 *
 * No `--env`, no `--network` and no `--workdir`: this container answers one question
 * and touching the others only adds ways for it to fail for a reason that is not a
 * mount. `extraArgs` *is* passed, because a deployment needing `--platform` or an
 * added host needs it to start at all — but before `--entrypoint`, which is the one
 * flag the check cannot let an Operator override, since overriding it means the
 * shell script is handed to `pi` as arguments instead.
 */
function checkArgs(config: ResolvedPiConfiguration, script: string): string[] {
  const args = [...config.containerCommand.slice(1), "run", "--rm"];
  if (config.user !== undefined) args.push("--user", config.user);
  for (const { mount } of mountsOf(config)) {
    args.push("--volume", `${mount.source}:${mount.agentPath}`);
  }
  args.push(...config.extraArgs, "--entrypoint", "sh", config.image, "-c", script);
  return args;
}

function parseReport(output: string): Reported {
  const read = new Map<string, string>();
  const wrote = new Set<string>();
  const appended = new Set<string>();
  let user: string | undefined;
  for (const line of output.split("\n")) {
    const [key, rest] = line.split(/=(.*)/s);
    if (rest === undefined) continue;
    if (key === "user") user = rest;
    if (key === "wrote") wrote.add(rest);
    if (key === "appended") appended.add(rest);
    if (key === "read") {
      const [role, token] = rest.split(/=(.*)/s);
      if (role !== undefined && token !== undefined) read.set(role, token);
    }
  }
  return { user, read, wrote, appended };
}

/** Everything one mount has to satisfy, in the order that makes a failure legible. */
async function verifyOne(probe: Probe, reported: Reported): Promise<void> {
  const seen = reported.read.get(probe.role);
  if (seen !== probe.gatewayToken) {
    throw new Error(
      mountProblem(
        probe,
        seen === undefined
          ? "the container could not read the token the Gateway had just written into it"
          : `the container read ${JSON.stringify(seen)} where the Gateway had written ${JSON.stringify(probe.gatewayToken)}`,
        `The container runtime resolves the mount's source **on the host**, not inside this process, and a source it cannot find is silently created as an empty directory rather than refused — so an empty directory and no error is what a wrong source looks like (ADR-0025). Check ${JSON.stringify(probe.mount.source)} against where this process actually reads ${JSON.stringify(probe.mount.localPath)}.`,
      ),
    );
  }
  if (!reported.wrote.has(probe.role)) {
    throw new Error(
      mountProblem(
        probe,
        "the container could not write a file into it",
        "The container runs as this process's own user, so the mount has to be writable by that user from inside as well as outside. A read-only mount in extraArgs would also do this.",
      ),
    );
  }
  if (!reported.appended.has(probe.role)) {
    throw new Error(
      mountProblem(
        probe,
        "the container could read the Gateway's file but could not write to it",
        "Files the Gateway and the agent share are written by both: a Signal Handler leaves one for the agent, and the agent edits it. That needs the same user on both sides, which is what --user is for.",
      ),
    );
  }

  const content = await readFile(probe.agentFile.local, "utf8").catch((error: unknown) => {
    throw new Error(
      mountProblem(
        probe,
        `the container wrote a file into it and this process cannot read that file back at ${JSON.stringify(probe.agentFile.local)}: ${describe(error)}`,
        "The two sides are looking at different directories. The agent's writes reaching nothing the Gateway can see is the failure this check exists for.",
      ),
      { cause: error },
    );
  });
  if (content !== probe.agentToken) {
    throw new Error(
      mountProblem(
        probe,
        `this process read ${JSON.stringify(content)} out of the file the container wrote, where the container wrote ${JSON.stringify(probe.agentToken)}`,
        "The two sides are looking at different directories.",
      ),
    );
  }

  await assertOwnedByThisProcess(probe);

  await appendFile(probe.agentFile.local, "\nappended by the Gateway", "utf8").catch(
    (error: unknown) => {
      throw new Error(
        mountProblem(
          probe,
          `this process cannot write to a file the container created: ${describe(error)}`,
          "A Signal Handler's post phase editing what the agent left behind is an ordinary thing to do, and a user mismatch is what stops it.",
        ),
        { cause: error },
      );
    },
  );

  const roundTripped = await readFile(probe.gatewayFile.local, "utf8");
  if (!roundTripped.includes(probe.agentAppendix)) {
    throw new Error(
      mountProblem(
        probe,
        "the container appended to the Gateway's own file and this process cannot see the change",
        "Both sides report success while looking at different copies, which is what a mount that is not shared at all looks like.",
      ),
    );
  }
}

/**
 * Refuses a mount where a file the container created does not belong to this process.
 *
 * The direct form of what ADR-0025 requires: with bind mounts the files the agent
 * writes are owned by the container's user, so a mismatch leaves Signal Handlers
 * unable to read what the agent wrote in the shared Workspace, and the reverse. Asked
 * of the file rather than of `--user`, because an Operator may have a good reason to
 * set `user` to something other than this process's own, and the thing that matters is
 * the ownership that results.
 *
 * **The uid is compared and the gid is not**, though ADR-0025 names both. A file
 * created in a `setgid` directory takes the directory's group rather than the writer's,
 * on both sides equally, so refusing a deployment over a gid that differs from this
 * process's would refuse deployments that work. What the group would have bought — that
 * each side can read and write what the other wrote — is proven directly, by the round
 * trip either side of this call. The gid is still reported, because it is the next
 * thing to look at when the uid is wrong.
 *
 * Note what this can and cannot see: under a real bind mount — a Linux daemon — it is
 * exact. Docker Desktop's file sharing remaps ownership to the host user, so there it
 * passes whatever `--user` says; the read and write checks around it still hold, which
 * is the part that is observable there at all.
 */
async function assertOwnedByThisProcess(probe: Probe): Promise<void> {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return;
  const attributes = await stat(probe.agentFile.local);
  if (attributes.uid === process.getuid()) return;
  throw new Error(
    mountProblem(
      probe,
      `the file the container wrote is owned by uid ${attributes.uid} (gid ${attributes.gid}) and this process is uid ${process.getuid()} (gid ${process.getgid()})`,
      "The container has to run as the Gateway's own user, or a Signal Handler cannot read what the agent wrote in the shared Workspace and the agent cannot read what the Handler wrote. The adapter defaults --user to this process's uid and gid; a `user` set explicitly overrides that.",
    ),
  );
}

/** One failure message: which mount, what happened, and what it usually means. */
function mountProblem(probe: Probe, problem: string, hint: string): string {
  const { localPath, agentPath, source } = probe.mount;
  return `the ${probe.role} mount does not reach the agent's container: ${problem}. ${hint} This mount is localPath ${JSON.stringify(localPath)}, agentPath ${JSON.stringify(agentPath)}, source ${JSON.stringify(source)}.`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
