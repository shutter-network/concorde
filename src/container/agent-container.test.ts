/**
 * What comes out of an Agent Container: the command line, and what a Run does with it.
 *
 * The subject is `commandFor` on a **constructed Runtime**, deliberately rather than an
 * internal assembler. That is the seam an author actually has, and it is the only one
 * that can observe an Agent Implementation's own defaults: a test composing arguments
 * from the parts would have to restate those defaults in order to check them, which the
 * prototype demonstrated by producing a command line with no entry point in it and
 * nothing able to notice (ADR-0033).
 *
 * There is no `pi` here and no second Agent Implementation either. The stand-in below is
 * an agent shaped unlike `pi` on purpose — its Prompt goes on argv rather than stdin in
 * one case, and its output is plain text — because if the generic half is right then
 * neither difference needs anything added to it.
 *
 * Everything about composition is pure: no Docker, no credentials, no network, no
 * filesystem. The Runs that do start a process start the stub container runtime, which
 * is a Node script. What none of it can prove is that mounts resolve or that user ids
 * match; nothing but a real container can, and that is `src/pi/container.test.ts`.
 *
 * Assertions are on the composed argv rather than on a rendered string, and several are
 * on flag *pairs*, because that is the property a mistake breaks: the process being
 * started is the container runtime and not the agent, so a flag on the wrong side of the
 * image name reaches the wrong program.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
// From the package root, which is where an Operator meets all of these: nothing in any
// of them knows about an Agent Implementation (ADR-0026, ADR-0033).
import {
  type AgentContainer,
  type ComposedCommand,
  createAgentContainerRuntime,
  type Mount,
  type RunOutcome,
  type RunPlan,
  type RunPrompt,
} from "../index.ts";
import type { LogFields, Logger } from "../logging.ts";
import {
  type FakeContainerScript,
  fakeContainerCommand,
  fakeContainerReport,
} from "../test-support/fake-container.ts";

/** The three entries a deployment typically declares, and every test's default. */
const entries: readonly Mount[] = [
  { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
  { agentPath: "/home/agent/.pi/agent", gatewayPath: "/srv/saf/agent" },
  { agentPath: "/sessions", gatewayPath: "/srv/saf/sessions" },
];

/** The least container the Runtime accepts, plus the mounts most tests want. */
const minimal: AgentContainer = { image: "saf/agent:latest", mounts: { entries } };

const prompt: RunPrompt = { session: "user_42", text: "what happened?" };

/**
 * A stand-in Agent Implementation: the Prompt on stdin, and a Session named in failure.
 *
 * The reader closes over the Session, which is the whole reason `run` produces one per
 * Run rather than being handed a reader once at construction. It takes the Session as it
 * finds it and resolves nothing: a `RunPrompt`'s Session is a string, because the Signal
 * Worker answered a Handler's request for a fresh one long before here (ADR-0033).
 */
function agentRun({ session, text }: RunPrompt): RunPlan {
  return {
    args: ["--session-id", session, "--answer"],
    stdin: text,
    outcome: async (stdout) => {
      let said = "";
      for await (const chunk of stdout) said += Buffer.from(chunk).toString("utf8");
      return said.includes("answered")
        ? { ok: true }
        : { ok: false, error: `Session ${session} produced no answer.` };
    },
  };
}

/** The command line one Prompt composes, without starting anything. */
function commandFor(
  container: Partial<AgentContainer> = {},
  given: RunPrompt = prompt,
): ComposedCommand {
  return createAgentContainerRuntime({
    container: { ...minimal, ...container },
    run: agentRun,
  }).commandFor(given);
}

/**
 * This process's `uid:gid`, which is what the Runtime always sets `--user` to.
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
function argumentAfter(composed: ComposedCommand, flag: string): string {
  const occurrences = composed.args.filter((arg) => arg === flag);
  assert.equal(occurrences.length, 1, `${flag} should appear once in ${composed.args.join(" ")}`);
  const value = composed.args[composed.args.indexOf(flag) + 1];
  assert.ok(value !== undefined, `${flag} should be followed by a value`);
  return value;
}

/** Every value given to a flag that may repeat, in order. */
function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, at) => (arg === flag ? [args[at + 1] ?? ""] : []));
}

/** The arguments before the image name, which belong to the container runtime. */
function containerArgsOf(composed: ComposedCommand, image = minimal.image): string[] {
  const at = composed.args.indexOf(image);
  assert.notEqual(at, -1, "the image should appear in the arguments");
  return composed.args.slice(0, at);
}

/** The arguments after the image name, which belong to the agent. */
function agentArgsOf(composed: ComposedCommand, image = minimal.image): string[] {
  return composed.args.slice(composed.args.indexOf(image) + 1);
}

describe("the least an Operator can declare", () => {
  it("is an image, and everything else has a default or is absent", () => {
    const composed = createAgentContainerRuntime({
      container: { image: "saf/agent:latest" },
      run: agentRun,
    }).commandFor(prompt);

    assert.equal(composed.command, "docker");
    assert.deepEqual(composed.args, [
      "run",
      "--rm",
      "--interactive",
      "--user",
      ownUser(),
      "saf/agent:latest",
      "--session-id",
      "user_42",
      "--answer",
    ]);
  });

  it("takes no Mount Table at all, which is a deployment and not a mistake", () => {
    // An image that bakes in its own configuration and keeps no state between Runs
    // mounts nothing. An empty table says the same thing and is no longer refused: the
    // rule that forbade it was deleted rather than moved (ADR-0028).
    for (const container of [
      { image: "saf/agent" },
      { image: "saf/agent", mounts: { entries: [] } },
    ]) {
      const composed = createAgentContainerRuntime({ container, run: agentRun }).commandFor(prompt);
      assert.ok(!composed.args.includes("--mount"));
    }
  });
});

describe("what the container runtime is told", () => {
  it("is docker unless the Operator named something else", () => {
    assert.equal(commandFor().command, "docker");
    assert.equal(containerArgsOf(commandFor())[0], "run");

    const podman = commandFor({ containerCommand: ["podman"] });
    assert.equal(podman.command, "podman");
    assert.equal(podman.args[0], "run");

    // A list with nothing in it takes the default too, rather than being refused. `pi`'s
    // own configuration used to refuse it at resolution, on the argument that everything
    // holding a resolved configuration should have a command to run; there is no
    // resolution step left to refuse it in, and "no container runtime named" and "the
    // default container runtime" are the same statement (ADR-0033).
    assert.equal(commandFor({ containerCommand: [] }).command, "docker");
  });

  it("takes a container runtime that needs arguments of its own", () => {
    const composed = commandFor({ containerCommand: ["sudo", "docker"] });

    assert.equal(composed.command, "sudo");
    assert.deepEqual(composed.args.slice(0, 2), ["docker", "run"]);
  });

  it("removes the container and keeps stdin open, but gives it no TTY", () => {
    const args = containerArgsOf(commandFor());

    assert.ok(args.includes("--rm"), "one fresh container per Run leaves nothing behind");
    assert.ok(args.includes("--interactive"), "the Prompt is written to stdin");
    // A TTY would make an agent believe it is being used interactively.
    assert.ok(!args.includes("--tty") && !args.includes("-t"), "there must be no TTY");
  });

  it("runs as this process's own user, so bind-mounted files are readable both ways", () => {
    // Not configuration, and there is no field that says otherwise. Without it every
    // file the agent writes into a bind mount is owned by uid 0, and a Signal Handler
    // can read it and delete it but cannot modify it in place (ADR-0025, ADR-0028).
    assert.equal(argumentAfter(commandFor(), "--user"), ownUser());
  });

  it("joins every network it was given, and none where none was named", () => {
    // Plural with no default: the runtime's own default is the shared bridge ADR-0025
    // argues against, and no network at all breaks every Run.
    assert.deepEqual(
      valuesOf(commandFor({ networks: ["saf-agent", "saf-models"] }).args, "--network"),
      ["saf-agent", "saf-models"],
    );
    assert.ok(!commandFor().args.includes("--network"));
    assert.ok(!commandFor({ networks: [] }).args.includes("--network"));
  });

  it("passes one flag per environment variable, and none where none was named", () => {
    const composed = commandFor({ env: { ANTHROPIC_API_KEY: "sk-test", HTTPS_PROXY: "" } });

    assert.deepEqual(valuesOf(composed.args, "--env"), [
      "ANTHROPIC_API_KEY=sk-test",
      "HTTPS_PROXY=",
    ]);
    assert.ok(!commandFor().args.includes("--env"));
  });

  it("composes the whole line in one order, whatever the container declares", () => {
    // The single claim the individual assertions around this one break down: the
    // confinement flags, the mounts, the user, the networks, the environment, the entry
    // point, then the flags the framework does not model, then the image, then the
    // agent's own. Written out because the order is the part a change silently breaks.
    const composed = commandFor({
      mounts: { entries: [{ agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" }] },
      networks: ["saf-agent", "saf-models"],
      env: { ANTHROPIC_API_KEY: "sk-test", HTTPS_PROXY: "" },
      entrypoint: ["agent"],
      extraArgs: ["--memory", "2g"],
    });

    assert.deepEqual(composed.args, [
      "run",
      "--rm",
      "--interactive",
      "--mount",
      "type=bind,source=/srv/saf/workspace,target=/workspace",
      "--user",
      ownUser(),
      "--network",
      "saf-agent",
      "--network",
      "saf-models",
      "--env",
      "ANTHROPIC_API_KEY=sk-test",
      "--env",
      "HTTPS_PROXY=",
      "--entrypoint",
      "agent",
      "--memory",
      "2g",
      "saf/agent:latest",
      "--session-id",
      "user_42",
      "--answer",
    ]);
  });

  it("puts nothing of the container runtime's after the image, and nothing of the agent's before it", () => {
    const composed = commandFor({
      networks: ["saf-agent"],
      env: { A: "1" },
      extraArgs: ["--memory", "2g"],
      entrypoint: ["agent"],
    });

    for (const flag of [
      "run",
      "--rm",
      "--mount",
      "--env",
      "--network",
      "--memory",
      "--entrypoint",
    ]) {
      assert.ok(containerArgsOf(composed).includes(flag), `${flag} is the container runtime's`);
      assert.ok(!agentArgsOf(composed).includes(flag), `${flag} must not reach the agent`);
    }
    for (const flag of ["--session-id", "--answer"]) {
      assert.ok(agentArgsOf(composed).includes(flag), `${flag} is the agent's`);
      assert.ok(!containerArgsOf(composed).includes(flag), `${flag} must not reach docker`);
    }
  });
});

describe("the Mount Table on an Agent Container", () => {
  it("emits one bind mount per entry, in the order they were declared", () => {
    assert.deepEqual(valuesOf(commandFor().args, "--mount"), [
      "type=bind,source=/srv/saf/workspace,target=/workspace",
      "type=bind,source=/srv/saf/agent,target=/home/agent/.pi/agent",
      "type=bind,source=/srv/saf/sessions,target=/sessions",
    ]);
  });

  it("never emits -v, which is what makes the daemon refuse a source that is not there", () => {
    // The load-bearing subtraction of ADR-0028, and the reason a startup mount check
    // could go: `-v` invents a missing directory source as `root`, and invents a
    // *directory* even where a file was meant. `--mount` refuses both, naming the path.
    const composed = commandFor({ extraArgs: ["--memory", "2g"] });

    assert.ok(!composed.args.includes("-v"));
    assert.ok(!composed.args.includes("--volume"));
  });

  it("marks an entry read-only where it was declared so, and no other", () => {
    // A read-only *file* nested inside a read-write *directory*: the container runtime
    // sorts bind mounts by destination depth, so the file is unwritable while every
    // sibling operation in the directory around it still succeeds.
    const composed = commandFor({
      mounts: {
        entries: [
          ...entries,
          {
            agentPath: "/workspace/AGENTS.md",
            gatewayPath: "/srv/saf/AGENTS.md",
            readOnly: true,
          },
        ],
      },
    });

    const mounts = valuesOf(composed.args, "--mount");
    assert.deepEqual(mounts.slice(-1), [
      "type=bind,source=/srv/saf/AGENTS.md,target=/workspace/AGENTS.md,readonly",
    ]);
    assert.equal(mounts.filter((value) => value.includes("readonly")).length, 1);
  });

  it("quotes a value containing a comma, which is what --mount splits its fields on", () => {
    const composed = commandFor({
      mounts: { entries: [{ agentPath: "/work,space", gatewayPath: "/srv/a,b" }] },
    });

    assert.deepEqual(valuesOf(composed.args, "--mount"), [
      'type=bind,"source=/srv/a,b","target=/work,space"',
    ]);
  });

  it("leaves every source untranslated with no hostRoot, which is a Gateway on the host", () => {
    // The common case: the daemon resolves the same strings this process does, so the
    // Gateway-side path is its own host source and there is nothing to say.
    const composed = commandFor({
      mounts: { entries: [{ agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" }] },
    });

    assert.deepEqual(valuesOf(composed.args, "--mount"), [
      "type=bind,source=/srv/saf/workspace,target=/workspace",
    ]);
  });

  it("translates every source through the one hostRoot pair for a Gateway in a container", () => {
    // The daemon resolves a bind source on the *host*, and only a Gateway running on the
    // host sees the same strings it does. One pair does the whole translation: the entry
    // that *is* the root resolves to the host value whole, and one below it resolves to
    // the host value with its remainder appended.
    const composed = commandFor({
      mounts: {
        entries: [
          { agentPath: "/state", gatewayPath: "/srv/saf" },
          { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
        ],
        hostRoot: { gatewayPath: "/srv/saf", hostPath: "/host/gateway/state" },
      },
    });

    assert.deepEqual(valuesOf(composed.args, "--mount"), [
      "type=bind,source=/host/gateway/state,target=/state",
      "type=bind,source=/host/gateway/state/workspace,target=/workspace",
    ]);
  });

  it("treats a trailing slash on the root's gatewayPath as the same directory", () => {
    // An Operator writing the root with a trailing separator is not making a different
    // statement, so the entry equal to it still resolves whole and one below it still
    // composes.
    const composed = commandFor({
      mounts: {
        entries: [
          { agentPath: "/state", gatewayPath: "/srv/saf" },
          { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
        ],
        hostRoot: { gatewayPath: "/srv/saf/", hostPath: "/host/gateway/state" },
      },
    });

    assert.deepEqual(valuesOf(composed.args, "--mount"), [
      "type=bind,source=/host/gateway/state,target=/state",
      "type=bind,source=/host/gateway/state/workspace,target=/workspace",
    ]);
  });
});

describe("the entry point", () => {
  it("is the image's own unless the container named one", () => {
    assert.ok(!commandFor().args.includes("--entrypoint"));
  });

  it("goes to the container runtime, and anything after it goes after the image", () => {
    // `--entrypoint` takes exactly one word; the rest is the container's *command* and
    // sits between the image and the agent's own arguments.
    const composed = commandFor({ entrypoint: ["sh", "-c", "exec agent"] });

    assert.equal(argumentAfter(composed, "--entrypoint"), "sh");
    assert.deepEqual(agentArgsOf(composed), [
      "-c",
      "exec agent",
      "--session-id",
      "user_42",
      "--answer",
    ]);
  });

  it("is an Agent Implementation's default, and an Operator's own wins over it", () => {
    // The whole extension mechanism: defaults spread beneath the Operator's own. There
    // is no registration, no base to extend and no lifecycle to implement.
    const withDefaults = (container: AgentContainer) =>
      createAgentContainerRuntime({
        container: {
          entrypoint: ["agent"],
          ...container,
          env: { AGENT_OFFLINE: "1", ...container.env },
        },
        run: agentRun,
      });

    const asShipped = withDefaults(minimal).commandFor(prompt);
    assert.equal(argumentAfter(asShipped, "--entrypoint"), "agent");
    assert.deepEqual(valuesOf(asShipped.args, "--env"), ["AGENT_OFFLINE=1"]);

    const overridden = withDefaults({
      ...minimal,
      entrypoint: ["/usr/local/bin/agent"],
      env: { AGENT_OFFLINE: "0" },
    }).commandFor(prompt);
    assert.equal(argumentAfter(overridden, "--entrypoint"), "/usr/local/bin/agent");
    assert.deepEqual(valuesOf(overridden.args, "--env"), ["AGENT_OFFLINE=0"]);
  });
});

describe("the flags the framework does not model", () => {
  it("go last, so they also override the ones it composed", () => {
    const extra = ["--memory", "2g", "--user", "0:0", "--cap-drop", "ALL"];
    const composed = commandFor({ extraArgs: extra });

    assert.deepEqual(containerArgsOf(composed).slice(-extra.length), extra);
    // Both `--user` values are there and the Operator's is the later one, which is the
    // one the container runtime keeps — verified on Docker 29.4.0, and the documented
    // way to countermand a user that is otherwise not configuration at all.
    assert.deepEqual(valuesOf(composed.args, "--user"), [ownUser(), "0:0"]);
  });

  it("reach the container runtime and never the agent", () => {
    // Half an escape hatch, recorded as a gap rather than a decision: there is still no
    // way to pass the agent itself a flag the framework does not model (ADR-0025).
    const composed = commandFor({ extraArgs: ["--memory", "2g"] });

    assert.ok(!agentArgsOf(composed).includes("--memory"));
  });
});

describe("the loggable copy of the command line", () => {
  it("replaces every environment value, with no exceptions list", () => {
    // A list of what is safe to log would have to be right about every provider's key
    // name forever, and it would have to name an Agent Implementation's own variables
    // inside a module that must not know them (ADR-0033).
    const composed = commandFor({
      env: { ANTHROPIC_API_KEY: "sk-a-real-key", AGENT_DIR: "/home/agent/.pi/agent" },
      extraArgs: ["--env", "OPENAI_API_KEY=another-real-key", "-e", "AWS_SECRET=third"],
    });

    assert.ok(!composed.redactedArgs.join(" ").includes("sk-a-real-key"));
    assert.ok(!composed.redactedArgs.join(" ").includes("another-real-key"));
    assert.ok(!composed.redactedArgs.join(" ").includes("third"));
    assert.deepEqual(valuesOf(composed.redactedArgs, "--env"), [
      "ANTHROPIC_API_KEY=…",
      // Not a secret, and hidden anyway: that is what "no exceptions" costs, and the
      // Operator can read this one back out of their own compose file.
      "AGENT_DIR=…",
      "OPENAI_API_KEY=…",
    ]);
    assert.deepEqual(valuesOf(composed.redactedArgs, "-e"), ["AWS_SECRET=…"]);
  });

  it("leaves a variable set to nothing visibly empty", () => {
    // There is nothing in it to hide, and "set to empty" and "set to something" are
    // worth telling apart in a log.
    const composed = commandFor({ env: { HTTPS_PROXY: "", HTTP_PROXY: "http://proxy:3128" } });

    assert.deepEqual(valuesOf(composed.redactedArgs, "--env"), ["HTTPS_PROXY=", "HTTP_PROXY=…"]);
  });

  it("changes nothing else, so the two arrays stay comparable", () => {
    const composed = commandFor({ env: { A: "1" }, extraArgs: ["--memory", "2g"] });

    assert.equal(composed.redactedArgs.length, composed.args.length);
    assert.deepEqual(
      composed.redactedArgs.filter((arg) => !arg.includes("=")),
      composed.args.filter((arg) => !arg.includes("=")),
    );
  });
});

describe("a container that cannot work", () => {
  it("is refused at construction rather than at the first Run", () => {
    // A Run that fails is never retried (ADR-0017), so a deployment refused only at its
    // first Signal is one whose every Signal becomes a permanently failed Run. These
    // three are the whole of what is decidable from the value alone (ADR-0028).
    assert.throws(
      () => createAgentContainerRuntime({ container: { image: "" }, run: agentRun }),
      /no image/,
    );
    assert.throws(
      () =>
        createAgentContainerRuntime({
          container: {
            image: "saf/agent",
            mounts: { entries: [{ agentPath: "workspace", gatewayPath: "/srv" }] },
          },
          run: agentRun,
        }),
      /agentPath "workspace".*absolute/s,
    );
    assert.throws(
      () =>
        createAgentContainerRuntime({
          container: {
            image: "saf/agent",
            mounts: { entries: [{ agentPath: "/workspace", gatewayPath: "./srv" }] },
          },
          run: agentRun,
        }),
      /gatewayPath ".\/srv".*absolute/s,
    );
  });

  it("refuses an entry that falls outside the hostRoot, naming the entry's path and the root", () => {
    // A root that does not cover an entry is the mistake this shape exists to catch, and
    // catching it means refusing: falling back to identity for the stray one would start,
    // serve, and read an empty directory.
    assert.throws(
      () =>
        createAgentContainerRuntime({
          container: {
            image: "saf/agent",
            mounts: {
              entries: [
                { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
                { agentPath: "/elsewhere", gatewayPath: "/opt/other" },
              ],
              hostRoot: { gatewayPath: "/srv/saf", hostPath: "/host/gateway" },
            },
          },
          run: agentRun,
        }),
      (error: Error) => {
        assert.match(error.message, /"\/opt\/other"/);
        assert.match(error.message, /"\/srv\/saf"/);
        return true;
      },
    );
  });

  it("touches no filesystem doing it, so none of these paths need exist", () => {
    // Resolution is pure. Whether a source is really there is the daemon's answer at the
    // first Run and deliberately nobody else's (ADR-0028).
    assert.doesNotThrow(() =>
      createAgentContainerRuntime({
        container: {
          image: "saf/agent",
          mounts: { entries: [{ agentPath: "/nowhere", gatewayPath: "/definitely/not/here" }] },
        },
        run: agentRun,
      }),
    );
  });
});

describe("what the agent's function is asked", () => {
  it("is asked exactly once per Run, so an impure one cannot disagree with itself", async () => {
    // Its result is used for both the command line and the outcome reader, which is the
    // whole reason one function replaced two.
    let asked = 0;
    const runtime = createAgentContainerRuntime({
      container: { ...minimal, containerCommand: fakeContainerCommand({ stdout: "answered" }) },
      run: (given) => {
        asked += 1;
        return agentRun(given);
      },
    });

    assert.equal(asked, 0, "construction must not ask");
    assert.deepEqual(await runtime.run(prompt), { ok: true });
    assert.equal(asked, 1);

    runtime.commandFor(prompt);
    assert.equal(asked, 2, "and commandFor asks once of its own");
  });

  it("may put the Prompt on argv and write nothing to stdin", async () => {
    // The shape `pi` cannot use, and the point of the seam: an agent taking its Prompt
    // as an argument needs nothing added to the framework.
    const composed = createAgentContainerRuntime({
      container: minimal,
      run: (given) => ({
        args: ["--prompt", given.text],
        stdin: "",
        outcome: async (): Promise<RunOutcome> => ({ ok: true }),
      }),
    }).commandFor(prompt);

    assert.equal(composed.stdin, "");
    assert.deepEqual(agentArgsOf(composed), ["--prompt", "what happened?"]);
  });

  it("keeps whatever it asked for on stdin out of the command line", () => {
    const composed = commandFor({}, { session: "user_42", text: "read @notes.md" });

    assert.equal(composed.stdin, "read @notes.md");
    assert.ok(!composed.args.includes("read @notes.md"));
  });
});

describe("a Run", () => {
  const temporary: string[] = [];
  after(async () => {
    await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A Runtime whose container runtime is the stub running `script`. */
  async function runtimeOn(
    script: Omit<FakeContainerScript, "reportTo"> = {},
    container: Partial<AgentContainer> = {},
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "saf-container-"));
    temporary.push(root);
    const reportTo = path.join(root, "report.json");
    const lines: { level: string; fields: LogFields; message: string }[] = [];
    const at = (level: string) => (fields: LogFields, message: string) => {
      lines.push({ level, fields, message });
    };
    const logger: Logger = {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    };

    return {
      runtime: createAgentContainerRuntime({
        container: {
          ...minimal,
          ...container,
          containerCommand: fakeContainerCommand({ ...script, reportTo }),
          logger,
        },
        run: agentRun,
      }),
      lines,
      report: () => fakeContainerReport(reportTo),
    };
  }

  it("starts the container with exactly the command line commandFor shows, defaults included", async () => {
    // The claim `commandFor` exists to make: what a test sees and what a Run does are
    // the same argv, so an argument test never has to start a container.
    const started = await runtimeOn(
      { stdout: "answered" },
      { entrypoint: ["agent"], env: { AGENT_OFFLINE: "1" }, networks: ["saf-agent"] },
    );

    const shown = started.runtime.commandFor(prompt);
    await started.runtime.run(prompt);

    // The stub is the container runtime, so what it was handed is `args` minus the
    // stub's own leading arguments, which `command` and the rest of `containerCommand`
    // account for.
    const handed = started.report().args;
    assert.deepEqual(handed, shown.args.slice(shown.args.length - handed.length));
    assert.ok(handed.includes("--entrypoint"), "the Agent Implementation's own default is in it");
    assert.equal(started.report().stdin, "what happened?", "and the Prompt reached stdin");
  });

  it("reads its outcome from the stream and not from the exit code", async () => {
    const succeeded = await runtimeOn({ stdout: "answered", exitCode: 3 });

    assert.deepEqual(await succeeded.runtime.run(prompt), { ok: true });
    // Said out loud, because it is a combination that should not occur.
    assert.ok(succeeded.lines.some((line) => line.level === "warn"));
  });

  it("appends the exit status and stderr to a failure the stream decided on", async () => {
    // The Run's `error` column is the only place an Operator looks, so the diagnosis has
    // to be in the message rather than only in a log line.
    const failed = await runtimeOn({ stdout: "", stderr: "Unable to find image\n", exitCode: 125 });

    const outcome = await failed.runtime.run(prompt);
    assert.equal(
      outcome.ok === false && outcome.error,
      "Session user_42 produced no answer. The container exited with code 125. Its stderr said: Unable to find image",
    );
  });

  it("names the Session in that failure, which is what the per-Run reader buys", async () => {
    const failed = await runtimeOn({ stdout: "" });

    const outcome = await failed.runtime.run({ session: "user_99", text: "hi" });
    assert.match(outcome.ok === false ? outcome.error : "", /Session user_99/);
  });

  it("logs the command line with the environment's values taken out", async () => {
    const started = await runtimeOn({ stdout: "answered" }, { env: { KEY: "sk-a-real-key" } });

    await started.runtime.run(prompt);

    const line = started.lines.find((it) => it.message === "starting the agent's container");
    assert.ok(line !== undefined, "the composed command line should be logged");
    assert.equal(line.level, "debug");
    const logged = JSON.stringify(line.fields);
    assert.ok(!logged.includes("sk-a-real-key"), "an API key must not reach a log line");
    assert.match(logged, /KEY=…/);
    assert.match(logged, /--mount/);
  });

  it("says so, readably, when the container runtime is not there at all", async () => {
    const missing = createAgentContainerRuntime({
      container: { ...minimal, containerCommand: ["saf-not-a-container-runtime"] },
      run: agentRun,
    });

    await assert.rejects(missing.run(prompt), /saf-not-a-container-runtime.*could not be started/s);
  });
});
