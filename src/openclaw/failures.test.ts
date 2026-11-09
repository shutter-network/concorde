import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scriptedDaemon, type Written } from "../test-support/openclaw-daemon.ts";
import { daemonOf, failure, runtimeFor } from "../test-support/openclaw-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";

describe("the Session names this Runtime refuses, before any connection", () => {
  const refused: readonly (readonly [name: string, rule: RegExp])[] = [
    ["", /must not be blank/],
    ["   ", /must not be blank/],
    ["\t\n", /must not be blank/],
    ["k".repeat(513), /512 characters/],
    [":", /colon/],
    ["a:b", /colon/],
    ["agent:main:user_42", /colon/],
    ["subagent:x", /colon/],
    ["cron:x", /colon/],
    ["acp:x", /colon/],
    ["main", /main/],
    ["global", /global/],
    ["User_42", /uppercase/],
    ["ALLCAPS", /uppercase/],
    ["Ünïcödé", /uppercase/],
    [" padded", /leading or trailing whitespace/],
    ["padded ", /leading or trailing whitespace/],
    ["\tpadded", /leading or trailing whitespace/],
  ];

  it("fails the Run with the rule the name broke and never reaches the daemon", async () => {
    const daemon = await daemonOf({ reply: scriptedDaemon() });
    const runtime = runtimeFor(daemon);

    for (const [session, rule] of refused) {
      const outcome = await runtime.run({ session, text: "hello" });

      assert.match(failure(outcome), rule, JSON.stringify(session));
      assert.deepEqual(outcome.usage, [], JSON.stringify(session));
    }
    assert.equal(daemon.connections.length, 0);
  });
});

describe("the Session names this Runtime passes through", () => {
  const accepted = [
    "user_42",
    "a.b.c",
    "a-b-c",
    "a/b",
    "user 42",
    "ünïcödé",
    "incognito-x",
    "k".repeat(512),
    "run_ce044349-91cf-4c30-9b15-4fbdec41dc30",
    "mainframe",
    "globals",
  ];

  it("sends each verbatim as the session key, prefixing and folding nothing", async () => {
    for (const session of accepted) {
      const daemon = await daemonOf({ reply: scriptedDaemon() });

      const outcome = await runtimeFor(daemon).run({ session, text: "hello" });

      assert.deepEqual(outcome, { ok: true, usage: [] }, JSON.stringify(session));
      assert.equal(daemon.requests("chat.send")[0]?.params.sessionKey, session);
      assert.equal(daemon.requests("sessions.messages.subscribe")[0]?.params.key, session);
    }
  });
});

describe("a device the daemon has not approved", () => {
  const requestId = "a36286de-6964-416c-9feb-1d9cc78e61a2";

  // Captured pairing refusal from OpenClaw daemon 2026.8.1.
  const pairingRequired = (params: Written): Written | undefined => {
    const device = params.device;
    const deviceId =
      typeof device === "object" && device !== null ? (device as { id?: unknown }).id : undefined;
    return {
      code: "NOT_PAIRED",
      message: `device pairing required (requestId: ${requestId})`,
      details: {
        code: "PAIRING_REQUIRED",
        reason: "not-paired",
        requestId,
        remediationHint: "Approve this device from the pending pairing requests.",
        deviceId,
        requestedRole: "operator",
        requestedScopes: ["operator.read", "operator.write"],
      },
    };
  };

  it("fails the Run with the request id and the approve command for the daemon host", async () => {
    const daemon = await daemonOf({ reply: scriptedDaemon(), refuseConnect: pairingRequired });

    const outcome = await runtimeFor(daemon).run({ session: "user_42", text: "hello" });

    const error = failure(outcome);
    assert.match(error, /^Session user_42: Cannot connect to the OpenClaw daemon at ws:/);
    assert.match(error, /not approved/);
    assert.ok(error.includes(requestId), error);
    assert.ok(error.includes(`openclaw devices approve ${requestId}`), error);
    assert.match(error, /daemon host/);
    assert.deepEqual(outcome.usage, []);
  });

  it("sends nothing after the refusal and leaves no connection open", async () => {
    const daemon = await daemonOf({ reply: scriptedDaemon(), refuseConnect: pairingRequired });

    await runtimeFor(daemon).run({ session: "user_42", text: "hello" });

    assert.deepEqual(
      daemon.received.map((request) => request.method),
      ["connect"],
    );
    await waitUntil("the refused connection is closed", async () => daemon.ended() === 1);
    assert.equal(daemon.open(), 0);
  });
});

describe("the usageLimit a Prompt carries", () => {
  it("fails the Run before any connection when it is not a positive whole number", async () => {
    const daemon = await daemonOf({ reply: scriptedDaemon() });
    const runtime = runtimeFor(daemon);

    for (const usageLimit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const outcome = await runtime.run({ session: "user_42", text: "hello", usageLimit });

      assert.match(
        failure(outcome),
        /^Session user_42: usageLimit must be a positive whole number/,
        String(usageLimit),
      );
    }
    assert.equal(daemon.connections.length, 0);
  });
});
