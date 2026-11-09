import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, describe, it } from "node:test";
import type { RunOutcome } from "../signals/runtime.ts";
import {
  type FakeDaemon,
  type FakeDaemonOptions,
  scriptedDaemon,
  startFakeDaemon,
  type Written,
} from "../test-support/openclaw-daemon.ts";
import { createOpenClawRuntime, type OpenClawDaemon } from "./runtime.ts";

// Every way a Run fails under this Runtime is an ok: false outcome with a reason, never a throw.

const deviceKey = generateKeyPairSync("ed25519").privateKey;

const running: FakeDaemon[] = [];

after(async () => {
  await Promise.all(running.map((daemon) => daemon.close()));
});

async function daemonOf(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  const daemon = await startFakeDaemon(options);
  running.push(daemon);
  return daemon;
}

function runtimeFor(daemon: FakeDaemon, extra: Partial<OpenClawDaemon> = {}) {
  return createOpenClawRuntime({
    url: daemon.url,
    token: daemon.token,
    deviceKey,
    logger: silent,
    ...extra,
  });
}

function failure(outcome: RunOutcome): string {
  assert.equal(outcome.ok, false, `this Run should have failed; it was ${JSON.stringify(outcome)}`);
  return outcome.ok ? "" : outcome.error;
}

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

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

  // The connect refusal of daemon 2026.8.1 for a key it has never seen, as recorded.
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
    await waitFor(() => daemon.ended() === 1, "the refused connection should be closed");
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

async function waitFor(done: () => boolean, why: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (done()) return;
    await new Promise((later) => setTimeout(later, 5));
  }
  assert.fail(why);
}
