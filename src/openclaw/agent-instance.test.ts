import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { RunOutcome } from "../signals/runtime.ts";
import {
  addHostToGateway,
  openClawImage,
  reservePort,
  skipContainerTests,
} from "../test-support/docker.ts";
import {
  assistantMessages,
  type ModelReply,
  type ModelRequest,
  startMockModel,
} from "../test-support/mock-model.ts";
import { waitUntil } from "../test-support/wait.ts";
import { createOpenClawRuntime } from "./runtime.ts";

const run = promisify(execFile);
const skip = await skipContainerTests();

const token = "concorde-container-test-token";
const agentId = "concorde";
const insidePort = 18789;
const insideState = "/home/node/.openclaw";

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// The daemon's one configuration file: a local-mode daemon bound to every interface so the
// published port reaches it, token auth, the browser UI off, and the scripted model as its only
// provider. `skipBootstrap` keeps the daemon from writing its own AGENTS.md into the Workspace,
// and the minimal tool profile leaves the model one tool, which a text answer never calls.
function daemonConfig(modelBaseUrl: string): Record<string, unknown> {
  return {
    gateway: {
      mode: "local",
      bind: "lan",
      port: insidePort,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
    },
    models: {
      mode: "merge",
      providers: {
        mock: {
          baseUrl: modelBaseUrl,
          api: "openai-completions",
          apiKey: "not-a-real-key",
          models: [
            {
              id: "mock-model",
              name: "Mock",
              contextWindow: 128_000,
              maxTokens: 4096,
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: "mock/mock-model",
        workspace: `${insideState}/workspace`,
        skipBootstrap: true,
      },
      entries: { [agentId]: { name: "Concorde", default: true } },
    },
    tools: { profile: "minimal" },
  };
}

type Daemon = {
  readonly url: string;
  /** Runs the daemon's own CLI inside the container and returns what it printed. */
  cli(...args: string[]): Promise<string>;
};

async function startDaemon(t: TestContext, modelBaseUrl: string): Promise<Daemon> {
  const state = await mkdtemp(path.join(tmpdir(), "concorde-openclaw-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await mkdir(path.join(state, "workspace"));
  // The image runs as its own `node` user and dies at once under `--user <host uid>`, so the
  // state directory is opened to that user instead of the container being run as ours.
  await Promise.all([chmod(state, 0o777), chmod(path.join(state, "workspace"), 0o777)]);
  await writeFile(
    path.join(state, "openclaw.json"),
    `${JSON.stringify(daemonConfig(modelBaseUrl), null, 2)}\n`,
    "utf8",
  );

  const port = await reservePort();
  const name = `concorde-openclaw-${process.pid}-${port}`;
  const { stdout } = await run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    `127.0.0.1:${port}:${insidePort}`,
    addHostToGateway,
    "--env",
    `OPENCLAW_CONFIG_PATH=${insideState}/openclaw.json`,
    "--env",
    "HOME=/home/node",
    "--mount",
    `type=bind,source=${state},target=${insideState}`,
    openClawImage,
    "node",
    "openclaw.mjs",
    "gateway",
  ]);
  t.after(async () => {
    await run("docker", ["rm", "--force", name]).catch(() => undefined);
  });
  assert.ok(stdout.trim().length > 0, "docker run should report a container id");

  try {
    await waitUntil("the OpenClaw daemon answers /healthz", () => healthy(port), 60_000);
  } catch (error) {
    const logs = await run("docker", ["logs", name]).catch(() => ({ stdout: "", stderr: "" }));
    throw new Error(`${String(error)}\n${logs.stdout}\n${logs.stderr}`);
  }

  return {
    url: `ws://127.0.0.1:${port}`,
    async cli(...args) {
      const { stdout } = await run("docker", ["exec", name, "node", "openclaw.mjs", ...args]);
      return stdout;
    },
  };
}

async function healthy(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
  } catch {
    return false;
  }
}

function failure(outcome: RunOutcome): string {
  assert.equal(outcome.ok, false, `this Run should have failed; it was ${JSON.stringify(outcome)}`);
  return outcome.ok ? "" : outcome.error;
}

const firstPrompt = "This is the first Prompt.";
const secondPrompt = "This is the second Prompt.";
const thirdPrompt = "This is the third Prompt.";
const firstAnswer = "Noted: the first Prompt.";
const secondAnswer = "Noted: the second Prompt.";
const thirdAnswer = "Noted: the third Prompt, after a look at the session.";

// The daemon hands each Prompt to the model behind a timestamp, so a text is looked for inside a
// message and never equal to one.
function heard(request: ModelRequest, text: string): boolean {
  return request.texts.some((message) => message.includes(text));
}

// The third Prompt is answered in two calls: the one tool the minimal profile leaves the model,
// then the reply once its result is in the conversation. The Run's limit never lets it get there.
function scripted(request: ModelRequest): ModelReply {
  if (heard(request, thirdPrompt)) {
    return request.messages.some((message) => message.role === "tool")
      ? { say: thirdAnswer }
      : { call: { name: "session_status", arguments: {} } };
  }
  return { say: heard(request, secondPrompt) ? secondAnswer : firstAnswer };
}

// What the scripted model's one answer per Run costs, as the daemon reports it: the counts the
// model sent, the provider and model the daemon resolved, and a cost of zero from the price table.
const oneCall = {
  provider: "mock",
  model: "mock-model",
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: 0,
};

describe("a real OpenClaw daemon in a container", { skip }, () => {
  it("pairs the Gateway's device once, then runs Prompts into one Session with their Usage", async (t) => {
    const started = performance.now();
    const model = await startMockModel(scripted);
    t.after(() => model.close());
    const daemon = await startDaemon(t, model.baseUrl);
    const runtime = createOpenClawRuntime({
      url: daemon.url,
      token,
      deviceKey: generateKeyPairSync("ed25519").privateKey,
      agentId,
      logger: silent,
    });

    const refused = failure(await runtime.run({ session: "user_42", text: firstPrompt }));
    const pairing = refused.match(
      /^Session user_42: Cannot connect to the OpenClaw daemon at ws:\/\/127\.0\.0\.1:\d+: this Gateway's device key is not approved yet\. On the daemon host run `openclaw devices approve ([0-9a-f-]{36})` \(pairing request \1\), then the next Run connects$/,
    );
    assert.ok(pairing !== null, `the first Run should fail with the pairing request: ${refused}`);
    const requestId = pairing[1] ?? "";
    assert.equal(model.requests.length, 0, "a refused connection should reach no model");

    const approved = JSON.parse(await daemon.cli("devices", "approve", requestId, "--json")) as {
      requestId?: unknown;
      device?: { scopes?: unknown };
    };
    assert.equal(approved.requestId, requestId);
    assert.deepEqual(approved.device?.scopes, ["operator.read", "operator.write"]);

    const first = await runtime.run({ session: "user_42", text: firstPrompt });
    assert.deepEqual(first, { ok: true, usage: [oneCall] });
    assert.equal(model.requests.length, 1, "a Run with a text answer should be one model call");

    const second = await runtime.run({ session: "user_42", text: secondPrompt });
    assert.deepEqual(second, { ok: true, usage: [oneCall] });
    assert.equal(model.requests.length, 2);
    const continued = model.requests[1];
    assert.ok(continued !== undefined);
    assert.ok(
      heard(continued, firstPrompt) && heard(continued, firstAnswer),
      `the second Run should carry the first Run's conversation; the model saw: ${JSON.stringify(continued.texts)}`,
    );
    assert.equal(
      assistantMessages(continued),
      1,
      "the first Run's one answer should be the only assistant message before the second Prompt",
    );

    // The third Run's first call, the tool call, costs two tokens against a limit of one, so its
    // record sends the abort while the daemon is running the tool or streaming the second call.
    // The daemon ends the Run as aborted, the second call's usage never reaches the wire, and the
    // Run's Usage is the one call that finished: below the cap it was stopped for.
    const third = await runtime.run({ session: "user_42", text: thirdPrompt, usageLimit: 1 });
    assert.deepEqual(third, {
      ok: false,
      error: "Session user_42: Usage limit reached: 2 of 1 tokens",
      limited: true,
      usage: [oneCall],
    });
    const limitedCalls = model.requests.length - 2;
    assert.ok(
      limitedCalls === 1 || limitedCalls === 2,
      `the limited Run should make its first call and at most start a second; it made ${limitedCalls}`,
    );
    assert.ok(
      model.requests.slice(2).every((request) => heard(request, thirdPrompt)),
      "every call of the limited Run should carry the third Prompt",
    );
    t.diagnostic(
      `the limited Run reached the model ${limitedCalls} time(s) before the abort landed`,
    );

    t.diagnostic(`wall time ${Math.round(performance.now() - started)}ms`);
  });
});
