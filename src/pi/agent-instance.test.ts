import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { openDb } from "../db/index.ts";
import { createBareGateway, serverComponent } from "../gateway/components.ts";
import type { SignalHandler } from "../signals/handlers.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { runs } from "../signals/schema/index.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import {
  addHostToGateway,
  buildPiImage,
  hostFromContainer,
  reservePort,
  skipContainerTests,
} from "../test-support/docker.ts";
import {
  assistantMessages,
  type MockModel,
  type ModelReply,
  type ModelRequest,
  startMockModel,
} from "../test-support/mock-model.ts";
import { waitUntil } from "../test-support/wait.ts";
import { createPiRuntime } from "./runtime.ts";

const run = promisify(execFile);
const skip = await skipContainerTests();

type Ask = { readonly session: string | null; readonly text: string };

const asking: SignalHandler<Ask> = {
  handle: (signal) => [{ session: signal.payload.session, text: signal.payload.text }],
};

const handlerNote = "handler-note.txt";
const agentNote = "agent-note.txt";
const agentsFileName = "AGENTS.md";

const insideWorkspace = "/workspace";
const insideAgentDir = "/home/agent/.pi/agent";
const insideSessions = "/sessions";

let image: string;
let database: TestDatabase;

before(async () => {
  if (skip !== false) return;
  image = await buildPiImage();
  database = await createTestDatabase("pi_agent_instance");
});

after(async () => {
  if (skip !== false) return;
  await database.drop();
});

type Rig = {
  readonly model: MockModel;
  readonly agentServerUrl: string;
  readonly workspace: string;
  sessions(): Promise<string[]>;
  ask(payload: Ask): Promise<string>;
  runsOf(
    signalId: string,
  ): Promise<{ id: string; session: string | null; state: string; error: string | null }[]>;
};

type Paths = {
  readonly workspace: string;
  readonly agentDir: string;
  readonly sessions: string;
};

async function temporaryPaths(t: TestContext): Promise<Paths> {
  const root = await mkdtemp(path.join(tmpdir(), "concorde-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    workspace: path.join(root, "workspace"),
    agentDir: path.join(root, "agent"),
    sessions: path.join(root, "sessions"),
  };
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })));
  return paths;
}

function mockProvider(baseUrl: string): Record<string, unknown> {
  return {
    providers: {
      mock: {
        baseUrl,
        api: "openai-completions",
        apiKey: "not-a-real-key",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "mock-model", name: "Mock", contextWindow: 128_000, maxTokens: 4096 }],
      },
    },
  };
}

async function placeTheOperatorsFiles(
  paths: Paths,
  modelBaseUrl: string,
  agentServerUrl: string,
): Promise<void> {
  await writeFile(
    path.join(paths.agentDir, "models.json"),
    `${JSON.stringify(mockProvider(modelBaseUrl), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(paths.agentDir, "settings.json"),
    `${JSON.stringify({ defaultModel: "mock-model", defaultProvider: "mock" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(paths.workspace, agentsFileName),
    [
      "# You are the shared agent of a test",
      "",
      "The Gateway exposes an HTTP API to you and to nothing else, at",
      `\`${agentServerUrl}\`. Reach it with \`curl\` from your shell tool. It takes no`,
      'credential. `GET /signals?limit=` answers `{ "signals": [...] }`, newest first.',
      "",
    ].join("\n"),
    "utf8",
  );
}

async function startAgentInstance(t: TestContext, paths: Paths, port: number): Promise<void> {
  const name = `concorde-agent-${process.pid}-${port}`;
  const { stdout } = await run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    `127.0.0.1:${port}:4000`,
    addHostToGateway,
    "--user",
    `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    "--env",
    "PI_OFFLINE=1",
    "--mount",
    `type=bind,source=${paths.workspace},target=${insideWorkspace}`,
    "--mount",
    `type=bind,source=${paths.agentDir},target=${insideAgentDir}`,
    "--mount",
    `type=bind,source=${paths.sessions},target=${insideSessions}`,
    image,
    "socat",
    "TCP-LISTEN:4000,reuseaddr,fork",
    "EXEC:pi --mode rpc --no-approve",
  ]);
  t.after(async () => {
    await run("docker", ["rm", "--force", name]).catch(() => undefined);
  });
  assert.ok(stdout.trim().length > 0, "docker run should report a container id");

  await waitUntil("the Agent Instance is accepting connections", () => reachable(port), 60_000);
}

async function reachable(port: number): Promise<boolean> {
  return new Promise((answered) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      answered(true);
    });
    socket.once("error", () => {
      socket.destroy();
      answered(false);
    });
  });
}

async function withGateway(
  t: TestContext,
  reply: (request: ModelRequest, at: number) => ModelReply,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  const paths = await temporaryPaths(t);

  const gatewayPort = await reservePort();
  const instancePort = await reservePort();
  const agentServerUrl = `http://${hostFromContainer}:${gatewayPort}`;
  const model = await startMockModel(reply);

  await placeTheOperatorsFiles(paths, model.baseUrl, agentServerUrl);
  await startAgentInstance(t, paths, instancePort);

  const agentServer = serverComponent(Fastify(), { port: gatewayPort, host: "0.0.0.0" });
  const runtime = createPiRuntime({
    host: "127.0.0.1",
    port: instancePort,
    sessionsDir: insideSessions,
  });

  const db = openDb(database.url);
  const worker = createSignalWorker({ db, runtime, handlers: { ask: asking }, agentServer });
  await applySchema(db, signalsSchema);

  const handle = db.handle({ runs });
  const rig: Rig = {
    model,
    agentServerUrl,
    workspace: paths.workspace,
    async sessions() {
      return (await readdir(paths.sessions)).sort();
    },
    async ask(payload) {
      const id = await db.tx((tx) => worker.emit(tx, { kind: "ask", payload }));
      await waitUntil(
        `the Signal ${id} has been processed`,
        async () => {
          const [row] = await handle.select().from(runs).where(eq(runs.signalId, id));
          return row !== undefined && row.state !== "pending" && row.state !== "running";
        },
        180_000,
      );
      return id;
    },
    async runsOf(signalId) {
      const rows = await handle.select().from(runs).where(eq(runs.signalId, signalId));
      return rows.map((row) => ({
        id: row.id,
        session: row.session,
        state: row.state,
        error: row.error,
      }));
    },
  };

  const gateway = createBareGateway({ db, agentServer, worker });
  await gateway.start();
  try {
    await body(rig);
  } finally {
    await gateway.stop();
    await model.close();
  }
}

function readsAndWrites(request: ModelRequest): ModelReply {
  switch (assistantMessages(request)) {
    case 0:
      return { bash: `curl -s "${agentServerIn(request)}/signals?limit=5"` };
    case 1:
      return {
        bash: `cat ${insideWorkspace}/${handlerNote} && printf '%s' 'written by the agent' > ${insideWorkspace}/${agentNote}`,
      };
    default:
      return { say: "I read the Signals and left a note." };
  }
}

function agentServerIn(request: ModelRequest): string {
  const found = request.system.match(new RegExp(`http://${hostFromContainer}:\\d+`));
  assert.ok(
    found !== null,
    `the agent was never told where the Gateway is; its system prompt ends: ${request.system.slice(-400)}`,
  );
  return found[0];
}

const doomed = "This Prompt cannot work.";

function scripted(request: ModelRequest): ModelReply {
  if (request.texts.some((text) => text.includes(doomed))) {
    return { refuse: { status: 400, message: "this deployment has no model" } };
  }
  return readsAndWrites(request);
}

describe("a real pi behind a real listener", { skip }, () => {
  it("creates a Session at the path it is given, resumes it, and shares the Workspace", async (t) => {
    await withGateway(t, scripted, async (rig) => {
      assert.deepEqual(await rig.sessions(), []);

      await writeFile(path.join(rig.workspace, handlerNote), "written by a Signal Handler", "utf8");

      const first = await rig.ask({ session: "user_42", text: "This is the first Prompt." });
      const second = await rig.ask({ session: "user_42", text: "This is the second Prompt." });
      const fresh = await rig.ask({ session: null, text: "This is a one-off Prompt." });

      for (const [label, signalId] of [
        ["the first", first],
        ["the second", second],
      ] as const) {
        const rows = await rig.runsOf(signalId);
        assert.deepEqual(
          rows.map(({ session, state, error }) => ({ session, state, error })),
          [{ session: "user_42", state: "done", error: null }],
          `${label} Signal should have one Run, done`,
        );
      }

      const [freshRun] = await rig.runsOf(fresh);
      assert.ok(freshRun !== undefined, "the fresh Signal should have one Run");
      assert.deepEqual(
        { session: freshRun.session, state: freshRun.state, error: freshRun.error },
        { session: `run_${freshRun.id}`, state: "done", error: null },
      );

      assert.deepEqual(await rig.sessions(), [`run_${freshRun.id}.jsonl`, "user_42.jsonl"].sort());

      const resumed = rig.model.requests.find(
        (request) =>
          request.texts.includes("This is the second Prompt.") &&
          request.texts.includes("This is the first Prompt."),
      );
      assert.ok(resumed !== undefined, "the second Run should carry the first Run's conversation");

      const toolResults = rig.model.requests.flatMap((request) => request.texts);
      for (const asked of [
        "This is the first Prompt.",
        "This is the second Prompt.",
        "This is a one-off Prompt.",
      ]) {
        assert.ok(
          rig.model.requests.some(
            (request) =>
              request.texts.includes(asked) &&
              request.texts.some((text) => text.includes('"signals"')),
          ),
          `the Run of ${JSON.stringify(asked)} should have read the Signals over HTTP`,
        );
      }
      assert.ok(
        toolResults.some(
          (text) => text.includes('"signals"') && text.includes("This is the first Prompt."),
        ),
        "a Run should have read a prior Signal's payload back",
      );

      const system = rig.model.requests[0]?.system ?? "";
      const placed = await readFile(path.join(rig.workspace, agentsFileName), "utf8");
      assert.ok(
        system.includes(placed.trim()),
        `the file the Operator placed should be in the system prompt verbatim: ${system.slice(-600)}`,
      );
      assert.ok(system.includes(rig.agentServerUrl));

      assert.ok(
        toolResults.some((text) => text.includes("written by a Signal Handler")),
        "the agent should have read the file a Signal Handler left it",
      );
      const written = path.join(rig.workspace, agentNote);
      assert.equal(await readFile(written, "utf8"), "written by the agent");

      const [failed] = await rig.runsOf(await rig.ask({ session: "user_7", text: doomed }));
      assert.equal(failed?.state, "failed");
      assert.match(failed?.error ?? "", /this deployment has no model/);
      assert.match(failed?.error ?? "", /stopReason/);

      const rejectedName = "../escape";
      const [rejected] = await rig.runsOf(
        await rig.ask({ session: rejectedName, text: "This name is not one pi accepts." }),
      );
      assert.equal(rejected?.state, "failed");
      assert.equal(rejected?.session, rejectedName);
      assert.match(rejected?.error ?? "", /Invalid session name/);
      assert.deepEqual(
        await rig.sessions(),
        [`run_${freshRun.id}.jsonl`, "user_42.jsonl", "user_7.jsonl"].sort(),
        "a Session name the framework refused should have left nothing behind",
      );
    });
  });
});
