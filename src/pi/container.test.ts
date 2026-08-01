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
 * comes back, the Agent server, the Core, and PostgreSQL. **Only the model is stubbed** —
 * a scripted OpenAI-compatible server on this host, which is what makes the test
 * deterministic and what makes it need no provider credentials. The consequence, stated
 * rather than hidden: this proves the framework's half of a Run end to end, and says
 * nothing about whether a real model would choose to call the Agent server unprompted.
 *
 * This test is also the Operator, and doing that job is most of what it sets up: it
 * creates the three directories, writes `models.json` into the agent's own directory to
 * describe the scripted model, and writes the `AGENTS.md` that carries the Agent server's
 * address. The framework writes none of it and has never read any of it.
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
import type { Mount } from "../container/index.ts";
import { createCore } from "../core/core.ts";
import type { SignalHandler } from "../core/handlers.ts";
import { coreMigrations } from "../core/migrations.ts";
import type { RuntimeAdapter } from "../core/runtime.ts";
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
import { createPiAdapter } from "./adapter.ts";

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
 * A Run id of the shape the Core hands the adapter.
 *
 * Only the two cases that drive the adapter directly need one. They have no Core because
 * they have no need of one: what they are about is what the container runtime does with
 * a Mount Table, and a Signal on a queue would add a database and prove nothing more.
 */
const runId = "6f1a3c7e-0000-4000-8000-000000000001";

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
  readonly runtime: RuntimeAdapter;
  readonly model: MockModel;
  /** Where the Operator's own instructions file told the agent to reach the Gateway. */
  readonly agentServerUrl: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly sessionRoot: string;
  readonly agentsFile: string;
  /** Emits a Signal and resolves when its Runs have finished. */
  ask(payload: Ask): Promise<string>;
  /** Every Run recorded for a Signal. */
  runsOf(
    signalId: string,
  ): Promise<{ session: string | null; state: string; error: string | null }[]>;
};

/** Where a test wants the three mounts pointed, given where they really are. */
type Paths = {
  readonly workspace: string;
  readonly agentDir: string;
  readonly sessionRoot: string;
  /**
   * The Operator's instructions file, on this side and **outside the Workspace**.
   *
   * Outside it because that is the arrangement worth demonstrating: a file under version
   * control somewhere else, mounted into a Workspace the agent otherwise writes.
   */
  readonly agentsFile: string;
};

/** Three fresh directory names under a temporary root, cleaned up with the test. */
async function temporaryPaths(t: TestContext): Promise<Paths> {
  const root = await mkdtemp(path.join(tmpdir(), "saf-container-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    workspace: path.join(root, "workspace"),
    agentDir: path.join(root, "agent"),
    sessionRoot: path.join(root, "sessions"),
    agentsFile: path.join(root, agentsFileName),
  };
}

/** The three directories an Operator creates, since the framework creates none. */
function directoriesOf(paths: Paths): readonly string[] {
  return [paths.workspace, paths.agentDir, paths.sessionRoot];
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
 * The instructions file, as an Operator writes one: their own words, then the address.
 *
 * Nothing of the framework's is in it, and nothing of the framework's produced it — the
 * quickstart is where an Operator gets this text, and a copy of it can go stale when the
 * Core's routes change (ADR-0025).
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

/** The adapter under test, however a case wants its mounts pointed. */
function adapterOn(paths: Paths, extraEntries: readonly Mount[] = []): RuntimeAdapter {
  return createPiAdapter({
    image,
    model: "mock-model",
    provider: "mock",
    // Container paths, and the Mount Table says where each comes from. The extra entries
    // go last only for readability: the container runtime sorts bind mounts by
    // destination depth itself, which is what makes a nested entry work at all.
    workspacePath: "/workspace",
    agentDirPath: "/home/agent/.pi/agent",
    sessionRootPath: "/sessions",
    mounts: {
      entries: [
        { containerPath: "/workspace", gatewayPath: paths.workspace },
        { containerPath: "/home/agent/.pi/agent", gatewayPath: paths.agentDir },
        { containerPath: "/sessions", gatewayPath: paths.sessionRoot },
        ...extraEntries,
      ],
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
    containerPath: `/workspace/${agentsFileName}`,
    gatewayPath: paths.agentsFile,
    readOnly: true,
  };
}

/**
 * Stands up a whole Gateway around one `pi` adapter and hands it to `body`.
 *
 * One end-to-end path, so this is used once: a Core, a real database, the Agent server
 * with the Core's routes on it, and the scripted model.
 */
async function withGateway(
  t: TestContext,
  reply: (request: ModelRequest, at: number) => ModelReply,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  const paths = await temporaryPaths(t);
  // All three, as an Operator's entry point does it, because the framework creates no
  // directory anywhere (ADR-0028) and the daemon refuses a bind source that is not there
  // rather than inventing one — which is the case the test below this one walks into.
  await Promise.all(directoriesOf(paths).map((directory) => mkdir(directory, { recursive: true })));

  // The port before the server, because the agent is told where the Agent server is in a
  // file written now, and it has to name the port the container will connect to.
  const port = await reservePort();
  const agentServerUrl = `http://${hostFromContainer}:${port}`;
  // A bare Fastify instance, as an Operator's entry point constructs it. The framework
  // ships no server and no bind default, so the host below is this test's to state.
  const agentServer = Fastify();
  const model = await startMockModel(reply);

  // The Operator's two files, both of them things the framework used to write and now
  // knows nothing about: how to reach the model, and how to reach the Gateway.
  await placeModels(paths, model.baseUrl);
  await placeInstructions(paths, agentServerUrl);

  const runtime = adapterOn(paths, [instructionsEntry(paths)]);

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
      return rows.map((row) => ({ session: row.session, state: row.state, error: row.error }));
    },
  };

  core.start({ ask: asking });
  try {
    await body(rig);
  } finally {
    await core.stop();
    await agentServer.close();
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
  it("runs the agent, which reads prior Signals and shares the Workspace, and resumes a Session", async (t) => {
    await withGateway(t, scripted, async (rig) => {
      // Nothing has run yet, and nothing of the framework's is in the directory the
      // Operator's Handlers share: no startup step wrote there and none ever will.
      assert.deepEqual(await readdir(rig.workspace), []);

      await writeFile(path.join(rig.workspace, handlerNote), "written by a Signal Handler", "utf8");

      const first = await rig.ask({ session: "user_42", text: "This is the first Prompt." });
      const second = await rig.ask({ session: "user_42", text: "This is the second Prompt." });
      const fresh = await rig.ask({ session: null, text: "This is a one-off Prompt." });

      // A Signal produced an actual agent Run, recorded with its true outcome.
      for (const [label, signalId, session] of [
        ["the first", first, "user_42"],
        ["the second", second, "user_42"],
        // `null`, because the Run row records what the Handler asked for and this
        // Handler asked for a fresh Session; the generated name is the adapter's.
        ["the fresh", fresh, null],
      ] as const) {
        assert.deepEqual(
          await rig.runsOf(signalId),
          [{ session, state: "done", error: null }],
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

      // One directory per Session, and a fresh Session gets its own — every one of them
      // created by `pi` inside its container. The framework created neither these nor
      // the root they sit in; the root is the Operator's (ADR-0025, ADR-0028).
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
      // `pi` exits 1 without writing a line of JSONL, so the adapter's own half of the
      // message is there too — the exit code, which is what says the process refused
      // rather than the model.
      assert.match(rejected?.error ?? "", /exited with code 1/);
      // It created nothing on the way out: the Session root still holds one directory
      // per Session that actually ran.
      assert.deepEqual(
        (await readdir(rig.sessionRoot)).filter((entry) => entry.includes(":")),
        [],
        "a Session pi refused should have left no directory behind",
      );
    });
  });

  it("is refused by the daemon when a mount source is not there, which names the path", async (t) => {
    // The claim the deleted startup mount check was traded for, and the only place it can
    // be made: `--mount type=bind` refuses a missing source, where `-v` would invent it
    // as a `root`-owned directory and let the Run succeed against an empty Workspace
    // (ADR-0028). No Core and no Agent server here — the container never starts.
    const paths = await temporaryPaths(t);
    // Everything but the Workspace, which is the typo this is about.
    await mkdir(paths.agentDir, { recursive: true });
    await mkdir(paths.sessionRoot, { recursive: true });
    const runtime = adapterOn(paths);

    const outcome = await runtime.run({ session: "user_42", text: "This will not start." }, runId);

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
      const runtime = adapterOn(paths, [instructionsEntry(paths)]);

      const outcome = await runtime.run({ session: "readonly", text: "Try to write it." }, runId);
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
