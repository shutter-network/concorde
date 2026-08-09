/**
 * `pi` in a real container, driven by a real Signal Worker: the one opt-in end-to-end test.
 *
 * One test path, deliberately. It is slow and it needs Docker and the network, so it
 * earns its place by proving the things nothing faster can:
 *
 *  - the **mounts resolve** — the agent sees the Workspace the Gateway writes into, and
 *    the Gateway sees what the agent wrote back
 *  - the **user ids match**, so a file the agent created is one a Signal Handler can
 *    read and edit
 *  - a **named Session resumes** across two Runs, which is a claim about a transcript on
 *    disk being found and parsed by a second container — under the **mounted agent
 *    directory**, in a directory the Gateway never created and never named. No
 *    `--session-dir` is passed at all: `pi` resolves where its transcripts go, and a
 *    Session survives because the agent directory is mounted and for no other reason.
 *    Nothing says so if it is not, which is the one accepted failure of ADR-0033 that
 *    does not even fail — the agent merely forgets
 *  - `pi` **discovers an `AGENTS.md` the Operator placed in the Workspace**, with no flag
 *    from the framework and nothing of the framework's in the file, and the agent
 *    **reaches the Agent server** at the address that file names — over HTTP from inside
 *    its container, with `curl` from its own shell tool and no credential (ADR-0010).
 *    This is the whole replacement for the instructions file the framework used to write
 *    before every Run, end to end
 *  - a **Session name `pi` refuses** fails that Run and no other, with `pi`'s own
 *    message in the Run's `error` — the framework carries no copy of that grammar and
 *    checks nothing, so this is the only place the claim can be tested at all
 *  - a **mount source that is not there is refused by the daemon**, naming the path, and
 *    nothing is invented on the Operator's disk. This is what the deleted startup mount
 *    check was replaced by, so it is the one claim in ADR-0028 with nothing else behind
 *    it (`--mount type=bind`, never `-v`)
 *  - a **read-only file entry nested inside a read-write directory entry** is genuinely
 *    unwritable from inside the container while the directory around it still writes,
 *    which is what lets a file the agent must not change be one it cannot change
 *
 * What is real here and what is not, exactly: the container, the `pi` binary in it, the
 * mounts, the files the Operator placed in them, the Prompt on a pipe, the JSONL that
 * comes back, the Agent server, the Signal Worker, and PostgreSQL. **Only the model is
 * stubbed** — a scripted OpenAI-compatible server on this host, which is what makes the
 * test deterministic and what makes it need no provider credentials. The consequence, stated
 * rather than hidden: this proves the framework's half of a Run end to end, and says
 * nothing about whether a real model would choose to call the Agent server unprompted.
 *
 * This test is also the Operator, and doing that job is most of what it sets up: it
 * creates the two directories, writes `models.json` into the agent's own directory to
 * describe the scripted model, and writes the two files it mounts read-only — the
 * `settings.json` that makes that model the default, and the `AGENTS.md` that carries the
 * Agent server's address. The framework writes none of it, has never read any of it, and
 * no longer passes a `--model` flag either — the default in that `settings.json` is the
 * whole of how a Run knows what to talk to, and a `settings.json` the agent cannot write
 * is what an Operator should reach for, since `pi` takes a lock beside it even to read it.
 *
 * Note where the scripted model still learns things for itself: the address it tells the
 * agent to `curl` is read **out of the system prompt it was given**, which is where `pi`
 * puts a context file it discovered. So a Run whose `AGENTS.md` did not reach the
 * container has no URL to find and fails here rather than passing quietly.
 *
 * Skipped unless `SAF_CONTAINER_TESTS` is set — see `../test-support/docker.ts` for why.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import type { Mount } from "../agent-container/index.ts";
import { openDb } from "../db/index.ts";
import { createBareGateway, serverComponent } from "../gateway/components.ts";
import type { SignalHandler } from "../signals/handlers.ts";
import type { Runtime } from "../signals/runtime.ts";
import * as signalsSchema from "../signals/schema.ts";
import { runs } from "../signals/schema.ts";
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
 * Where `pi` puts its transcripts, relative to the agent directory it was given.
 *
 * The framework does not know this and does not say it: no `--session-dir` is passed, so
 * `pi` falls back to `<agentDir>/sessions` and resolves the rest itself. Observed in
 * pi@0.83.0: it puts one directory per *working directory* under there, named after the
 * path — `--workspace--` for `/workspace` — and one `.jsonl` per Session inside it. So
 * the flat directory ADR-0025 records the cost of is flat per Workspace, and since an
 * image declares one `WORKDIR` that is one directory for the whole deployment.
 *
 * Written down here, in a test, because a test is the only thing entitled to know it.
 */
const sessionsUnderAgentDir = "sessions";

let image: string;
/**
 * The throwaway database, and the Db that will drop it — which is deliberately **not**
 * the Gateway's.
 *
 * The Gateway's Db is a Component, so the record stops it, and a pool cannot be ended
 * twice. This one is opened by `createTestDatabase`, is never queried on, and exists to
 * hand the database back at the end.
 */
let database: TestDatabase;

before(async () => {
  if (skip !== false) return;
  image = await buildPiImage();
  database = await createTestDatabase("pi_container");
});

after(async () => {
  if (skip !== false) return;
  await database.drop();
});

/** Everything one test needs standing up around the Runtime. */
type Rig = {
  readonly runtime: Runtime;
  readonly model: MockModel;
  /** Where the Operator's own instructions file told the agent to reach the Gateway. */
  readonly agentServerUrl: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly agentsFile: string;
  /** The transcripts `pi` has written under the agent directory, sorted. */
  transcripts(): Promise<string[]>;
  /** Emits a Signal and resolves when its Runs have finished. */
  ask(payload: Ask): Promise<string>;
  /**
   * Every Run recorded for a Signal.
   *
   * The id comes back because a fresh Session is named after it, so it is what a test
   * checks the name against rather than predicting one (ADR-0033).
   */
  runsOf(
    signalId: string,
  ): Promise<{ id: string; session: string | null; state: string; error: string | null }[]>;
};

/** Where a test wants the two mounts pointed, given where they really are. */
type Paths = {
  /**
   * The Runtime Directory: what a Mount Table's `runtimeDir` is given, and what every entry's
   * path below is written relative to.
   *
   * This process and the daemon are the same host here, so the one namespace the table has is
   * also the one this file creates directories in. A containerised Gateway is what makes those
   * two part company, and nothing on this side would notice (ADR-0054).
   */
  readonly root: string;
  readonly workspace: string;
  readonly agentDir: string;
  /**
   * The Operator's instructions file, on this side and **outside the Workspace**.
   *
   * Outside it because that is the arrangement worth demonstrating: a file under version
   * control somewhere else, mounted into a Workspace the agent otherwise writes.
   */
  readonly agentsFile: string;
  /** The Operator's `settings.json`, likewise on this side and outside the mount it lands in. */
  readonly settingsFile: string;
};

/** Two fresh directory names under a temporary root, cleaned up with the test. */
async function temporaryPaths(t: TestContext): Promise<Paths> {
  const root = await mkdtemp(path.join(tmpdir(), "saf-container-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    workspace: path.join(root, "workspace"),
    agentDir: path.join(root, "agent"),
    agentsFile: path.join(root, agentsFileName),
    settingsFile: path.join(root, "settings.json"),
  };
}

/**
 * The two directories an Operator creates, since the framework creates none.
 *
 * Two rather than three: there is no Session root any more, so the deployment creates one
 * fewer directory and names no Session path anywhere (ADR-0025, ADR-0033).
 */
function directoriesOf(paths: Paths): readonly string[] {
  return [paths.workspace, paths.agentDir];
}

/** Every transcript `pi` has written under an agent directory, sorted; none is fine. */
async function transcriptsIn(agentDir: string): Promise<string[]> {
  const root = path.join(agentDir, sessionsUnderAgentDir);
  const found = await readdir(root, { recursive: true }).catch(() => []);
  return found.filter((entry) => entry.endsWith(".jsonl")).sort();
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
 * `models.json`, placed by the Operator in the directory they mount as the agent's.
 *
 * The framework used to write this file before every Run out of an opaque field of its
 * configuration. It carries no such field now, and `pi` reads the file itself out of
 * `PI_CODING_AGENT_DIR` (ADR-0016, ADR-0025).
 */
async function placeModels(paths: Paths, baseUrl: string): Promise<void> {
  const file = path.join(paths.agentDir, "models.json");
  await writeFile(file, `${JSON.stringify(mockProvider(baseUrl), null, 2)}\n`, "utf8");
}

/**
 * `settings.json`, which is where the model and the provider live now.
 *
 * They used to be two fields of the Runtime's configuration and two flags on the command
 * line. Verified in pi@0.83.0: `settings.json` carries `defaultModel` and
 * `defaultProvider`, and `pi` falls back to them when no flag names either — so this file
 * is the whole of how the Run below knows what to talk to, and a Run that reaches the
 * scripted model at all is the proof that it works (ADR-0025, ADR-0033).
 *
 * Written **outside** the agent directory and mounted read-only into it, which is what
 * every example does and is the arrangement worth proving: `pi` takes a lock beside
 * this file even to read it, so a Run against a settings file it cannot write is a claim
 * that only a real container settles.
 */
async function placeSettings(paths: Paths): Promise<void> {
  const settings = { defaultModel: "mock-model", defaultProvider: "mock" };
  await writeFile(paths.settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/** That file as an entry: read-only, inside the agent directory, from outside it. */
function settingsEntry(paths: Paths): Mount {
  return {
    agentPath: "/home/agent/.pi/agent/settings.json",
    path: path.relative(paths.root, paths.settingsFile),
    readOnly: true,
  };
}

/**
 * The instructions file, as an Operator writes one: their own words, then the address.
 *
 * Nothing of the framework's is in it, and nothing of the framework's produced it — an
 * Operator writes this text themselves, as each example's `AGENTS.md` does, and a copy of it
 * can go stale when the Signal Worker's routes change (ADR-0025).
 */
async function placeInstructions(paths: Paths, agentServerUrl: string): Promise<void> {
  await writeFile(
    paths.agentsFile,
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
 * The Runtime under test, however a case wants its mounts pointed.
 *
 * An image and what the container sees, and nothing else: no model, no provider, and no
 * path inside the container. The two the image declares — its `WORKDIR` and its
 * `PI_CODING_AGENT_DIR` — are in `../test-support/pi-image/Dockerfile`, and the two mount
 * targets below have to agree with them by hand, because nothing checks that they do.
 */
function runtimeOn(paths: Paths, extraEntries: readonly Mount[] = []): Runtime {
  return createPiRuntime({
    image,
    // The extra entries go last only for readability: the container runtime sorts bind
    // mounts by destination depth itself, which is what makes a nested entry work at all.
    mounts: {
      entries: [
        { agentPath: "/workspace", path: path.relative(paths.root, paths.workspace) },
        { agentPath: "/home/agent/.pi/agent", path: path.relative(paths.root, paths.agentDir) },
        ...extraEntries,
      ],
      runtimeDir: paths.root,
    },
    extraArgs: [addHostToGateway],
  });
}

/**
 * The instructions file as an entry: read-only, inside the Workspace, from outside it.
 *
 * The Workspace is writable by the agent, so an instructions file simply placed in it is
 * one a successful injection can rewrite for the next Run. `readOnly` is what makes the
 * property structural, and a single-file entry is what leaves the directory around it
 * writable (ADR-0003, ADR-0028).
 */
function instructionsEntry(paths: Paths): Mount {
  return {
    agentPath: `/workspace/${agentsFileName}`,
    path: path.relative(paths.root, paths.agentsFile),
    readOnly: true,
  };
}

/**
 * Stands up a whole Gateway around one `pi` Runtime and hands it to `body`.
 *
 * One end-to-end path, so this is used once: a Signal Worker, a real database, the
 * Agent server with the Worker's routes on it, and the scripted model. Construct and start,
 * as every entry point does it — but by hand through `createBareGateway`,
 * because what this file needs is a subset of the infrastructure and none of the four parts
 * `createGateway` hands the Operator through `extend` (ADR-0045). Nothing here is about the
 * assembly; the subject is a real container running a real `pi`.
 *
 * What it does **not** prove is the ordering: it stops nothing mid-Run, so that the
 * Agent server must outlive the Signal Worker is not asserted here.
 * `gateway.test.ts` is where it is, with a fake Runtime parked in flight while the
 * Gateway shuts down around it (ADR-0045).
 */
async function withGateway(
  t: TestContext,
  reply: (request: ModelRequest, at: number) => ModelReply,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  const paths = await temporaryPaths(t);
  // Both, as an Operator's entry point does it, because the framework creates no directory
  // anywhere (ADR-0028) and the daemon refuses a bind source that is not there rather than
  // inventing one — which is the case the test below this one walks into.
  await Promise.all(directoriesOf(paths).map((directory) => mkdir(directory, { recursive: true })));

  // The port before the server, because the agent is told where the Agent server is in a
  // file written now, and it has to name the port the container will connect to.
  const port = await reservePort();
  const agentServerUrl = `http://${hostFromContainer}:${port}`;
  // A bare Fastify instance in a Component, as an Operator's entry point constructs it:
  // the framework ships no server and defaults no address, so both are stated here.
  // Bound beyond loopback on purpose — under a plain Linux daemon a container cannot
  // reach a loopback-bound server at all, and this test has to pass on both. Nothing
  // warns about it and nothing inspects what was bound (ADR-0004).
  const agentServer = serverComponent(Fastify(), { port, host: "0.0.0.0" });
  const model = await startMockModel(reply);

  // The Operator's three files, every one of them something the framework used to write
  // or to carry and now knows nothing about: how to reach the model, which model to use,
  // and how to reach the Gateway.
  await placeModels(paths, model.baseUrl);
  await placeSettings(paths);
  await placeInstructions(paths, agentServerUrl);

  const runtime = runtimeOn(paths, [instructionsEntry(paths), settingsEntry(paths)]);

  // The Gateway's own Db, on the same database. The Worker's tables are pushed here rather
  // than by constructing it, because the framework applies no DDL of its own (ADR-0046);
  // handing the Worker the server is what registers its routes, so nothing here calls
  // `register`. One push per database, and this function runs once.
  const db = openDb(database.url);
  const worker = createSignalWorker({ db, runtime, handlers: { ask: asking }, agentServer });
  await applySchema(db, signalsSchema);

  const handle = db.handle({ runs });
  const rig: Rig = {
    runtime,
    model,
    agentServerUrl,
    ...paths,
    transcripts: () => transcriptsIn(paths.agentDir),
    async ask(payload) {
      const id = await db.tx((tx) => worker.emit(tx, { kind: "ask", payload }));
      await waitUntil(
        `the Signal ${id} has been processed`,
        async () => {
          const [row] = await handle.select().from(runs).where(eq(runs.signalId, id));
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
      const rows = await handle.select().from(runs).where(eq(runs.signalId, signalId));
      return rows.map((row) => ({
        id: row.id,
        session: row.session,
        state: row.state,
        error: row.error,
      }));
    },
  };

  // An example deployment's order, minus the three parts this test has no use for: the
  // Db first so it stops last, the Agent server before the Worker so it closes after the
  // drain, and `start` in one call that binds the port the agent was already told about
  // (ADR-0037, ADR-0038).
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
 * only channel the real thing has: `pi` ships no HTTP client, so the Operator's own
 * `AGENTS.md` plus `curl` *is* the binding (ADR-0010). `pi` discovered that file in its
 * working directory and put it here with no flag from us, and a Run where that failed
 * makes this throw rather than quietly passing.
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
  it("runs the agent, which reads prior Signals and shares the Workspace, and resumes a Session", async (t) => {
    await withGateway(t, scripted, async (rig) => {
      // Nothing has run yet, and nothing of the framework's is in the directory the
      // Operator's Handlers share: no startup step wrote there and none ever will.
      assert.deepEqual(await readdir(rig.workspace), []);

      await writeFile(path.join(rig.workspace, handlerNote), "written by a Signal Handler", "utf8");

      const first = await rig.ask({ session: "user_42", text: "This is the first Prompt." });
      const second = await rig.ask({ session: "user_42", text: "This is the second Prompt." });
      const fresh = await rig.ask({ session: null, text: "This is a one-off Prompt." });

      // A Signal produced an actual agent Run, recorded with its true outcome. The model
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

      // The Handler that asked for a fresh Session, which is the Worker's to name. The
      // row says `run_<its own id>` rather than `null`, so the Session an Operator has to
      // go looking for is on the Run they are already looking at (ADR-0033).
      const [freshRun] = await rig.runsOf(fresh);
      assert.ok(freshRun !== undefined, "the fresh Signal should have one Run");
      assert.deepEqual(
        { session: freshRun.session, state: freshRun.state, error: freshRun.error },
        { session: `run_${freshRun.id}`, state: "done", error: null },
      );

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

      // The Operator's `AGENTS.md` reached the agent, with the address they wrote in it,
      // and `pi` found it in its working directory with no flag from the framework —
      // which is the whole of what replaced the file the framework used to write.
      const system = rig.model.requests[0]?.system ?? "";
      const placed = await readFile(rig.agentsFile, "utf8");
      assert.ok(
        system.includes(placed.trim()),
        `the file the Operator placed should be in the system prompt verbatim: ${system.slice(-600)}`,
      );
      assert.ok(
        system.includes(rig.agentServerUrl),
        "the address the agent was told should be the one the Operator wrote",
      );

      // The Session resumed: the second Run's container found the Session file the first
      // one left, parsed it, and sent its messages to the model.
      const resumed = rig.model.requests.find(
        (request) =>
          request.texts.includes("This is the second Prompt.") &&
          request.texts.includes("This is the first Prompt."),
      );
      assert.ok(resumed !== undefined, "the second Run should carry the first Run's conversation");

      // And where the transcripts went, which is the claim ADR-0033 traded the Session
      // root for: **under the mounted agent directory**, in a directory `pi` chose and
      // created inside its own container. The framework passed no `--session-dir`, named
      // no path, and created nothing; the agent directory is the Operator's, and mounting
      // it is the whole of why any of this survived the `--rm` (ADR-0025, ADR-0028).
      //
      // One directory for the Workspace and one transcript per Session inside it, and
      // every Run parses all of them: that is the cost of the framework holding no
      // filesystem knowledge, and since the image declares one `WORKDIR` it is one
      // directory for the whole deployment, growing without bound with nothing the
      // Operator can do about it (ADR-0025).
      const transcripts = await rig.transcripts();
      assert.equal(transcripts.length, 2, `one transcript per Session: ${transcripts.join(", ")}`);
      assert.ok(
        transcripts.some((file) => file.includes("user_42")),
        `the named Session should be one of them: ${transcripts.join(", ")}`,
      );
      // And the other is the fresh one, findable on disk from the Run's own row. This is
      // what naming a fresh Session buys and the reason it is not left ephemeral: the
      // transcript of a Run nobody chose a Session for is still one an Operator can open,
      // starting from the Run they were reading (ADR-0025, ADR-0033).
      assert.ok(
        transcripts.some((file) => file.includes(`run_${freshRun.id}`)),
        `the fresh Session's transcript should be named after its Run: ${transcripts.join(", ")}`,
      );

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

      // And a Session name `pi` will not have: nothing in the framework inspected it,
      // so this is `pi`'s own refusal, reaching the Operator through the Run's `error`
      // with the name they wrote in the Run's `session` beside it. The framework used
      // to carry a transcription of that grammar and fail the whole Signal before any
      // Run existed; this is the diagnostic that replaced it, and it cannot go stale
      // when `pi` changes its mind (ADR-0024).
      const rejectedName = "user:42";
      const [rejected] = await rig.runsOf(
        await rig.ask({ session: rejectedName, text: "This name is not one pi accepts." }),
      );
      assert.equal(rejected?.state, "failed");
      assert.equal(rejected?.session, rejectedName);
      // The clause that describes *this* refusal, not merely one of `pi`'s.
      assert.match(rejected?.error ?? "", /Session id must .*only alphanumeric characters/);
      // `pi` exits 1 without writing a line of JSONL, so the Runtime's own half of the
      // message is there too — the exit code, which is what says the process refused
      // rather than the model.
      assert.match(rejected?.error ?? "", /exited with code 1/);
      // It created nothing on the way out: the agent directory still holds one transcript
      // per Session that actually ran.
      assert.deepEqual(
        (await rig.transcripts()).filter((entry) => entry.includes(":")),
        [],
        "a Session pi refused should have left no transcript behind",
      );
    });
  });

  it("is refused by the daemon when a mount source is not there, which names the path", async (t) => {
    // The claim the deleted startup mount check was traded for, and the only place it can
    // be made: `--mount type=bind` refuses a missing source, where `-v` would invent it
    // as a `root`-owned directory and let the Run succeed against an empty Workspace
    // (ADR-0028). No Signal Worker and no Agent server here — the container never starts.
    const paths = await temporaryPaths(t);
    // Everything but the Workspace, which is the typo this is about.
    await mkdir(paths.agentDir, { recursive: true });
    const runtime = runtimeOn(paths);

    const outcome = await runtime.run({ session: "user_42", text: "This will not start." });

    assert.equal(outcome.ok, false);
    const error = outcome.ok ? "" : outcome.error;
    assert.match(error, /bind source path does not exist/);
    assert.ok(
      error.includes(paths.workspace),
      `the daemon's refusal should name the path it could not find: ${error}`,
    );
    // And nothing was created behind the Operator's back, which is the other half of
    // what `-v` did and the reason a wrong path used to be silent.
    await assert.rejects(() => stat(paths.workspace), /ENOENT/);
  });

  it("gives the agent a read-only file inside a directory it can still write", async (t) => {
    // What replaces rewriting the agent's configuration before every Run: a file the
    // agent must not change becomes one it *cannot* change, by construction and for free
    // (ADR-0028). The nesting is the part worth proving — a read-only directory would
    // hold the same property and break every sibling operation `pi` needs.
    const paths = await temporaryPaths(t);
    await Promise.all(
      directoriesOf(paths).map((directory) => mkdir(directory, { recursive: true })),
    );
    const guarded = paths.agentsFile;
    await writeFile(guarded, "the Operator's own words", "utf8");

    const model = await startMockModel((request) =>
      assistantMessages(request) === 0
        ? {
            bash: [
              `cat /workspace/${agentsFileName}`,
              `(printf 'overwritten by the agent' > /workspace/${agentsFileName}) 2>&1 || true`,
              `printf 'written by the agent' > /workspace/${agentNote}`,
              // The lock directory `pi` needs beside a settings file even to read one:
              // a sibling of the read-only file, in the read-write directory around it.
              `mkdir /workspace/${agentsFileName}.lock && echo made-the-lock-directory`,
            ].join("; "),
          }
        : { say: "I could read it and I could not write it." },
    );
    try {
      await placeModels(paths, model.baseUrl);
      await placeSettings(paths);
      const runtime = runtimeOn(paths, [instructionsEntry(paths), settingsEntry(paths)]);

      const outcome = await runtime.run({ session: "readonly", text: "Try to write it." });
      assert.deepEqual(outcome, { ok: true }, "being denied a write must not fail the Run");

      const seen = model.requests.flatMap((request) => request.texts);
      assert.ok(
        seen.some((text) => text.includes("the Operator's own words")),
        `the agent should have read the Gateway's content: ${seen.join(" | ")}`,
      );
      assert.ok(
        seen.some((text) => /Read-only file system/i.test(text)),
        `the agent's write should have been denied by the kernel: ${seen.join(" | ")}`,
      );
      assert.ok(
        seen.some((text) => text.includes("made-the-lock-directory")),
        `a sibling of the read-only file should still be creatable: ${seen.join(" | ")}`,
      );
      // The two claims as this process sees them: the guarded file is untouched, and the
      // directory around it took the agent's writes.
      assert.equal(await readFile(guarded, "utf8"), "the Operator's own words");
      assert.equal(
        await readFile(path.join(paths.workspace, agentNote), "utf8"),
        "written by the agent",
      );
      await stat(path.join(paths.workspace, `${agentsFileName}.lock`));
    } finally {
      await model.close();
    }
  });
});
