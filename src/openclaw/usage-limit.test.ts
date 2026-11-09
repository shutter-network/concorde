import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunOutcome, RunPrompt } from "../signals/runtime.ts";
import {
  abortableDaemon,
  abortedFrames,
  type DaemonReply,
  type FakeDaemon,
  type ModelCall,
  modelCalls,
  scriptedDaemon,
  settledRun,
} from "../test-support/openclaw-daemon.ts";
import { daemonOf, runtimeFor } from "../test-support/openclaw-runtime.ts";

async function runAgainst(
  reply: DaemonReply,
  prompt: RunPrompt,
  agentId?: string,
): Promise<{ outcome: RunOutcome; daemon: FakeDaemon }> {
  const agent = agentId === undefined ? {} : { agentId };
  const daemon = await daemonOf({ reply, ...agent });
  return { outcome: await runtimeFor(daemon, agent).run(prompt), daemon };
}

const fourCalls: readonly ModelCall[] = [
  { input: 1003, output: 10, stopReason: "toolUse" },
  { input: 2004, output: 20, stopReason: "toolUse" },
  { input: 3005, output: 30, stopReason: "toolUse" },
  { input: 4006, output: 40 },
];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("a Run with a Usage limit", () => {
  it("sends the daemon's abort the moment a call's record takes the total past the limit, and fails the Run as limited with every report so far", async () => {
    const { outcome, daemon } = await runAgainst(abortableDaemon(fourCalls), {
      session: "user_42",
      text: "spend",
      usageLimit: 5000,
    });

    assert.deepEqual(withoutUsage(outcome), {
      ok: false,
      error: "Session user_42: Usage limit reached: 6072 of 5000 tokens",
      limited: true,
    });
    assert.deepEqual(
      outcome.usage.map((report) => report.totalTokens),
      [1013, 2024, 3035],
      "the three calls that finished; the fourth never started and the zero records after the aborted frame are not waited for",
    );
    const aborts = daemon.requests("chat.abort");
    assert.equal(aborts.length, 1, "one abort, sent once");
    assert.equal(aborts[0]?.params.sessionKey, "user_42");
    assert.match(String(aborts[0]?.params.runId), uuid);
    assert.equal("agentId" in (aborts[0]?.params ?? {}), false);
    assert.deepEqual(
      daemon.received.map((request) => request.method),
      ["connect", "sessions.messages.subscribe", "chat.send", "chat.abort"],
    );
  });

  it("names the configured agent in the abort, as it did in the Prompt", async () => {
    const { outcome, daemon } = await runAgainst(
      abortableDaemon(fourCalls),
      { session: "user_42", text: "spend", usageLimit: 1000 },
      "concorde",
    );

    assert.equal(outcome.ok === false && outcome.limited, true);
    assert.deepEqual(
      outcome.usage.map((report) => report.totalTokens),
      [1013],
    );
    const [abort] = daemon.requests("chat.abort");
    assert.equal(abort?.params.sessionKey, "user_42");
    assert.equal(abort?.params.agentId, "concorde");
    assert.match(String(abort?.params.runId), uuid);
  });

  it("lets a Run that reaches its limit exactly, or stays under it, finish with no abort sent", async () => {
    for (const usageLimit of [6072, 1_000_000]) {
      const { outcome, daemon } = await runAgainst(
        scriptedDaemon(settledRun("Done.", modelCalls(...fourCalls.slice(0, 3)))),
        { session: "user_42", text: "spend", usageLimit },
      );

      assert.deepEqual(withoutUsage(outcome), { ok: true });
      assert.equal(outcome.usage.length, 3);
      assert.deepEqual(daemon.requests("chat.abort"), []);
    }
  });

  it("stays limited when the last call crossed the limit and the Run finished before the abort landed", async () => {
    const { outcome, daemon } = await runAgainst(abortableDaemon(fourCalls), {
      session: "user_42",
      text: "spend",
      usageLimit: 10_000,
    });

    assert.deepEqual(withoutUsage(outcome), {
      ok: false,
      error:
        "Session user_42: Usage limit reached: 10118 of 10000 tokens; the Run finished before the abort landed",
      limited: true,
    });
    assert.equal(outcome.usage.length, 4);
    assert.equal(daemon.requests("chat.abort").length, 1);
  });

  it("fails a Run the daemon aborted for a reason of its own as aborted, not as limited", async () => {
    const { outcome, daemon } = await runAgainst(
      scriptedDaemon([...modelCalls(fourCalls[0] as ModelCall), ...abortedFrames()]),
      { session: "user_42", text: "spend", usageLimit: 1_000_000 },
    );

    assert.deepEqual(withoutUsage(outcome), {
      ok: false,
      error: "Session user_42: The Run was aborted",
    });
    assert.deepEqual(
      outcome.usage.map((report) => report.totalTokens),
      [1013],
    );
    assert.deepEqual(daemon.requests("chat.abort"), []);
  });
});

function withoutUsage(outcome: RunOutcome): Omit<RunOutcome, "usage"> {
  const { usage: _, ...rest } = outcome;
  return rest;
}
