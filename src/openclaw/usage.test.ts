import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { RunOutcome, RunPrompt } from "../signals/runtime.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { signals } from "../signals/schema/index.ts";
import { createUsage } from "../signals/usage.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import {
  type DaemonReply,
  dropsTheConnection,
  type FakeDaemon,
  modelCall,
  modelCalls,
  refusedCall,
  scriptedDaemon,
  settledRun,
  startFakeDaemon,
  type Written,
} from "../test-support/openclaw-daemon.ts";
import { waitUntil } from "../test-support/wait.ts";
import { createOpenClawRuntime } from "./runtime.ts";

const prompt: RunPrompt = { session: "user_42", text: "what happened?" };

const deviceKey = generateKeyPairSync("ed25519").privateKey;

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const running: FakeDaemon[] = [];

after(async () => {
  await Promise.all(running.map((daemon) => daemon.close()));
});

async function runAgainst(
  reply: DaemonReply,
  given: RunPrompt = prompt,
): Promise<{ outcome: RunOutcome; daemon: FakeDaemon }> {
  const daemon = await startFakeDaemon({ reply });
  running.push(daemon);
  const runtime = createOpenClawRuntime({
    url: daemon.url,
    token: daemon.token,
    deviceKey,
    logger: silent,
  });
  return { outcome: await runtime.run(given), daemon };
}

// The counts the prototype's scripted model reported: call n of request k is 1000n + k in,
// 10n out (Finding 3).
const threeCalls = modelCalls(
  { input: 1003, output: 10, stopReason: "toolUse" },
  { input: 2004, output: 20, stopReason: "toolUse" },
  { input: 3005, output: 30 },
);

describe("the Usage a Run reports", () => {
  it("reports one record per model call, in the order the calls finished, with the daemon's fields", async () => {
    const { outcome } = await runAgainst(scriptedDaemon(settledRun("Done.", threeCalls)));

    assert.deepEqual(outcome, {
      ok: true,
      usage: [
        {
          provider: "mock",
          model: "mock-model",
          input: 1003,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1013,
          cost: 0,
        },
        {
          provider: "mock",
          model: "mock-model",
          input: 2004,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2024,
          cost: 0,
        },
        {
          provider: "mock",
          model: "mock-model",
          input: 3005,
          output: 30,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3035,
          cost: 0,
        },
      ],
    });
  });

  it("carries the cache counts, the daemon's total cost, and the provider and model as sent", async () => {
    const { outcome } = await runAgainst(
      scriptedDaemon(
        settledRun(
          "Done.",
          modelCalls({
            input: 100,
            output: 20,
            cacheRead: 300,
            cacheWrite: 5,
            cost: 0.25,
            provider: "anthropic",
            model: "claude-sonnet-4-5",
          }),
        ),
      ),
    );

    assert.deepEqual(outcome, {
      ok: true,
      usage: [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          input: 100,
          output: 20,
          cacheRead: 300,
          cacheWrite: 5,
          totalTokens: 425,
          cost: 0.25,
        },
      ],
    });
  });

  it("returns the calls that finished before the Run failed, the daemon's zero record for the refused call included", async () => {
    const { outcome } = await runAgainst(
      scriptedDaemon([
        { event: "chat", payload: { seq: 1, state: "status", phase: "preparing_workspace" } },
        ...modelCalls(
          { input: 1009, output: 10, stopReason: "toolUse" },
          { input: 2010, output: 20, stopReason: "toolUse" },
          refusedCall,
        ),
        {
          event: "chat",
          payload: {
            seq: 12,
            state: "error",
            stopReason: "timeout",
            errorMessage: "HTTP 500: the scripted model refuses the third call",
            errorKind: "timeout",
          },
        },
      ]),
    );

    assert.equal(outcome.ok, false);
    assert.match(failure(outcome), /HTTP 500: the scripted model refuses the third call/);
    assert.deepEqual(
      outcome.usage.map((report) => [report.input, report.output, report.totalTokens]),
      [
        [1009, 10, 1019],
        [2010, 20, 2030],
        [0, 0, 0],
      ],
    );
    assert.deepEqual(outcome.usage[2], {
      provider: "mock",
      model: "mock-model",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
    });
  });

  it("keeps what finished before an abort and waits for nothing after the aborted frame", async () => {
    const { outcome } = await runAgainst(
      scriptedDaemon([
        ...modelCalls({ input: 1014, output: 10, stopReason: "toolUse" }),
        { event: "chat", payload: { seq: 11, state: "aborted", stopReason: "rpc" } },
        // What the daemon sent after the aborted frame in every observed abort: two zero records.
        modelCall({ input: 0, output: 0, provider: "openclaw", model: "gateway-injected" }),
        modelCall({ input: 0, output: 0, stopReason: "aborted", content: [] }),
      ]),
    );

    assert.match(failure(outcome), /The Run was aborted/);
    assert.deepEqual(
      outcome.usage.map((report) => report.totalTokens),
      [1024],
    );
  });

  it("keeps what it collected when the daemon hangs up mid-Run", async () => {
    const { outcome } = await runAgainst(
      scriptedDaemon([
        ...modelCalls({ input: 1001, output: 10, stopReason: "toolUse" }),
        dropsTheConnection,
      ]),
    );

    assert.match(failure(outcome), /The connection closed/);
    assert.deepEqual(
      outcome.usage.map((report) => report.totalTokens),
      [1011],
    );
  });

  it("attributes a record by its run id and never by order, so another Run's records are not this Run's", async () => {
    const theirs = (input: number): Written => {
      const record = modelCall({ input, output: 1, provider: "theirs", model: "their-model" });
      const payload = record.payload as { message: Record<string, unknown> };
      return {
        ...record,
        payload: {
          sessionKey: "agent:main:somebody_else",
          agentId: "main",
          message: { ...payload.message, __openclaw: { runId: "1e000d20-not-ours" } },
        },
      };
    };
    const { outcome } = await runAgainst(
      scriptedDaemon(
        settledRun("Done.", [
          theirs(5000),
          ...modelCalls({ input: 1001, output: 10 }),
          theirs(6000),
        ]),
      ),
    );

    assert.deepEqual(
      outcome.usage.map((report) => [report.provider, report.totalTokens]),
      [["mock", 1011]],
    );
  });

  it("reports nothing for the Prompt's own user record or an assistant record carrying no usage", async () => {
    const { outcome } = await runAgainst(
      scriptedDaemon(
        settledRun("Done.", [
          ...modelCalls(),
          {
            event: "session.message",
            payload: {
              message: { role: "assistant", content: [{ type: "text", text: "no usage here" }] },
            },
          },
        ]),
      ),
    );

    assert.deepEqual(outcome, { ok: true, usage: [] });
  });

  it("counts a negative or fractional figure as nothing", async () => {
    const { outcome } = await runAgainst(
      scriptedDaemon(
        settledRun("Done.", [
          ...modelCalls({
            input: -5,
            output: 2.5,
            cacheRead: "9" as unknown as number,
            cacheWrite: 1,
            cost: -0.5,
          }),
        ]),
      ),
    );

    assert.deepEqual(outcome.usage[0], {
      provider: "mock",
      model: "mock-model",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 1,
      totalTokens: 1,
      cost: 0,
    });
  });

  it("never asks the daemon for its session-level usage, on success or on failure", async () => {
    const success = await runAgainst(scriptedDaemon(settledRun("Done.", threeCalls)));
    const failed = await runAgainst(
      scriptedDaemon([
        ...modelCalls(refusedCall),
        {
          event: "chat",
          payload: { seq: 12, state: "error", errorMessage: "LLM request failed." },
        },
      ]),
    );

    for (const { daemon } of [success, failed]) {
      assert.deepEqual(daemon.requests("sessions.usage"), []);
      assert.deepEqual(
        daemon.received.map((request) => request.method),
        ["connect", "sessions.messages.subscribe", "chat.send"],
      );
    }
  });
});

describe("the Usage the Signal Worker saves for an OpenClaw Run", () => {
  let database: TestDatabase;

  before(async () => {
    database = await createTestDatabase("openclaw-usage");
    await applySchema(database.db, signalsSchema);
  });

  after(() => database.drop());

  it("reads back through the Usage Component as a pi Run's does, on success and on failure", async () => {
    const db = database.db;
    const reply = scriptedDaemon();
    const byPrompt: DaemonReply = (request, connection) => {
      if (request.method !== "chat.send") return reply(request, connection);
      const frames =
        request.params.message === "spend then fail"
          ? [
              ...modelCalls({ input: 7, output: 0, stopReason: "toolUse" }, refusedCall),
              {
                event: "chat",
                payload: { seq: 12, state: "error", errorMessage: "LLM request failed." },
              },
            ]
          : settledRun("Done.", modelCalls({ input: 3, output: 0 }, { input: 4, output: 0 }));
      return scriptedDaemon(frames)(request, connection);
    };
    const daemon = await startFakeDaemon({ reply: byPrompt });
    running.push(daemon);
    const worker = createSignalWorker({
      db,
      runtime: createOpenClawRuntime({
        url: daemon.url,
        token: daemon.token,
        deviceKey,
        logger: silent,
      }),
      handlers: {
        charged: {
          handle: () => [
            { session: "user_alice", text: "for alice", userId: "alice" },
            { session: "user_bob", text: "spend then fail", userId: "bob" },
          ],
        },
      },
      logger: silent,
      sweepIntervalMs: 5,
    });
    await worker.start();
    try {
      const id = await db.tx((tx) => worker.emit(tx, { kind: "charged", payload: {} }));
      await waitUntil("the Signal reaches a terminal state", async () => {
        const [row] = await db.handle({ signals }).select().from(signals).where(eq(signals.id, id));
        return row?.state === "done" || row?.state === "failed";
      });
    } finally {
      await worker.stop();
    }

    const totals = createUsage({ db });
    assert.deepEqual(await totals.total({ userId: "alice" }), {
      input: 7,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 7,
      cost: 0,
      calls: 2,
    });
    assert.deepEqual(
      await totals.total({ userId: "bob" }),
      { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0, calls: 2 },
      "the failed Run's completed call and the daemon's zero record are both saved",
    );
    assert.equal(daemon.requests("sessions.usage").length, 0);
  });
});

function failure(outcome: RunOutcome): string {
  assert.equal(outcome.ok, false, `this Run should have failed; it was ${JSON.stringify(outcome)}`);
  return outcome.ok ? "" : outcome.error;
}
