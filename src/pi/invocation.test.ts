/**
 * The container invocation, and the Session name a Prompt runs under.
 *
 * All of it is a pure function of a configuration and a Prompt, so these are fast
 * tests with no Docker and no credentials. What they cannot prove is that the mounts
 * actually resolve or that the user ids match — nothing but a real container can, and
 * that is the one opt-in test in the ticket that follows this one.
 *
 * Assertions are on the composed argv rather than on a rendered string, and several of
 * them are on flag *pairs* (`--flag value`), because that is the property a mistake
 * breaks: `pi` is not the process being started, `docker` is, and a flag that lands on
 * the wrong side of the image name reaches the wrong program.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Prompt } from "../core/handlers.ts";
import type { PiConfiguration } from "./configuration.ts";
import { resolveMount, resolvePiConfiguration } from "./configuration.ts";
import { composeInvocation, instructionsFileName, type PiInvocation } from "./invocation.ts";

/** A Run id, of the shape the Core hands the adapter. */
const runId = "6f1a3c7e-0000-4000-8000-000000000001";

/** The least configuration the adapter accepts, with matching paths throughout. */
const minimal: PiConfiguration = {
  image: "saf/pi:latest",
  model: "anthropic/claude-sonnet-4-5",
  workspace: "/srv/saf/workspace",
  agentDir: "/srv/saf/agent",
  sessionRoot: "/srv/saf/sessions",
  agentServerUrl: "http://host.docker.internal:7411",
};

function invocationFor(
  config: Partial<PiConfiguration> = {},
  prompt: Prompt = { session: "user_42", text: "what happened?" },
): PiInvocation {
  return composeInvocation({ ...minimal, ...config }, prompt, runId);
}

/**
 * This process's `uid:gid`, which is what the adapter defaults `--user` to.
 *
 * Asserted rather than assumed, because these two are absent on Windows and the
 * assertion is the honest statement of what the container topology needs.
 */
function ownUser(): string {
  assert.ok(
    typeof process.getuid === "function" && typeof process.getgid === "function",
    "the Gateway's bind mounts need a uid and a gid, which this platform does not have",
  );
  return `${process.getuid()}:${process.getgid()}`;
}

/** The argument after `flag`, asserting the flag appears exactly once. */
function argumentAfter(invocation: PiInvocation, flag: string): string {
  const occurrences = invocation.args.filter((arg) => arg === flag);
  assert.equal(occurrences.length, 1, `${flag} should appear once in ${invocation.args.join(" ")}`);
  const value = invocation.args[invocation.args.indexOf(flag) + 1];
  assert.ok(value !== undefined, `${flag} should be followed by a value`);
  return value;
}

/** Every value given to a flag that may repeat, in order. */
function valuesOf(invocation: PiInvocation, flag: string): string[] {
  return invocation.args.flatMap((arg, at) =>
    arg === flag ? [invocation.args[at + 1] ?? ""] : [],
  );
}

/** The arguments before the image name, which belong to the container runtime. */
function containerArgsOf(invocation: PiInvocation): string[] {
  const at = invocation.args.indexOf(minimal.image);
  assert.notEqual(at, -1, "the image should appear in the arguments");
  return invocation.args.slice(0, at);
}

/** The arguments after the image name, which belong to the agent. */
function agentArgsOf(invocation: PiInvocation): string[] {
  return invocation.args.slice(invocation.args.indexOf(minimal.image) + 1);
}

describe("a mount", () => {
  it("expands a single path to all three roles", () => {
    assert.deepEqual(resolveMount("/srv/saf/workspace"), {
      localPath: "/srv/saf/workspace",
      agentPath: "/srv/saf/workspace",
      source: "/srv/saf/workspace",
    });
  });

  it("expands the object form the same way, one field at a time", () => {
    assert.deepEqual(resolveMount({ localPath: "/local" }), {
      localPath: "/local",
      agentPath: "/local",
      source: "/local",
    });
    assert.deepEqual(resolveMount({ localPath: "/local", agentPath: "/inside" }), {
      localPath: "/local",
      agentPath: "/inside",
      source: "/local",
    });
    assert.deepEqual(resolveMount({ localPath: "/local", source: "/on-the-host" }), {
      localPath: "/local",
      agentPath: "/local",
      source: "/on-the-host",
    });
  });

  it("keeps all three when all three differ, which is the containerised Gateway", () => {
    assert.deepEqual(
      resolveMount({ localPath: "/data/workspace", agentPath: "/workspace", source: "saf-work" }),
      { localPath: "/data/workspace", agentPath: "/workspace", source: "saf-work" },
    );
  });

  it("takes a named volume as a source, since that is all a named volume ever is here", () => {
    // ADR-0025: a deployment using one mounts it into the Gateway too, so the Gateway
    // sees an ordinary directory. Refusing a non-path source would refuse that.
    const mount = resolveMount({ localPath: "/data/agent", source: "saf-agent-state" });
    assert.equal(mount.source, "saf-agent-state");
  });

  it("refuses a localPath that is not absolute, naming which mount it was", () => {
    assert.throws(() => resolveMount("./workspace", "workspace"), /workspace.*not absolute/s);
  });

  it("refuses an agentPath that is not absolute", () => {
    assert.throws(
      () => resolveMount({ localPath: "/local", agentPath: "workspace" }, "workspace"),
      /agentPath.*absolute/s,
    );
  });

  it("refuses a colon in any of the three, because that is what --volume splits on", () => {
    for (const mount of [
      { localPath: "/srv/a:b" },
      { localPath: "/srv/a", agentPath: "/in:side" },
      { localPath: "/srv/a", source: "vol:ume" },
    ]) {
      assert.throws(() => resolveMount(mount, "workspace"), /colon/);
    }
  });
});

describe("the composed invocation", () => {
  it("starts the container runtime, which is docker unless told otherwise", () => {
    assert.equal(invocationFor().command, "docker");
    assert.equal(containerArgsOf(invocationFor())[0], "run");

    const podman = composeInvocation(
      { ...minimal, containerCommand: ["podman"] },
      { session: "user_42", text: "hi" },
      runId,
    );
    assert.equal(podman.command, "podman");
    assert.equal(podman.args[0], "run");
  });

  it("takes a container runtime that needs arguments of its own", () => {
    const invocation = composeInvocation(
      { ...minimal, containerCommand: ["sudo", "docker"] },
      { session: "user_42", text: "hi" },
      runId,
    );

    assert.equal(invocation.command, "sudo");
    assert.deepEqual(invocation.args.slice(0, 2), ["docker", "run"]);
  });

  it("removes the container and keeps stdin open, but gives it no TTY", () => {
    const args = containerArgsOf(invocationFor());

    assert.ok(args.includes("--rm"), "one fresh process per Run leaves nothing behind");
    assert.ok(args.includes("--interactive"), "the Prompt is written to stdin");
    // A TTY would make `pi` believe it is being used interactively.
    assert.ok(!args.includes("--tty") && !args.includes("-t"), "there must be no TTY");
  });

  it("mounts all three directories by source and agent path, and works in the Workspace", () => {
    const invocation = invocationFor({
      workspace: { localPath: "/data/workspace", agentPath: "/workspace", source: "/host/work" },
      agentDir: {
        localPath: "/data/agent",
        agentPath: "/home/agent/.pi/agent",
        source: "saf-agent",
      },
      sessionRoot: {
        localPath: "/data/sessions",
        agentPath: "/sessions",
        source: "/host/sessions",
      },
    });

    assert.deepEqual(valuesOf(invocation, "--volume"), [
      "/host/work:/workspace",
      "saf-agent:/home/agent/.pi/agent",
      "/host/sessions:/sessions",
    ]);
    // The container's working directory is where the agent sees the Workspace, not
    // where the Gateway does.
    assert.equal(argumentAfter(invocation, "--workdir"), "/workspace");
  });

  it("runs as this process's own user, so bind-mounted files are readable both ways", () => {
    assert.equal(argumentAfter(invocationFor(), "--user"), ownUser());
    assert.equal(argumentAfter(invocationFor({ user: "1000:1000" }), "--user"), "1000:1000");
  });

  it("joins a network only when one was named", () => {
    assert.equal(argumentAfter(invocationFor({ network: "saf-agent" }), "--network"), "saf-agent");
    assert.ok(!invocationFor().args.includes("--network"));
  });

  it("passes the Operator's environment, and its own where the agent's directory is", () => {
    const invocation = invocationFor({ env: { ANTHROPIC_API_KEY: "sk-test", HTTPS_PROXY: "" } });

    const env = valuesOf(invocation, "--env");
    assert.ok(env.includes("ANTHROPIC_API_KEY=sk-test"));
    assert.ok(env.includes("HTTPS_PROXY="), "an empty value is still a variable that is set");
    assert.ok(env.includes("PI_CODING_AGENT_DIR=/srv/saf/agent"));
    assert.ok(env.includes("PI_OFFLINE=1"));
  });

  it("lets the Operator override the offline default, which is only a preference", () => {
    // Skipping `pi`'s startup version check and update telemetry is what a Gateway
    // wants and not something the framework is entitled to insist on.
    const invocation = invocationFor({ env: { PI_OFFLINE: "0" } });

    assert.deepEqual(
      valuesOf(invocation, "--env").filter((value) => value.startsWith("PI_OFFLINE=")),
      ["PI_OFFLINE=0"],
    );
  });

  it("keeps the agent's directory pointed at the mount whatever the Operator set", () => {
    // Overriding it would send the agent looking for its configuration somewhere the
    // Gateway never wrote any, and it would run unconfigured rather than fail.
    const invocation = invocationFor({ env: { PI_CODING_AGENT_DIR: "/somewhere/else" } });

    assert.deepEqual(
      valuesOf(invocation, "--env").filter((value) => value.startsWith("PI_CODING_AGENT_DIR=")),
      ["PI_CODING_AGENT_DIR=/srv/saf/agent"],
    );
  });

  it("offers the same arguments with the environment values taken out, for the log line", () => {
    const invocation = invocationFor({
      env: { ANTHROPIC_API_KEY: "sk-a-real-key", HTTPS_PROXY: "" },
      extraArgs: ["--env", "OPENAI_API_KEY=another-real-key"],
    });

    // The composed invocation is logged so that a mount or network problem can be
    // diagnosed, and it carries whatever `env` holds.
    assert.ok(!invocation.redactedArgs.join(" ").includes("sk-a-real-key"));
    assert.ok(!invocation.redactedArgs.join(" ").includes("another-real-key"));
    assert.deepEqual(valuesOf({ ...invocation, args: invocation.redactedArgs }, "--env"), [
      // The framework's own two are kept: where the agent's directory is mounted is one
      // of the values a mount problem is diagnosed from, which is why this is logged.
      "PI_OFFLINE=1",
      "ANTHROPIC_API_KEY=…",
      "HTTPS_PROXY=",
      "PI_CODING_AGENT_DIR=/srv/saf/agent",
      "OPENAI_API_KEY=…",
    ]);
    // Nothing else changes, so the two arrays stay comparable.
    assert.equal(invocation.redactedArgs.length, invocation.args.length);
    assert.deepEqual(
      invocation.redactedArgs.filter((arg) => !arg.includes("=")),
      invocation.args.filter((arg) => !arg.includes("=")),
    );
  });

  it("puts extra container flags last, so they also override the ones it composed", () => {
    const invocation = invocationFor({
      extraArgs: ["--memory", "2g", "--user", "0:0", "--cap-drop", "ALL"],
    });

    const extra = ["--memory", "2g", "--user", "0:0", "--cap-drop", "ALL"];
    assert.deepEqual(containerArgsOf(invocation).slice(-extra.length), extra);
    // Both `--user` values are there and the Operator's is the later one, which is the
    // one the container runtime keeps.
    assert.deepEqual(valuesOf(invocation, "--user"), [ownUser(), "0:0"]);
  });

  it("puts nothing of the container runtime's after the image, and nothing of the agent's before it", () => {
    const invocation = invocationFor({ network: "saf-agent", extraArgs: ["--memory", "2g"] });

    for (const flag of ["run", "--rm", "--volume", "--workdir", "--env", "--memory"]) {
      assert.ok(containerArgsOf(invocation).includes(flag), `${flag} is the container runtime's`);
      assert.ok(!agentArgsOf(invocation).includes(flag), `${flag} must not reach the agent`);
    }
    for (const flag of ["--mode", "--model", "--session-id", "--session-dir"]) {
      assert.ok(agentArgsOf(invocation).includes(flag), `${flag} is the agent's`);
      assert.ok(!containerArgsOf(invocation).includes(flag), `${flag} must not reach docker`);
    }
  });
});

describe("what the agent is told", () => {
  it("asks for the machine-readable event stream", () => {
    assert.equal(argumentAfter(invocationFor(), "--mode"), "json");
  });

  it("names the model, and the provider only when one was given", () => {
    // `minimal.model` is already qualified as `provider/id`, which is why no `--provider`
    // is expected with it; the field is for a model named on its own.
    assert.equal(argumentAfter(invocationFor(), "--model"), minimal.model);
    assert.ok(!invocationFor().args.includes("--provider"));

    const named = invocationFor({ model: "claude-sonnet-4-5", provider: "anthropic" });
    assert.equal(argumentAfter(named, "--model"), "claude-sonnet-4-5");
    assert.equal(argumentAfter(named, "--provider"), "anthropic");
  });

  it("resolves the Session with the flag that creates it if missing", () => {
    const invocation = invocationFor();

    assert.equal(argumentAfter(invocation, "--session-id"), "user_42");
    // `--session` resolves only an existing Session and exits 1 otherwise, which would
    // fail every first Run of a named Session (ADR-0006, ADR-0025).
    assert.ok(!invocation.args.includes("--session"));
    assert.ok(!invocation.args.includes("--no-session"));
    assert.ok(!invocation.args.includes("--continue"));
    assert.ok(!invocation.args.includes("--resume"));
  });

  it("gives the Session a directory of its own under the Session root", () => {
    const invocation = invocationFor({
      sessionRoot: { localPath: "/data/sessions", agentPath: "/sessions" },
    });

    assert.equal(argumentAfter(invocation, "--session-dir"), "/sessions/user_42");
    assert.equal(invocation.sessionDirectory, "/data/sessions/user_42");
  });

  it("appends the instructions file the Gateway wrote into the agent's directory", () => {
    const invocation = invocationFor({
      agentDir: { localPath: "/data/agent", agentPath: "/home/agent/.pi/agent" },
    });

    assert.equal(
      argumentAfter(invocation, "--append-system-prompt"),
      `/home/agent/.pi/agent/${instructionsFileName}`,
    );
  });

  it("ignores project-local configuration in the Workspace", () => {
    // The Workspace is writable by the agent and `trust.json` persists between Runs,
    // so without this one Run could arrange for the next to load its settings from the
    // Workspace — a reconfiguration that survives, which is the thing rewriting the
    // configuration every Run exists to prevent (ADR-0003, ADR-0025).
    assert.ok(agentArgsOf(invocationFor()).includes("--no-approve"));
    assert.ok(!invocationFor().args.includes("--approve"));
  });
});

describe("the Prompt", () => {
  it("is written to stdin rather than passed as an argument", () => {
    const invocation = invocationFor({}, { session: "user_42", text: "read @notes.md" });

    assert.equal(invocation.stdin, "read @notes.md");
    // `pi` reads a leading `@word` as a file to include and refuses an argument
    // starting with `-`. Neither applies to piped stdin, and the whole Prompt is
    // rendered text an Operator's template produced (ADR-0027).
    assert.ok(!invocation.args.includes("read @notes.md"));
  });

  it("reaches stdin byte for byte, whatever it starts with", () => {
    for (const text of ["@file.md and more", "--help", "-p", "  leading space", "it's <b>&</b>"]) {
      assert.equal(invocationFor({}, { session: "user_42", text }).stdin, text);
    }
  });

  it("is refused when it is empty, rather than reaching the agent as nothing", () => {
    for (const text of ["", "   ", "\n\n"]) {
      assert.throws(
        () => invocationFor({}, { session: "user_42", text }),
        /no text/,
        `${JSON.stringify(text)} should be refused`,
      );
    }
  });
});

describe("the Session a Prompt runs in", () => {
  it("is the one the Prompt named", () => {
    const invocation = invocationFor({}, { session: "user_42", text: "hi" });

    assert.equal(invocation.session, "user_42");
    assert.equal(argumentAfter(invocation, "--session-id"), "user_42");
  });

  it("is generated from the Run when the Prompt asked for a fresh one", () => {
    const invocation = invocationFor({}, { session: null, text: "hi" });

    // Derived from the Run rather than random, so the Session file left behind can be
    // found from the Run row — which holds `null` in its own `session` column for
    // exactly this case, since the Runtime Adapter's outcome carries nothing back.
    assert.equal(invocation.session, `run_${runId}`);
    assert.equal(argumentAfter(invocation, "--session-id"), `run_${runId}`);
    assert.equal(argumentAfter(invocation, "--session-dir"), `/srv/saf/sessions/run_${runId}`);
    // Not an ephemeral Session: the file survives for debugging (ADR-0025).
    assert.ok(!invocation.args.includes("--no-session"));
  });

  it("is whatever the Handler wrote, including a name `pi` will not accept", () => {
    // Nothing here holds a copy of `pi`'s session-id grammar. `pi` checks
    // `--session-id` itself and exits 1 with its own message, which the adapter puts
    // in the failed Run's `error` beside the name in its `session` — a diagnostic
    // that cannot go stale, unlike a transcribed pattern (ADR-0024, ADR-0016).
    //
    // The Session directory follows the name wherever it goes, and the second column
    // is why that is safe without a path-segment check of ours: it is a path inside a
    // `--rm` container, so a name climbing out of the mounted Session root lands in
    // the container's own filesystem and dies with it, touching nothing on the host
    // (ADR-0025). The Gateway creates none of these.
    for (const [session, sessionDirectory] of [
      ["../escape", "/srv/saf/escape"],
      ["user:42", "/srv/saf/sessions/user:42"],
      ["a/b", "/srv/saf/sessions/a/b"],
      ["", "/srv/saf/sessions"],
    ] as const) {
      const invocation = invocationFor({}, { session, text: "hi" });

      assert.equal(invocation.session, session);
      assert.equal(argumentAfter(invocation, "--session-id"), session);
      assert.equal(argumentAfter(invocation, "--session-dir"), sessionDirectory);
    }
  });
});

describe("a configuration that cannot work", () => {
  it("is refused at resolution rather than at the first Run", () => {
    assert.throws(() => resolvePiConfiguration({ ...minimal, image: "" }), /image/);
    assert.throws(() => resolvePiConfiguration({ ...minimal, model: "" }), /model/);
    assert.throws(() => resolvePiConfiguration({ ...minimal, workspace: "relative" }), /workspace/);
    assert.throws(() => resolvePiConfiguration({ ...minimal, agentDir: "relative" }), /agentDir/);
    assert.throws(
      () => resolvePiConfiguration({ ...minimal, sessionRoot: "relative" }),
      /sessionRoot/,
    );
  });

  it("refuses a container command with nothing to run", () => {
    // Checked at resolution rather than where a process is started, so that everything
    // holding a resolved configuration has a command rather than each caller guarding.
    assert.throws(
      () => resolvePiConfiguration({ ...minimal, containerCommand: [] }),
      /containerCommand is empty/,
    );
    assert.throws(
      () => resolvePiConfiguration({ ...minimal, containerCommand: [""] }),
      /containerCommand is empty/,
    );
  });
});

describe("the Agent server URL", () => {
  it("comes back from resolution exactly as supplied, whatever it is", () => {
    // Resolution settles paths and fills defaults; it does not rewrite a string the
    // Operator handed it, because a value that comes back different from how it went in
    // is the kind of thing nobody thinks to check. Nothing judges it either: what a
    // parser catches is a typo'd scheme, which nobody makes, and not a typo'd hostname,
    // which is the mistake Operators actually make. See the field's own documentation.
    for (const agentServerUrl of [
      "http://gateway:7411",
      "http://gateway:7411/",
      "host.docker.internal:7411",
      "/signals",
      "ftp://host:21",
      "",
    ]) {
      assert.equal(
        resolvePiConfiguration({ ...minimal, agentServerUrl }).agentServerUrl,
        agentServerUrl,
        `${JSON.stringify(agentServerUrl)} should come back unchanged`,
      );
    }
  });
});
