/**
 * The adapter's plumbing: what reaches the process it starts, and what it makes of
 * what comes back.
 *
 * The container runtime here is a stub — `containerCommand` is public API and pointing
 * it at a script is what makes this fast — so every assertion is about the adapter and
 * none is about Docker. The stub is handed the argv the adapter composed and writes
 * down what it received, so "the Prompt reached stdin" and "the configuration was on
 * disk before the container started" are observed rather than assumed.
 *
 * The streams the stub replays are the **real** captured `pi --mode json` output under
 * `./fixtures/`, so the two traps that matter here — the exit code says nothing, and
 * stderr is not a verdict — are pinned against what `pi` actually emits.
 *
 * What none of it proves is that a mount resolves, that user ids match, or that a
 * Session resumes. Those need a real container, and they are `container.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { LogFields, Logger } from "../logging.ts";
import {
  type FakeContainerReport,
  type FakeContainerScript,
  fakeContainerCommand,
  fakeContainerReport,
} from "../test-support/fake-container.ts";
import { createPiAdapter, type PiRuntime } from "./adapter.ts";
import type { PiConfiguration } from "./configuration.ts";
import { instructionsFileName } from "./invocation.ts";

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
  readonly runtime: PiRuntime;
  readonly config: PiConfiguration;
  readonly lines: Logged[];
  /** Where the stub container runtime wrote down what it was given. */
  report(): FakeContainerReport;
  readonly workspace: string;
  readonly agentDir: string;
  readonly sessionRoot: string;
};

/**
 * An adapter over real directories, whose container runtime is the stub running
 * `script`.
 *
 * The three directories are real because the adapter writes into two of them before it
 * starts anything, and because the Workspace not being created by the framework is
 * itself a decision worth having a test walk into.
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
  // Only the Workspace: the other two are the framework's to create, and a test that
  // made them itself would hide that.
  await mkdir(workspace, { recursive: true });

  const reportTo = path.join(root, "report.json");
  const { lines, logger } = capturingLogger();
  const config: PiConfiguration = {
    image: "saf/pi:latest",
    model: "anthropic/claude-sonnet-4-5",
    workspace: { localPath: workspace, agentPath: "/workspace" },
    agentDir: { localPath: agentDir, agentPath: "/home/agent/.pi/agent" },
    sessionRoot: { localPath: sessionRoot, agentPath: "/sessions" },
    agentServerUrl: "http://host.docker.internal:7411",
    containerCommand: fakeContainerCommand({
      ...script,
      reportTo,
      expectExisting: [
        path.join(agentDir, instructionsFileName),
        path.join(agentDir, "settings.json"),
        path.join(agentDir, "models.json"),
        path.join(sessionRoot, "user_42"),
      ],
    }),
    ...extra,
  };

  return {
    runtime: createPiAdapter({ ...config, logger }),
    config,
    lines,
    report: () => fakeContainerReport(reportTo),
    workspace,
    agentDir,
    sessionRoot,
  };
}

describe("the pi adapter", () => {
  it("refuses a configuration that cannot work, where the Operator wrote it", async () => {
    // Not at the first Signal: a Run that fails is never retried (ADR-0017), so a
    // relative mount path would turn every Signal the deployment ever gets into a
    // permanently failed Run.
    const { config } = await adapterOn();
    assert.throws(() => createPiAdapter({ ...config, workspace: "relative" }), /workspace/);
    assert.throws(() => createPiAdapter({ ...config, image: "" }), /image/);
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

  it("starts the composed invocation, with the agent's configuration already on disk", async () => {
    const adapter = await adapterOn({ stdout: await fixture("settled-ok") });

    await adapter.runtime.run({ session: "user_42", text: "what happened?" }, runId);
    const report = adapter.report();

    // The argv the container runtime got, which is the one composeInvocation built:
    // the container's own flags, then the image, then the agent's.
    assert.deepEqual(report.args.slice(0, 2), ["run", "--rm"]);
    const image = report.args.indexOf("saf/pi:latest");
    assert.notEqual(image, -1, "the image should be in the arguments");
    assert.ok(report.args.slice(0, image).includes("--volume"));
    assert.deepEqual(report.args.slice(image + 1, image + 3), ["--mode", "json"]);
    assert.equal(report.args.at(-1), "--no-approve");
    // Compose, write, *then* start: the agent reads its configuration and its
    // instructions as it starts, and `--append-system-prompt` silently falls back to
    // using the path as the prompt text when the file is not there.
    assert.deepEqual(report.existing, {
      [path.join(adapter.agentDir, instructionsFileName)]: true,
      [path.join(adapter.agentDir, "settings.json")]: true,
      [path.join(adapter.agentDir, "models.json")]: true,
      [path.join(adapter.sessionRoot, "user_42")]: true,
    });
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
    assert.match(logged, /--volume/);
    assert.equal(started.fields.runId, runId);
    assert.equal(started.fields.session, "user_42");
  });
});

describe("verifying the mounts", () => {
  it("refuses startup naming the mount the container could not read", async () => {
    // The stub answers as a container whose Workspace source resolved to an empty
    // directory — the failure that has no error message anywhere, which is why this
    // check exists. The real thing is in container.test.ts; what is pinned here is
    // that the refusal names the mount and the value to look at.
    const adapter = await adapterOn({ stdout: "user=1000:1000\nunreadable=workspace\n" });

    await assert.rejects(adapter.runtime.verifyMounts(), (error: Error) => {
      assert.match(error.message, /workspace mount does not reach the agent's container/);
      assert.match(error.message, /could not read the token/);
      assert.match(error.message, /source/);
      assert.match(
        error.message,
        new RegExp(adapter.workspace.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      return true;
    });
  });

  it("refuses startup when the check itself could not run in the image", async () => {
    // An image with no shell, or one that cannot start at all. Reported as itself
    // rather than as a mount problem, so nobody goes looking at their volumes.
    const adapter = await adapterOn({ stderr: "sh: not found\n", exitCode: 127 });

    await assert.rejects(
      adapter.runtime.verifyMounts(),
      /mount check could not be run.*sh: not found/s,
    );
  });

  it("leaves nothing of its own behind in the Workspace", async () => {
    const adapter = await adapterOn({ stdout: "user=1000:1000\nunreadable=workspace\n" });

    await adapter.runtime.verifyMounts().catch(() => undefined);

    // The Workspace is shared with the Operator's Signal Handlers, so the tokens the
    // check writes are removed whether it passed or failed.
    assert.deepEqual(await readdir(adapter.workspace), []);
  });
});
