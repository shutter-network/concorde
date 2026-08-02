/**
 * What `pi` adds to a container, which is three flags, a Prompt on stdin and a reader.
 *
 * The subject is `commandFor` on a constructed Runtime, so what is asserted is what a Run
 * would really start, an Agent Implementation's own defaults included. Everything generic
 * — the confinement flags, the mounts, the user, the networks, the redaction, the order —
 * is `src/container/agent-container.test.ts` and is deliberately not restated here: this
 * file is only the `pi`-shaped half, which is now most of what there is to say about `pi`.
 *
 * No Docker, no credentials, no network, no filesystem. `piRun` is a pure function of its
 * Prompt in every case but one — a Prompt asking for a fresh Session gets a generated
 * name, so two calls disagree — and the last case here is the one that reads that name
 * back out rather than predicting it. What none of this can prove is that the mounts
 * resolve, that the image declares the two things `pi` needs of it, or that a Session
 * resumes: nothing but a real container can, and that is `./container.test.ts`.
 *
 * Assertions are on the composed argv rather than on a rendered string, and several are
 * on flag *pairs*, because that is the property a mistake breaks: `pi` is not the process
 * being started, `docker` is, and a flag on the wrong side of the image name reaches the
 * wrong program.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentContainer, ComposedCommand } from "../container/index.ts";
import type { Prompt } from "../signals/handlers.ts";
import { createPiRuntime, piRun } from "./runtime.ts";

/** The least container a `pi` deployment declares, plus what one really mounts. */
const minimal: AgentContainer = {
  image: "saf/pi:latest",
  mounts: {
    entries: [
      { containerPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
      { containerPath: "/home/agent/.pi/agent", gatewayPath: "/srv/saf/agent" },
    ],
  },
};

const prompt: Prompt = { session: "user_42", text: "what happened?" };

/** The command line one Prompt composes, without starting anything. */
function commandFor(
  container: Partial<AgentContainer> = {},
  given: Prompt = prompt,
): ComposedCommand {
  return createPiRuntime({ ...minimal, ...container }).commandFor(given);
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
function valuesOf(composed: ComposedCommand, flag: string): string[] {
  return composed.args.flatMap((arg, at) => (arg === flag ? [composed.args[at + 1] ?? ""] : []));
}

/** The arguments after the image name, which are the only ones that reach `pi`. */
function agentArgsOf(composed: ComposedCommand): string[] {
  const at = composed.args.indexOf(minimal.image);
  assert.notEqual(at, -1, "the image should appear in the arguments");
  return composed.args.slice(at + 1);
}

describe("what the agent is told", () => {
  it("is three flags and nothing else, after the image and after the entry point", () => {
    // Written out whole, because the whole of it is now short enough to read: the flags
    // `pi` needs, and no value the Operator did not state somewhere else.
    assert.deepEqual(agentArgsOf(commandFor()), [
      "--mode",
      "json",
      "--session-id",
      "user_42",
      "--no-approve",
    ]);
  });

  it("asks for the machine-readable event stream", () => {
    assert.equal(argumentAfter(commandFor(), "--mode"), "json");
  });

  it("names no model and no provider, because the mounted settings.json carries both", () => {
    // Verified against pi@0.83.0: `settings.json` holds `defaultModel` and
    // `defaultProvider`, and `pi` falls back to them when no flag is given. The cost is
    // that nothing refuses a deployment with no usable model any more — it is a Gateway
    // that starts, serves, and fails its first Run permanently (ADR-0025, ADR-0033).
    for (const flag of ["--model", "--provider"]) {
      assert.ok(!commandFor().args.includes(flag), `${flag} should not be passed`);
    }
  });

  it("names no directory, and sets no variable saying where one is", () => {
    // All three container paths are gone. The image declares the first two — `WORKDIR`
    // and `ENV PI_CODING_AGENT_DIR` — and `pi` resolves the third under the second. A
    // path the framework does not carry is a path it cannot get wrong (ADR-0025).
    const composed = commandFor();

    for (const flag of ["--workdir", "-w", "--session-dir"]) {
      assert.ok(!composed.args.includes(flag), `${flag} should not be passed`);
    }
    assert.deepEqual(
      valuesOf(composed, "--env").filter((value) => value.startsWith("PI_CODING_AGENT_DIR=")),
      [],
      "the agent's directory is the image's to declare",
    );
  });

  it("resolves the Session with the flag that creates it if missing", () => {
    const composed = commandFor();

    assert.equal(argumentAfter(composed, "--session-id"), "user_42");
    // `--session` resolves only an existing Session and exits 1 otherwise, which would
    // fail every first Run of a named Session (ADR-0006, ADR-0025).
    for (const flag of ["--session", "--no-session", "--continue", "--resume"]) {
      assert.ok(!composed.args.includes(flag), `${flag} should not be passed`);
    }
  });

  it("is whatever the Handler wrote, including a name pi will not accept", () => {
    // Nothing here holds a copy of `pi`'s session-id grammar. `pi` checks `--session-id`
    // itself and exits 1 with its own message, which reaches the Operator through the
    // failed Run's `error` beside the name in its `session` — a diagnostic that cannot go
    // stale, unlike a transcribed pattern (ADR-0024, ADR-0016). Nothing is joined onto a
    // path either, here or anywhere, so a name that climbs is a name and not a traversal.
    for (const session of ["../escape", "user:42", "a/b", ""]) {
      assert.equal(argumentAfter(commandFor({}, { session, text: "hi" }), "--session-id"), session);
    }
  });

  it("names no file of the framework's, because the framework writes none", () => {
    // What used to be here was `--append-system-prompt <the agent directory>/…`, pointing
    // at a file rewritten before every Run. The Operator places an `AGENTS.md` in the
    // Workspace instead and `pi` finds it in its own working directory, so there is no
    // flag to pass and nothing to know (ADR-0025, ADR-0028).
    const composed = commandFor({ extraArgs: ["--memory", "2g"] });

    for (const flag of ["--append-system-prompt", "--system-prompt", "--prompt-file"]) {
      assert.ok(!composed.args.includes(flag), `${flag} should not be passed`);
    }
    // Nor by any other spelling: every argument is a flag, an image, a Session name, a
    // mount the Operator declared, or something else they wrote themselves.
    assert.ok(
      !composed.args.some((arg) => arg.endsWith(".md")),
      `no argument should name a Markdown file: ${composed.args.join(" ")}`,
    );
  });

  it("ignores project-local configuration in the Workspace", () => {
    // The Workspace is writable by the agent and `trust.json` persists between Runs, so
    // without this one Run could arrange for the next to load its settings out of the
    // Workspace — a reconfiguration that survives the Run that managed it (ADR-0003).
    assert.ok(agentArgsOf(commandFor()).includes("--no-approve"));
    assert.ok(!commandFor().args.includes("--approve"));
  });
});

describe("the defaults pi contributes to the container", () => {
  it("runs pi, so an image whose entry point is something else still works", () => {
    assert.equal(argumentAfter(commandFor(), "--entrypoint"), "pi");
  });

  it("keeps pi from reaching pi.dev, because a Run should not depend on it", () => {
    assert.deepEqual(valuesOf(commandFor(), "--env"), ["PI_OFFLINE=1"]);
  });

  it("loses both to an Operator who states them, because they are defaults and not rules", () => {
    // The whole extension mechanism: two values spread beneath the Operator's own. A
    // Gateway has no use for `pi`'s startup version check, and an Operator who asks for
    // it anyway gets it.
    const own = commandFor({
      entrypoint: ["/opt/pi/bin/pi"],
      env: { PI_OFFLINE: "0", ANTHROPIC_API_KEY: "sk-test" },
    });

    assert.equal(argumentAfter(own, "--entrypoint"), "/opt/pi/bin/pi");
    assert.deepEqual(valuesOf(own, "--env"), ["PI_OFFLINE=0", "ANTHROPIC_API_KEY=sk-test"]);
  });

  it("leaves everything else about the container to the Operator", () => {
    // `pi` contributes no field of its own at all, so the least a deployment can declare
    // is an image — and what comes out is a container line with `pi` on the end of it.
    const composed = createPiRuntime({ image: "saf/pi:latest" }).commandFor(prompt);

    assert.equal(composed.command, "docker");
    assert.ok(!composed.args.includes("--mount"));
    assert.ok(!composed.args.includes("--network"));
    assert.deepEqual(composed.args.slice(-6), [
      "saf/pi:latest",
      "--mode",
      "json",
      "--session-id",
      "user_42",
      "--no-approve",
    ]);
  });
});

describe("the Prompt", () => {
  it("is written to stdin rather than passed as an argument", () => {
    const composed = commandFor({}, { session: "user_42", text: "read @notes.md" });

    assert.equal(composed.stdin, "read @notes.md");
    // `pi` reads a leading `@word` as a file to include and refuses an argument starting
    // with `-`. Neither applies to piped stdin, and the whole Prompt is rendered text an
    // Operator's template produced (ADR-0027).
    assert.ok(!composed.args.includes("read @notes.md"));
  });

  it("reaches stdin byte for byte, whatever it starts with", () => {
    for (const text of ["@file.md and more", "--help", "-p", "  leading space", "it's <b>&</b>"]) {
      const composed = commandFor({}, { session: "user_42", text });
      assert.equal(composed.stdin, text);
      assert.ok(!composed.args.includes(text), `${JSON.stringify(text)} must not reach argv`);
    }
  });

  it("is refused when it is empty, rather than reaching the agent as nothing", () => {
    for (const text of ["", "   ", "\n\n"]) {
      assert.throws(
        () => commandFor({}, { session: "user_42", text }),
        /no text/,
        `${JSON.stringify(text)} should be refused`,
      );
    }
  });
});

describe("the outcome reader one Run gets", () => {
  /** A stream that says nothing at all, which is the shortest failure there is. */
  const silence = (): AsyncIterable<Uint8Array> => (async function* () {})();

  it("names that Run's Session in a failure, which is why it is made per Run", async () => {
    // The Run's `error` column is the only thing an Operator has to go on, and a message
    // that named nothing left them with no transcript to open. A reader supplied once at
    // construction could not have said this (ADR-0025, ADR-0033).
    const outcome = await piRun({ session: "user_99", text: "hi" }).outcome(silence());

    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.error, /^Session user_99 produced no output/);
  });

  it("names a generated Session where the Prompt asked for a fresh one", async () => {
    // Not an ephemeral Session: the transcript survives for debugging (ADR-0025). The
    // name is generated here only until the Signal Worker names it from the Run row,
    // which is what makes it traceable back to one (ADR-0033).
    const plan = piRun({ session: null, text: "hi" });
    const named = plan.args[plan.args.indexOf("--session-id") + 1] ?? "";

    assert.match(named, /^run_/);
    const outcome = await plan.outcome(silence());
    assert.equal(outcome.ok, false);
    assert.ok((outcome.ok ? "" : outcome.error).startsWith(`Session ${named} `));
  });
});
