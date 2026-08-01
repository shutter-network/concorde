/**
 * `pi` in a real container, driven by a real Core: the one opt-in end-to-end test.
 *
 * One test path, deliberately. It is slow and it needs Docker and the network, so it
 * earns its place by proving the things nothing faster can:
 *
 *  - the **mounts resolve** — the agent sees the Workspace the Gateway writes into, and
 *    the Gateway sees what the agent wrote back
 *  - the **user ids match**, so a file the agent created is one a Signal Handler can
 *    read and edit
 *  - a **named Session resumes** across two Runs, which is a claim about a Session file
 *    on disk being found and parsed by a second container — in a directory the Gateway
 *    never created, since `pi` makes each Session's own directory itself (ADR-0025)
 *  - the agent **reaches the Agent server** over HTTP from inside its container, with
 *    `curl` from its own shell tool and no credential (ADR-0010)
 *
 * What is real here and what is not, exactly: the container, the `pi` binary in it, the
 * three mounts, the Prompt on a pipe, the JSONL that comes back, the Agent server, the
 * Core, and PostgreSQL. **Only the model is stubbed** — a scripted OpenAI-compatible
 * server on this host, which is what makes the test deterministic and what makes it
 * need no provider credentials. The consequence, stated rather than hidden: this proves
 * the framework's half of a Run end to end, and says nothing about whether a real model
 * would choose to call the Agent server unprompted.
 *
 * Note where the scripted model still learns things for itself: the address it tells the
 * agent to `curl` is read **out of the system prompt it was given**, so a Run whose
 * agent directory did not mount has no URL to find and fails here rather than passing
 * quietly — which is exactly what `--append-system-prompt` falling back to its own
 * argument would otherwise produce.
 *
 * Skipped unless `SAF_CONTAINER_TESTS` is set — see `../test-support/docker.ts` for why.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { createCore } from "../core/core.ts";
import type { SignalHandler } from "../core/handlers.ts";
import { coreMigrations } from "../core/migrations.ts";
import { runs } from "../core/schema.ts";
import type { Store } from "../store/index.ts";
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
import { createPiAdapter, type PiRuntime } from "./adapter.ts";
import type { PiConfiguration } from "./configuration.ts";

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

let image: string;
let database: TestDatabase;
let store: Store;

before(async () => {
  if (skip !== false) return;
  image = await buildPiImage();
  database = await createTestDatabase("pi_container");
  store = database.store;
  await store.migrate(coreMigrations);
});

after(async () => {
  if (skip !== false) return;
  await database.drop();
});

/** Everything one test needs standing up around the adapter. */
type Rig = {
  readonly runtime: PiRuntime;
  readonly model: MockModel;
  /** Where the agent's container was told to reach the Agent server. */
  readonly agentServerUrl: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly sessionRoot: string;
  /** Emits a Signal and resolves when its Runs have finished. */
  ask(payload: Ask): Promise<string>;
  /** Every Run recorded for a Signal. */
  runsOf(signalId: string): Promise<{ state: string; error: string | null }[]>;
};

/** Where a test wants the three mounts pointed, given where they really are. */
type Paths = {
  readonly workspace: string;
  readonly agentDir: string;
  readonly sessionRoot: string;
};

/**
 * Three real directories and an adapter over them, and nothing else.
 *
 * What the startup check needs and no more: no Core, no database, no Agent server and
 * no model, because none of them is reachable at the moment an Operator's entry point
 * refuses to start.
 */
async function withMounts(
  body: (runtime: PiRuntime, paths: Paths) => Promise<void>,
  mounts: (paths: Paths) => Partial<PiConfiguration> = () => ({}),
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "saf-container-"));
  const paths: Paths = {
    workspace: path.join(root, "workspace"),
    agentDir: path.join(root, "agent"),
    sessionRoot: path.join(root, "sessions"),
  };
  // The Workspace is the Operator's; the other two the framework creates itself.
  await mkdir(paths.workspace, { recursive: true });
  try {
    await body(adapterOn(paths, "http://host.docker.internal:7411", {}, mounts(paths)), paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The adapter under test, however a case wants its mounts and its model pointed. */
function adapterOn(
  paths: Paths,
  agentServerUrl: string,
  models: Record<string, unknown>,
  overrides: Partial<PiConfiguration>,
): PiRuntime {
  return createPiAdapter({
    image,
    model: "mock-model",
    provider: "mock",
    workspace: { localPath: paths.workspace, agentPath: "/workspace" },
    agentDir: { localPath: paths.agentDir, agentPath: "/home/agent/.pi/agent" },
    sessionRoot: { localPath: paths.sessionRoot, agentPath: "/sessions" },
    agentServerUrl,
    instructions: "You are the shared agent of a test.",
    models,
    extraArgs: [addHostToGateway],
    ...overrides,
  });
}

/**
 * Stands up a whole Gateway around one `pi` adapter and hands it to `body`.
 *
 * One end-to-end path, so this is used once: a Core, a real database, the Agent server
 * with the Core's routes on it, and the scripted model. What is actually expensive — the
 * image and the database — is shared with the other case.
 */
async function withGateway(
  reply: (request: ModelRequest, at: number) => ModelReply,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "saf-container-"));
  const paths: Paths = {
    workspace: path.join(root, "workspace"),
    agentDir: path.join(root, "agent"),
    sessionRoot: path.join(root, "sessions"),
  };
  await mkdir(paths.workspace, { recursive: true });

  // The port before the server, because `agentServerUrl` is a construction argument of
  // the adapter and has to name the port the agent's container will connect to.
  const port = await reservePort();
  const agentServerUrl = `http://${hostFromContainer}:${port}`;
  // A bare Fastify instance, as an Operator's entry point constructs it. The framework
  // ships no server and no bind default, so the host below is this test's to state.
  const agentServer = Fastify();
  const model = await startMockModel(reply);

  const runtime = adapterOn(
    paths,
    agentServerUrl,
    {
      providers: {
        mock: {
          baseUrl: model.baseUrl,
          api: "openai-completions",
          apiKey: "not-a-real-key",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: "mock-model", name: "Mock", contextWindow: 128_000, maxTokens: 4096 }],
        },
      },
    },
    {},
  );

  const core = createCore({ store, runtime });
  // Nothing registers the Core's routes for you, and Fastify refuses a registration
  // after a server is listening.
  await agentServer.register(core.agentRoutes);
  // Bound beyond loopback on purpose: under a plain Linux daemon a container cannot
  // reach a loopback-bound server at all, and this test has to pass on both. Nothing
  // warns about it, and nothing inspects what was bound — the address is the
  // deployment's alone (ADR-0004).
  await agentServer.listen({ port, host: "0.0.0.0" });

  const db = store.handle({ runs });
  const rig: Rig = {
    runtime,
    model,
    agentServerUrl,
    ...paths,
    async ask(payload) {
      const id = await store.tx((tx) => core.emit(tx, { kind: "ask", payload }));
      await waitUntil(
        `the Signal ${id} has been processed`,
        async () => {
          const [row] = await db.select().from(runs).where(eq(runs.signalId, id));
          return row !== undefined && row.state !== "pending" && row.state !== "running";
        },
        // A container start, an image lookup and two model round trips, on whatever
        // machine this is. The framework itself has no timeouts (ADR-0017); this one is
        // the test's, so a wedged Run fails the suite rather than hanging it.
        180_000,
      );
      return id;
    },
    async runsOf(signalId) {
      const rows = await db.select().from(runs).where(eq(runs.signalId, signalId));
      return rows.map((row) => ({ state: row.state, error: row.error }));
    },
  };

  core.start({ ask: asking });
  try {
    await body(rig);
  } finally {
    await core.stop();
    await agentServer.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A model that reads the Signals, touches the Workspace, and then answers.
 *
 * Every one of those is a real tool call: `pi` runs `curl` and `cat` and `printf` in the
 * container, against the real Agent server and the real bind mount. Which turn it is
 * comes from the conversation the model was handed, so one function scripts every Run.
 */
function readsAndWrites(request: ModelRequest): ModelReply {
  switch (assistantMessages(request)) {
    case 0:
      return { bash: `curl -s "${agentServerIn(request)}/signals?limit=5"` };
    case 1:
      return {
        bash: `cat /workspace/${handlerNote} && printf '%s' 'written by the agent' > /workspace/${agentNote}`,
      };
    default:
      return { say: "I read the Signals and left a note." };
  }
}

/**
 * The Agent server's address, as the agent was told it.
 *
 * Read out of the system prompt rather than passed in from the test, because that is the
 * only channel the real thing has: `pi` ships no HTTP client, so the instructions file
 * the adapter writes plus `curl` *is* the binding (ADR-0010). A missing instructions
 * file makes this throw, which is the point — `--append-system-prompt` would otherwise
 * pass off its own argument as the prompt and nothing would look wrong.
 */
function agentServerIn(request: ModelRequest): string {
  const found = request.system.match(new RegExp(`http://${hostFromContainer}:\\d+`));
  assert.ok(
    found !== null,
    `the agent was never told where the Gateway is; its system prompt ends: ${request.system.slice(-400)}`,
  );
  return found[0];
}

/** The Prompt whose Run the model refuses, so the Run fails inside the Agent Runtime. */
const doomed = "This Prompt cannot work.";

/**
 * The whole test's model, in one function.
 *
 * One script rather than one per case, because there is one end-to-end path: the Run of
 * the doomed Prompt is refused and every other Run reads and writes.
 */
function scripted(request: ModelRequest): ModelReply {
  if (request.texts.some((text) => text.includes(doomed))) {
    return { refuse: { status: 400, message: "this deployment has no model" } };
  }
  return readsAndWrites(request);
}

describe("pi in a real container", { skip }, () => {
  it("runs the agent, which reads prior Signals and shares the Workspace, and resumes a Session", async () => {
    await withGateway(scripted, async (rig) => {
      // First, as an entry point does it: the startup check, which is the only thing
      // that can say the mounts really resolve and that the container's writes belong to
      // this process. No exception is the assertion.
      await rig.runtime.verifyMounts();
      // And it left nothing behind in the directory the Operator's Handlers share.
      assert.deepEqual(await readdir(rig.workspace), []);

      await writeFile(path.join(rig.workspace, handlerNote), "written by a Signal Handler", "utf8");

      const first = await rig.ask({ session: "user_42", text: "This is the first Prompt." });
      const second = await rig.ask({ session: "user_42", text: "This is the second Prompt." });
      const fresh = await rig.ask({ session: null, text: "This is a one-off Prompt." });

      // A Signal produced an actual agent Run, recorded with its true outcome.
      for (const [label, signalId] of [
        ["the first", first],
        ["the second", second],
        ["the fresh", fresh],
      ] as const) {
        assert.deepEqual(
          await rig.runsOf(signalId),
          [{ state: "done", error: null }],
          `${label} Signal should have one Run, done`,
        );
      }

      // The agent read prior Signals over the Agent server, from inside its container,
      // and got real records back — in every Run, found by its own Prompt.
      const toolResults = rig.model.requests.flatMap((request) => request.texts);
      for (const prompt of [
        "This is the first Prompt.",
        "This is the second Prompt.",
        "This is a one-off Prompt.",
      ]) {
        assert.ok(
          rig.model.requests.some(
            (request) =>
              request.texts.includes(prompt) &&
              request.texts.some((text) => text.includes('"signals"')),
          ),
          `the Run of ${JSON.stringify(prompt)} should have read the Signals over HTTP`,
        );
      }
      const readSignals = toolResults.filter((text) => text.includes('"signals"'));
      assert.ok(
        readSignals.some((text) => text.includes("This is the first Prompt.")),
        `a Run should have read a prior Signal's payload back: ${readSignals[0]}`,
      );

      // The instructions file reached the agent, with the address this Gateway stated.
      const system = rig.model.requests[0]?.system ?? "";
      assert.match(system, /The Gateway's Agent server/);
      assert.ok(
        system.includes(rig.agentServerUrl),
        "the stated address should be the one written",
      );

      // The Session resumed: the second Run's container found the Session file the first
      // one left, parsed it, and sent its messages to the model.
      const resumed = rig.model.requests.find(
        (request) =>
          request.texts.includes("This is the second Prompt.") &&
          request.texts.includes("This is the first Prompt."),
      );
      assert.ok(resumed !== undefined, "the second Run should carry the first Run's conversation");

      // One directory per Session, and a fresh Session gets its own — every one of them
      // created by `pi` inside its container, since the Gateway creates only the root
      // and does that in the startup check above (ADR-0025).
      const sessions = (await readdir(rig.sessionRoot)).sort();
      assert.ok(sessions.includes("user_42"), `the named Session: ${sessions.join(", ")}`);
      assert.equal(sessions.length, 2, `one directory per Session: ${sessions.join(", ")}`);
      const named = await readdir(path.join(rig.sessionRoot, "user_42"));
      assert.equal(named.length, 1, `two Runs, one Session file: ${named.join(", ")}`);

      // The Workspace both ways: the agent read the Handler's file, and what the agent
      // wrote is a file this process can read and then edit.
      assert.ok(
        toolResults.some((text) => text.includes("written by a Signal Handler")),
        "the agent should have read the file a Signal Handler left it",
      );
      const written = path.join(rig.workspace, agentNote);
      assert.equal(await readFile(written, "utf8"), "written by the agent");
      await writeFile(written, "and edited by the Gateway", "utf8");
      assert.equal(await readFile(written, "utf8"), "and edited by the Gateway");

      // And the Run whose model refuses it: recorded failed, with the provider's own
      // words, out of a process that exited 0 (ADR-0025's first trap, through a real
      // container this time rather than a captured stream).
      const [failed] = await rig.runsOf(await rig.ask({ session: "user_7", text: doomed }));
      assert.equal(failed?.state, "failed");
      assert.match(failed?.error ?? "", /this deployment has no model/);
      assert.match(failed?.error ?? "", /stopReason/);
    });
  });

  it("refuses startup naming the mount whose source the container runtime resolved elsewhere", async () => {
    // The failure the startup check exists for: the daemon resolves `source` on the
    // host, and one it cannot find is silently created as an empty directory. Not part
    // of the end-to-end path above and deliberately much cheaper than it — a refusal
    // happens before there is a Core, a database or a server to have.
    //
    // Both mounts are tried, because a wrong agentDir is the worse of the two: `pi`
    // falls back to using the *path* of a missing instructions file as the instructions,
    // so that one cannot fail on its own at all.
    for (const role of ["workspace", "agentDir"] as const) {
      await withMounts(
        async (runtime) => {
          await assert.rejects(runtime.verifyMounts(), (error: Error) => {
            assert.match(error.message, new RegExp(`^the ${role} mount does not reach`));
            assert.match(error.message, /could not read the token/);
            assert.match(error.message, /silently created as an empty directory/);
            return true;
          });
        },
        (paths) => ({
          [role]: {
            localPath: paths[role],
            agentPath: role === "workspace" ? "/workspace" : "/home/agent/.pi/agent",
            // A path the daemon has never heard of, which it makes an empty directory of
            // rather than refusing.
            source: path.join(paths[role], "..", `not-where-it-lives-${role}`),
          },
        }),
      );
    }
  });
});
