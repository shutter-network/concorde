/**
 * A real `pi` behind a real listener, driven by a real Signal Worker: the one opt-in
 * end-to-end test.
 *
 * One test path, deliberately. It is slow and it needs Docker and the network, so it earns
 * its place by proving the things nothing faster can — and, since the Gateway stopped
 * starting the agent, every one of them is a claim about **`pi`** rather than about us:
 *
 *  - **`switch_session` is create-or-resume.** A path that does not exist becomes a fresh
 *    Session kept at that path. This is **undocumented behaviour** and the whole design
 *    rests on it: without it a Signal Handler could only ever prompt into whatever Session
 *    the instance happened to be in. A fake scripted to do it would pin our reading of the
 *    protocol and nothing else, which is why this file exists at all.
 *  - **`get_state` answers with the path it was switched to**, which is the only thing that
 *    tells "it created the Session I named" apart from "it did something and said it went
 *    fine". Every Run makes that check, so a `pi` that stopped agreeing fails here loudly
 *    rather than delivering Prompts into the wrong Session quietly.
 *  - **a named Session resumes across two Runs and two connections**, which is a claim
 *    about a transcript on disk being found and parsed by a second `pi` process.
 *  - **the Agent Instance is reachable over one TCP connection per Run**, through `socat`
 *    with `fork`, which is the arrangement every example ships.
 *  - **a model error settles like an answer.** The agent reports it inside an assistant
 *    message and nothing else says a word, which is why an outcome is read from
 *    `stopReason` and never from anything else.
 *  - **`pi` discovers an `AGENTS.md` the Operator placed in the Workspace**, with no flag
 *    from the framework and nothing of the framework's in the file, and the agent
 *    **reaches the Agent server** at the address that file names — over HTTP from inside
 *    its container, with `curl` from its own shell tool and no credential.
 *
 * What is real here and what is not, exactly: the container, the `pi` binary in it, the
 * listener, the socket, the Session files, the files the Operator placed, the JSON lines in
 * both directions, the Agent server, the Signal Worker, and PostgreSQL. **Only the model is
 * stubbed** — a scripted OpenAI-compatible server on this host, which is what makes the
 * test deterministic and what makes it need no provider credentials. The consequence,
 * stated rather than hidden: this proves the framework's half of a Run end to end, and says
 * nothing about whether a real model would choose to call the Agent server unprompted.
 *
 * This test is also the Operator, and doing that job is most of what it sets up: it creates
 * the three directories, writes `models.json` and `settings.json` into the agent's own
 * directory, writes the `AGENTS.md` that carries the Agent server's address, and starts the
 * container. **The framework writes none of it and has never read any of it.** It is also
 * the Operator in the one way that matters most here: `--no-approve` is passed on the
 * container's command line, where it now belongs, and `PI_OFFLINE` is an environment
 * variable of the Operator's rather than a default of ours.
 *
 * Note where the scripted model still learns things for itself: the address it tells the
 * agent to `curl` is read **out of the system prompt it was given**, which is where `pi`
 * puts a context file it discovered. So a Run whose `AGENTS.md` did not reach the container
 * has no URL to find and fails here rather than passing quietly.
 *
 * Skipped unless `CONCORDE_CONTAINER_TESTS` is set — see `../test-support/docker.ts` for why.
 */

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

/** What a Signal carries: the Session to run in, and what to say. */
type Ask = { readonly session: string | null; readonly text: string };

const asking: SignalHandler<Ask> = {
  handle: (signal) => [{ session: signal.payload.session, text: signal.payload.text }],
};

/** The file a Signal Handler leaves in the Workspace for the agent to read. */
const handlerNote = "handler-note.txt";
/** The file the agent writes in the Workspace for the Gateway to read. */
const agentNote = "agent-note.txt";
/**
 * What `pi` looks for in its working directory and its ancestors, and the name an
 * Operator's instructions file therefore takes inside the container.
 *
 * The framework knows nothing about it: no flag names it, and this constant exists in a
 * test rather than in `src/pi/` because `pi`'s own discovery is the whole mechanism.
 */
const agentsFileName = "AGENTS.md";

/**
 * The three paths inside the Agent Instance, which are the Operator's to choose and the
 * Operator's to keep consistent with what the Gateway is told.
 *
 * Only the third is named twice — once in the container's mounts and once in the Runtime's
 * `sessionsDir` — and nothing checks that the two agree, because nothing can: one is
 * resolved by the container runtime's daemon and the other by `pi`.
 */
const insideWorkspace = "/workspace";
const insideAgentDir = "/home/agent/.pi/agent";
const insideSessions = "/sessions";

let image: string;
/**
 * The throwaway database, and the Db that will drop it — which is deliberately **not** the
 * Gateway's. The Gateway's Db is a Component, so the record stops it, and a pool cannot be
 * ended twice.
 */
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

/** Everything one test needs standing up around the Runtime. */
type Rig = {
  readonly model: MockModel;
  /** Where the Operator's own instructions file told the agent to reach the Gateway. */
  readonly agentServerUrl: string;
  readonly workspace: string;
  /** The Session files the Agent Instance has written, sorted, as this host sees them. */
  sessions(): Promise<string[]>;
  /** Emits a Signal and resolves when its Runs have finished. */
  ask(payload: Ask): Promise<string>;
  /**
   * Every Run recorded for a Signal.
   *
   * The id comes back because a fresh Session is named after it, so it is what a test
   * checks the name against rather than predicting one.
   */
  runsOf(
    signalId: string,
  ): Promise<{ id: string; session: string | null; state: string; error: string | null }[]>;
};

/** What the Operator creates on their own disk and mounts into the Agent Instance. */
type Paths = {
  readonly workspace: string;
  readonly agentDir: string;
  readonly sessions: string;
};

/** Three fresh directories under a temporary root, cleaned up with the test. */
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

/** The scripted model, as `models.json` describes a provider to `pi`. */
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

/**
 * The two files an Operator places in the agent's own directory, and the one they place in
 * the Workspace.
 *
 * The framework writes none of them and reads none of them. `settings.json` is where the
 * model and the provider live: `pi` falls back to `defaultModel` and `defaultProvider` when
 * no flag names either, and no flag does, so this file is the whole of how a Run knows what
 * to talk to.
 */
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

/**
 * The Agent Instance itself, started the way an example's compose file starts it.
 *
 * One `socat` listening, one `pi` per connection, and `--no-approve` on the command line
 * where it now belongs: it is the flag that stops a Run arranging for the next one to load
 * configuration out of the writable Workspace, and the framework can no longer fasten it.
 * No healthcheck, for the reason an example has none — with `fork`, a probe on an interval
 * boots and discards a `pi` continuously.
 */
async function startAgentInstance(t: TestContext, paths: Paths, port: number): Promise<void> {
  const name = `concorde-agent-${process.pid}-${port}`;
  const { stdout } = await run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    // Published on loopback only: this is the Operator's own network in a compose file, and
    // `pi`'s RPC has no authentication of any kind.
    "--publish",
    `127.0.0.1:${port}:4000`,
    // So the agent can reach the Agent server on this host, which is what its `AGENTS.md`
    // tells it to do.
    addHostToGateway,
    // The id the files below belong to, since the image knows nothing about any user and
    // what the agent writes has to be readable and removable by this process afterwards.
    "--user",
    `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    // The agent's environment, whole, and none of it the framework's. `PI_OFFLINE` was a
    // default the Runtime contributed when the Runtime started containers; it is a line in
    // the Operator's compose file now.
    "--env",
    "PI_OFFLINE=1",
    "--mount",
    `type=bind,source=${paths.workspace},target=${insideWorkspace}`,
    "--mount",
    `type=bind,source=${paths.agentDir},target=${insideAgentDir}`,
    "--mount",
    `type=bind,source=${paths.sessions},target=${insideSessions}`,
    image,
    // No commas anywhere in what follows: comma is `socat`'s own option separator. And no
    // `stderr` option either, which would merge `pi`'s diagnostics into the record stream.
    "socat",
    "TCP-LISTEN:4000,reuseaddr,fork",
    "EXEC:pi --mode rpc --no-approve",
  ]);
  t.after(async () => {
    await run("docker", ["rm", "--force", name]).catch(() => undefined);
  });
  assert.ok(stdout.trim().length > 0, "docker run should report a container id");

  // The framework never waits for the Agent Instance, so this wait is the test's: an
  // unreachable instance is an ordinary failed Run, and a suite whose container had not
  // finished starting would be asserting that rather than what it meant to.
  await waitUntil("the Agent Instance is accepting connections", () => reachable(port), 60_000);
}

/** Whether something is listening, asked the way the Runtime asks it. */
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

/**
 * Stands up a whole Gateway around one `pi` Runtime and hands it to `body`.
 *
 * One end-to-end path, so this is used once: a Signal Worker, a real database, the Agent
 * server with the Worker's routes on it, the scripted model, and an Agent Instance in a
 * container. Constructed by hand through `createBareGateway`, because what this file needs
 * is a subset of the infrastructure and none of the parts `createGateway` hands the Operator
 * through `extend`. Nothing here is about the assembly; the subject is a real `pi`.
 */
async function withGateway(
  t: TestContext,
  reply: (request: ModelRequest, at: number) => ModelReply,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  const paths = await temporaryPaths(t);

  // Both ports before anything listens: the agent is told where the Agent server is in a
  // file written now, and the Gateway is told where the Agent Instance is before the
  // container exists.
  const gatewayPort = await reservePort();
  const instancePort = await reservePort();
  const agentServerUrl = `http://${hostFromContainer}:${gatewayPort}`;
  const model = await startMockModel(reply);

  await placeTheOperatorsFiles(paths, model.baseUrl, agentServerUrl);
  await startAgentInstance(t, paths, instancePort);

  // A bare Fastify instance in a Component, as an Operator's entry point constructs it.
  // Bound beyond loopback on purpose — under a plain Linux daemon a container cannot reach
  // a loopback-bound server at all, and this test has to pass on both.
  const agentServer = serverComponent(Fastify(), { port: gatewayPort, host: "0.0.0.0" });
  const runtime = createPiRuntime({
    host: "127.0.0.1",
    port: instancePort,
    // The same string the container's third mount targets, and nothing checks that they
    // agree: one is resolved by the daemon and the other by `pi`.
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
        // Two model round trips and a `pi` start, on whatever machine this is. The
        // framework itself has no timeouts; this one is the test's, so a wedged Run fails
        // the suite rather than hanging it.
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

/**
 * A model that reads the Signals, touches the Workspace, and then answers.
 *
 * Every one of those is a real tool call: `pi` runs `curl` and `cat` and `printf` in the
 * container, against the real Agent server and the real bind mount. Which turn it is comes
 * from the conversation the model was handed, so one function scripts every Run.
 */
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

/**
 * The Agent server's address, as the agent was told it.
 *
 * Read out of the system prompt rather than passed in from the test, because that is the
 * only channel the real thing has: `pi` ships no HTTP client, so the Operator's own
 * `AGENTS.md` plus `curl` *is* the binding. `pi` discovered that file in its working
 * directory and put it here with no flag from us, and a Run where that failed makes this
 * throw rather than quietly passing.
 */
function agentServerIn(request: ModelRequest): string {
  const found = request.system.match(new RegExp(`http://${hostFromContainer}:\\d+`));
  assert.ok(
    found !== null,
    `the agent was never told where the Gateway is; its system prompt ends: ${request.system.slice(-400)}`,
  );
  return found[0];
}

/** The Prompt whose Run the model refuses, so it fails inside the Agent Implementation. */
const doomed = "This Prompt cannot work.";

/** The whole test's model, in one function: the doomed Prompt is refused, the rest work. */
function scripted(request: ModelRequest): ModelReply {
  if (request.texts.some((text) => text.includes(doomed))) {
    return { refuse: { status: 400, message: "this deployment has no model" } };
  }
  return readsAndWrites(request);
}

describe("a real pi behind a real listener", { skip }, () => {
  it("creates a Session at the path it is given, resumes it, and shares the Workspace", async (t) => {
    await withGateway(t, scripted, async (rig) => {
      // Nothing has run yet, and nothing of the framework's is in either directory: no
      // startup step wrote there and none ever will.
      assert.deepEqual(await rig.sessions(), []);

      await writeFile(path.join(rig.workspace, handlerNote), "written by a Signal Handler", "utf8");

      const first = await rig.ask({ session: "user_42", text: "This is the first Prompt." });
      const second = await rig.ask({ session: "user_42", text: "This is the second Prompt." });
      const fresh = await rig.ask({ session: null, text: "This is a one-off Prompt." });

      // Each Signal produced an actual agent Run, recorded with its true outcome. The model
      // it talked to is the one `settings.json` made the default, since no flag named it.
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

      // The Handler that asked for a fresh Session, which is the Worker's to name.
      const [freshRun] = await rig.runsOf(fresh);
      assert.ok(freshRun !== undefined, "the fresh Signal should have one Run");
      assert.deepEqual(
        { session: freshRun.session, state: freshRun.state, error: freshRun.error },
        { session: `run_${freshRun.id}`, state: "done", error: null },
      );

      // **The claim the whole design rests on.** `switch_session` was given a path that did
      // not exist and `pi` made a Session there — at exactly that path, one file per
      // Session, in the directory the Operator mounted and the Gateway names. Nothing is
      // nested, nothing is named after a working directory, and the framework created no
      // file: the two Runs of `user_42` produced one Session, and the fresh one is findable
      // on disk from the Run's own row.
      assert.deepEqual(await rig.sessions(), [`run_${freshRun.id}.jsonl`, "user_42.jsonl"].sort());

      // And the other half of it: the second Run's `pi` found the Session file the first
      // one left, parsed it, and sent its messages to the model. Two connections, two
      // processes, one conversation.
      const resumed = rig.model.requests.find(
        (request) =>
          request.texts.includes("This is the second Prompt.") &&
          request.texts.includes("This is the first Prompt."),
      );
      assert.ok(resumed !== undefined, "the second Run should carry the first Run's conversation");

      // The agent read prior Signals over the Agent server, from inside its container, and
      // got real records back — in every Run, found by its own Prompt.
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

      // The Operator's `AGENTS.md` reached the agent, with the address they wrote in it, and
      // `pi` found it in its working directory with no flag from the framework.
      const system = rig.model.requests[0]?.system ?? "";
      const placed = await readFile(path.join(rig.workspace, agentsFileName), "utf8");
      assert.ok(
        system.includes(placed.trim()),
        `the file the Operator placed should be in the system prompt verbatim: ${system.slice(-600)}`,
      );
      assert.ok(system.includes(rig.agentServerUrl));

      // The Workspace both ways: the agent read the Handler's file, and what the agent wrote
      // is a file this process can read and then edit.
      assert.ok(
        toolResults.some((text) => text.includes("written by a Signal Handler")),
        "the agent should have read the file a Signal Handler left it",
      );
      const written = path.join(rig.workspace, agentNote);
      assert.equal(await readFile(written, "utf8"), "written by the agent");

      // And the Run whose model refuses it: recorded failed, with the provider's own words,
      // out of an agent that settled and said nothing else about it.
      const [failed] = await rig.runsOf(await rig.ask({ session: "user_7", text: doomed }));
      assert.equal(failed?.state, "failed");
      assert.match(failed?.error ?? "", /this deployment has no model/);
      assert.match(failed?.error ?? "", /stopReason/);

      // And a Session name outside `pi`'s grammar, which the framework now refuses itself
      // because a Session is addressed by path and `pi` would open any path it is handed.
      // That Run alone fails, it names the Session, and nothing reached the Agent Instance:
      // the directory holds exactly what the Runs that really happened put there.
      const rejectedName = "../escape";
      const [rejected] = await rig.runsOf(
        await rig.ask({ session: rejectedName, text: "This name is not one pi accepts." }),
      );
      assert.equal(rejected?.state, "failed");
      assert.equal(rejected?.session, rejectedName);
      assert.match(rejected?.error ?? "", /is not a name pi will accept/);
      assert.deepEqual(
        await rig.sessions(),
        [`run_${freshRun.id}.jsonl`, "user_42.jsonl", "user_7.jsonl"].sort(),
        "a Session name the framework refused should have left nothing behind",
      );
    });
  });
});
