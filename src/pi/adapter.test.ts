/**
 * The adapter's plumbing: what reaches the process it starts, and what it makes of
 * what comes back.
 *
 * The container runtime here is a stub — `containerCommand` is public API and pointing
 * it at a script is what makes this fast — so every assertion is about the adapter and
 * none is about Docker. The stub is handed the argv the adapter composed and writes
 * down what it received, so "the Prompt reached stdin" is observed rather than assumed.
 *
 * The directories the Mount Table names here **do not exist**, and that is the point:
 * the framework writes no files and opens none, so a Run composes and starts with
 * nothing of the Operator's on disk. Whether the mounts really resolve is the container
 * runtime's to say at the first Run, and there is no container runtime here.
 *
 * The streams the stub replays are the **real** captured `pi --mode json` output under
 * `./fixtures/`, so the two traps that matter here — the exit code says nothing, and
 * stderr is not a verdict — are pinned against what `pi` actually emits.
 *
 * What none of it proves is that a mount resolves, that user ids match, or that a
 * Session resumes. Those need a real container, and they are `container.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { LogFields, Logger } from "../logging.ts";
import type { Runtime } from "../signals/runtime.ts";
import {
  type FakeContainerReport,
  type FakeContainerScript,
  fakeContainerCommand,
  fakeContainerReport,
} from "../test-support/fake-container.ts";
import { createPiAdapter } from "./adapter.ts";
import type { PiConfiguration } from "./configuration.ts";

const runId = "6f1a3c7e-0000-4000-8000-000000000001";

/** The stderr `pi` really writes the first time a Session is used, and exits 0 with. */
const sessionWarning =
  "Warning: No project session found with id 'user_42'; creating a new session with that id.\n";

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** One line a logger was given. */
type Logged = { readonly level: string; readonly fields: LogFields; readonly message: string };

function capturingLogger(): { readonly lines: Logged[]; readonly logger: Logger } {
  const lines: Logged[] = [];
  const at = (level: string) => (fields: LogFields, message: string) => {
    lines.push({ level, fields, message });
  };
  return {
    lines,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  };
}

/** A captured `pi --mode json` stream, as text. */
async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8");
}

type Adapter = {
  readonly runtime: Runtime;
  readonly config: PiConfiguration;
  readonly lines: Logged[];
  /** Where the stub container runtime wrote down what it was given. */
  report(): FakeContainerReport;
  /** The three mount sources, in the order they were declared. None of them exists. */
  readonly sources: readonly string[];
  readonly sessionRoot: string;
};

/**
 * An adapter whose container runtime is the stub running `script`.
 *
 * Its three mount sources are paths under a temporary root and **none of them is
 * created**: the framework opens no file and creates no directory, so a Run that
 * composes and starts is one that needed nothing of the Operator's to be there yet. The
 * temporary root itself is real only because the stub writes its report into it.
 */
async function adapterOn(
  script: Omit<FakeContainerScript, "reportTo"> = {},
  extra: Partial<PiConfiguration> = {},
): Promise<Adapter> {
  const root = await mkdtemp(path.join(tmpdir(), "saf-adapter-"));
  temporary.push(root);
  const workspace = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionRoot = path.join(root, "sessions");

  const reportTo = path.join(root, "report.json");
  const { lines, logger } = capturingLogger();
  const config: PiConfiguration = {
    image: "saf/pi:latest",
    model: "anthropic/claude-sonnet-4-5",
    workspacePath: "/workspace",
    agentDirPath: "/home/agent/.pi/agent",
    sessionRootPath: "/sessions",
    mounts: {
      entries: [
        { containerPath: "/workspace", gatewayPath: workspace },
        { containerPath: "/home/agent/.pi/agent", gatewayPath: agentDir },
        { containerPath: "/sessions", gatewayPath: sessionRoot },
      ],
    },
    containerCommand: fakeContainerCommand({ ...script, reportTo }),
    ...extra,
  };

  return {
    runtime: createPiAdapter({ ...config, logger }),
    config,
    lines,
    report: () => fakeContainerReport(reportTo),
    sources: [workspace, agentDir, sessionRoot],
    sessionRoot,
  };
}

describe("the pi adapter", () => {
  it("refuses a configuration that cannot work, where the Operator wrote it", async () => {
    // Not at the first Signal: a Run that fails is never retried (ADR-0017), so a
    // relative container path would turn every Signal the deployment ever gets into a
    // permanently failed Run.
    const { config } = await adapterOn();
    assert.throws(() => createPiAdapter({ ...config, workspacePath: "relative" }), /workspacePath/);
    assert.throws(() => createPiAdapter({ ...config, image: "" }), /image/);
    // Including a Mount Table that cannot be resolved: the adapter resolves it at
    // construction precisely so this is not discovered by a container (ADR-0028). An
    // empty table is not one of those: an image that carries its own configuration and
    // keeps nothing between Runs is a deployment, and the rule forbidding it is gone.
    assert.doesNotThrow(() => createPiAdapter({ ...config, mounts: { entries: [] } }));
    assert.throws(
      () =>
        createPiAdapter({
          ...config,
          mounts: { entries: [{ containerPath: "/workspace", gatewayPath: "relative" }] },
        }),
      /gatewayPath.*absolute/s,
    );
  });

  it("writes the Prompt to the container's stdin and closes it", async () => {
    const adapter = await adapterOn({ stdout: await fixture("settled-ok") });

    const outcome = await adapter.runtime.run(
      { session: "user_42", text: "read @notes.md" },
      runId,
    );

    assert.deepEqual(outcome, { ok: true });
    // Byte for byte, and nothing else: the stub reads stdin to the end before it
    // answers, so a Prompt that was never written or a stream never closed would hang
    // rather than pass.
    assert.equal(adapter.report().stdin, "read @notes.md");
  });

  it("starts the composed invocation, and touches no filesystem on the way", async () => {
    const adapter = await adapterOn({ stdout: await fixture("settled-ok") });

    await adapter.runtime.run({ session: "user_42", text: "what happened?" }, runId);
    const report = adapter.report();

    // The argv the container runtime got, which is the one composeInvocation built:
    // the container's own flags, then the image, then the agent's.
    assert.deepEqual(report.args.slice(0, 2), ["run", "--rm"]);
    const image = report.args.indexOf("saf/pi:latest");
    assert.notEqual(image, -1, "the image should be in the arguments");
    assert.ok(report.args.slice(0, image).includes("--mount"));
    assert.deepEqual(report.args.slice(image + 1, image + 3), ["--mode", "json"]);
    assert.equal(report.args.at(-1), "--no-approve");
    // Compose, start, interpret, and no fourth step: not one of the three mount sources
    // exists, and the Run got as far as reading an outcome anyway. Nothing was created
    // on the way either — the Session's own directory is `pi`'s to make inside the
    // container, and the directories around it are the Operator's (ADR-0025, ADR-0028).
    for (const source of [...adapter.sources, path.join(adapter.sessionRoot, "user_42")]) {
      await assert.rejects(() => stat(source), /ENOENT/, `${source} should not have been created`);
    }
  });

  it("reads the outcome from the stream and not from the exit code", async () => {
    // Trap 1, at the seam that has an exit code in its hand: `--mode json` exits 0 on
    // model and API errors, and only `mode: "text"` sets a non-zero status.
    const failed = await adapterOn({
      stdout: await fixture("model-error-exit-zero"),
      exitCode: 0,
    });
    const failure = await failed.runtime.run({ session: "user_42", text: "hi" }, runId);
    assert.equal(failure.ok, false);
    assert.match(failure.ok ? "" : failure.error, /stopReason "error"/);

    const succeeded = await adapterOn({ stdout: await fixture("settled-ok"), exitCode: 3 });
    assert.deepEqual(
      await succeeded.runtime.run({ session: "user_42", text: "hi" }, runId),
      { ok: true },
      "the stream said the agent answered, and the stream is what decides",
    );
  });

  it("does not read stderr as failure, because the first Run of a Session warns there", async () => {
    const adapter = await adapterOn({
      stdout: await fixture("settled-ok"),
      stderr: sessionWarning,
    });

    assert.deepEqual(await adapter.runtime.run({ session: "user_42", text: "hi" }, runId), {
      ok: true,
    });
  });

  it("puts the exit code and stderr in a failure the stream had already decided", async () => {
    // What an Operator sees when the image is not there: the stream says nothing
    // because nothing ran, and the reason is on stderr. The Run's `error` column is
    // the only place they will look.
    const adapter = await adapterOn({
      stderr: "Unable to find image 'saf/pi:latest' locally\n",
      exitCode: 125,
    });

    const outcome = await adapter.runtime.run({ session: "user_42", text: "hi" }, runId);

    assert.equal(outcome.ok, false);
    const error = outcome.ok ? "" : outcome.error;
    assert.match(error, /produced no output at all/);
    assert.match(error, /exited with code 125/);
    assert.match(error, /Unable to find image/);
  });

  it("says which command it could not start when the container runtime is not there", async () => {
    const adapter = await adapterOn({}, { containerCommand: ["saf-not-a-container-runtime"] });

    await assert.rejects(
      adapter.runtime.run({ session: "user_42", text: "hi" }, runId),
      /saf-not-a-container-runtime.*could not be started/s,
    );
  });

  it("logs the composed invocation at debug, with the environment's values taken out", async () => {
    // Story 50: diagnosing a mount or network problem should not need the framework's
    // source. The invocation carries `env`, which is where a provider API key goes.
    const adapter = await adapterOn(
      { stdout: await fixture("settled-ok") },
      { env: { ANTHROPIC_API_KEY: "sk-a-real-key" } },
    );

    await adapter.runtime.run({ session: "user_42", text: "hi" }, runId);

    const started = adapter.lines.find((line) => line.message === "starting the agent's container");
    assert.ok(started !== undefined, "the composed invocation should be logged");
    assert.equal(started.level, "debug");
    const logged = JSON.stringify(started.fields);
    assert.ok(!logged.includes("sk-a-real-key"), "an API key must not reach a log line");
    assert.match(logged, /ANTHROPIC_API_KEY=…/);
    // The two values a mount problem is diagnosed from are both still there.
    assert.match(logged, /PI_CODING_AGENT_DIR=\/home\/agent\/\.pi\/agent/);
    assert.match(logged, /--mount/);
    assert.equal(started.fields.runId, runId);
    assert.equal(started.fields.session, "user_42");
  });
});
