import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { after, describe, it } from "node:test";
import type { RunOutcome, RunPrompt } from "../signals/runtime.ts";
import {
  type DaemonReply,
  dropsTheConnection,
  type FakeDaemon,
  type FakeDaemonOptions,
  scriptedDaemon,
  settledRun,
  startFakeDaemon,
  type Written,
} from "../test-support/openclaw-daemon.ts";
import { createOpenClawRuntime, type OpenClawDaemon } from "./runtime.ts";

const prompt: RunPrompt = { session: "user_42", text: "what happened?" };

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

async function runAgainst(
  reply: DaemonReply = scriptedDaemon(),
  given: RunPrompt = prompt,
  extra: Partial<OpenClawDaemon> = {},
): Promise<{ outcome: RunOutcome; daemon: FakeDaemon }> {
  const daemon = await daemonOf({ reply });
  const outcome = await runtimeFor(daemon, extra).run(given);
  return { outcome, daemon };
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

describe("the shape of one Run", () => {
  it("returns ok with no usage once the daemon sends the Run's final frame", async () => {
    const { outcome } = await runAgainst();

    assert.deepEqual(outcome, { ok: true, usage: [] });
  });

  it("opens one connection and signs the daemon's challenge with the device key", async () => {
    const { daemon } = await runAgainst();

    assert.equal(daemon.connections.length, 1);
    assert.equal(daemon.connections[0]?.auth?.signatureValid, true);
    assert.equal(daemon.connections[0]?.auth?.token, daemon.token);
  });

  it("asks for the scopes a Run needs, since a token-only connection is accepted and then refused", async () => {
    const { daemon } = await runAgainst();

    assert.deepEqual(daemon.connections[0]?.auth?.scopes, ["operator.read", "operator.write"]);
  });

  it("subscribes to the Session's messages before sending, in that order", async () => {
    const { daemon } = await runAgainst();

    assert.deepEqual(
      daemon.received.map((request) => request.method),
      ["connect", "sessions.messages.subscribe", "chat.send"],
    );
    assert.equal(daemon.requests("sessions.messages.subscribe")[0]?.params.key, "user_42");
  });

  it("sends the Prompt text into the named Session with delivery switched off", async () => {
    const { daemon } = await runAgainst();

    const sent = daemon.requests("chat.send")[0]?.params;
    assert.equal(sent?.message, "what happened?");
    assert.equal(sent?.sessionKey, "user_42");
    assert.equal(sent?.deliver, false);
    assert.equal(typeof sent?.idempotencyKey, "string");
  });

  it("names the OpenClaw agent on both requests when the Operator configured one, and otherwise not", async () => {
    const configured = await runAgainst(scriptedDaemon(), prompt, { agentId: "concorde" });
    assert.equal(
      configured.daemon.requests("sessions.messages.subscribe")[0]?.params.agentId,
      "concorde",
    );
    assert.equal(configured.daemon.requests("chat.send")[0]?.params.agentId, "concorde");

    const unconfigured = await runAgainst();
    assert.equal("agentId" in (unconfigured.daemon.requests("chat.send")[0]?.params ?? {}), false);
  });

  it("closes the connection when the Run ends, whether it succeeded or failed", async () => {
    for (const reply of [scriptedDaemon(), scriptedDaemon(failedRun("LLM request failed."))]) {
      const { daemon } = await runAgainst(reply);
      assert.equal(daemon.connections.length, 1);
      await waitFor(() => daemon.ended() === 1, "the connection should have been closed");
    }
  });

  it("holds two connections at once for two Runs into two Sessions started together", async () => {
    const gates = new Map<string, PromiseWithResolvers<void>>();
    const gate = (session: string): PromiseWithResolvers<void> => {
      let held = gates.get(session);
      if (held === undefined) {
        held = Promise.withResolvers<void>();
        gates.set(session, held);
      }
      return held;
    };
    const scripted = scriptedDaemon();
    const holding: DaemonReply = async function* (request, connection) {
      const frames = scripted(request, connection);
      if (request.method !== "chat.send") {
        yield* frames;
        return;
      }
      const [ack, ...rest] = frames;
      if (ack !== undefined) yield ack;
      await gate(String(request.params.sessionKey)).promise;
      yield* rest;
    };
    const daemon = await daemonOf({ reply: holding });
    const runtime = runtimeFor(daemon);

    const first = runtime.run({ session: "user_1", text: "first" });
    const second = runtime.run({ session: "user_2", text: "second" });
    await waitFor(() => daemon.requests("chat.send").length === 2, "both Runs should have started");
    assert.equal(daemon.open(), 2);

    gate("user_1").resolve();
    gate("user_2").resolve();
    assert.deepEqual(await Promise.all([first, second]), [
      { ok: true, usage: [] },
      { ok: true, usage: [] },
    ]);
    assert.equal(daemon.connections.length, 2);
  });
});

describe("the frames the daemon broadcasts", () => {
  const somebodyElse = (state: string): Written => ({
    event: "chat",
    payload: {
      runId: "1e000d20-not-ours",
      sessionKey: "agent:main:other",
      seq: 9,
      state,
      errorMessage: "not ours",
    },
  });

  it("ignores another Run's error, since every connection sees every Run's frames", async () => {
    const { outcome } = await runAgainst(scriptedDaemon([somebodyElse("error"), ...settledRun()]));

    assert.deepEqual(outcome, { ok: true, usage: [] });
  });

  it("ignores another Run's final frame rather than ending this Run on it", async () => {
    const { outcome } = await runAgainst(
      scriptedDaemon([somebodyElse("final"), ...failedRun("LLM request failed.")]),
    );

    assert.match(failure(outcome), /LLM request failed/);
  });

  it("fails the Run with the daemon's message on the first error frame, and ignores the second", async () => {
    const { outcome } = await runAgainst(
      scriptedDaemon([
        ...failedRun("HTTP 500: the scripted model refuses the second call"),
        {
          event: "chat",
          payload: {
            seq: 1,
            state: "error",
            errorMessage:
              "⚠️ Agent failed before reply: HTTP 500: the scripted model refuses the second call.",
          },
        },
      ]),
    );

    assert.equal(
      failure(outcome),
      "Session user_42: The agent failed: HTTP 500: the scripted model refuses the second call",
    );
    assert.deepEqual(outcome.usage, []);
  });

  it("fails the Run when the daemon reports it aborted", async () => {
    const { outcome } = await runAgainst(
      scriptedDaemon([{ event: "chat", payload: { seq: 6, state: "aborted", stopReason: "rpc" } }]),
    );

    assert.match(failure(outcome), /^Session user_42: The Run was aborted/);
  });
});

describe("the Prompt and the Session name, before any connection", () => {
  it("fails a blank Prompt without reaching the daemon", async () => {
    for (const text of ["", "   ", "\n\n"]) {
      const { outcome, daemon } = await runAgainst(scriptedDaemon(), { session: "user_42", text });

      assert.match(failure(outcome), /^Session user_42: Prompt text must not be blank/);
      assert.equal(daemon.connections.length, 0);
    }
  });

  it("fails a blank Session name without reaching the daemon", async () => {
    for (const session of ["", "  "]) {
      const { outcome, daemon } = await runAgainst(scriptedDaemon(), { session, text: "hello" });

      assert.match(failure(outcome), /Session name must not be blank/);
      assert.equal(daemon.connections.length, 0);
    }
  });

  it("passes the name through verbatim as the session key, prefixing nothing", async () => {
    for (const session of ["user_42", "run_01K9-x.y", "a.b.c"]) {
      const { outcome, daemon } = await runAgainst(scriptedDaemon(), { session, text: "hello" });

      assert.deepEqual(outcome, { ok: true, usage: [] }, session);
      assert.equal(daemon.requests("chat.send")[0]?.params.sessionKey, session);
      assert.equal(daemon.requests("sessions.messages.subscribe")[0]?.params.key, session);
    }
  });
});

describe("the fresh Session the Signal Worker mints", () => {
  it("is accepted by name, so a Prompt asking for a fresh Session works under this Runtime", async () => {
    const session = `run_${randomUUID()}`;
    const { outcome, daemon } = await runAgainst(scriptedDaemon(), { session, text: "hello" });

    assert.deepEqual(outcome, { ok: true, usage: [] }, session);
    assert.equal(daemon.requests("chat.send")[0]?.params.sessionKey, session);
  });
});

describe("the device key an Operator declares", () => {
  const sound: Omit<OpenClawDaemon, "deviceKey"> = {
    url: "ws://127.0.0.1:1",
    token: "shared",
    logger: silent,
  };

  it("must be an Ed25519 private key, refused at construction rather than at the first Run", () => {
    const wrongKind = [
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
      generateKeyPairSync("x25519").privateKey,
    ];
    for (const deviceKey of wrongKind) {
      assert.throws(
        () => createOpenClawRuntime({ ...sound, deviceKey }),
        /Ed25519/,
        deviceKey.asymmetricKeyType,
      );
    }
  });

  it("must be the private half, since the public one cannot sign the challenge", () => {
    const publicKey = generateKeyPairSync("ed25519").publicKey;

    assert.throws(() => createOpenClawRuntime({ ...sound, deviceKey: publicKey }), /private/);
  });

  it("must be a KeyObject, not a PEM string or anything else", () => {
    for (const notAKey of [undefined, "-----BEGIN PRIVATE KEY-----", 42, {}]) {
      assert.throws(
        () => createOpenClawRuntime({ ...sound, deviceKey: notAKey as unknown as KeyObject }),
        /deviceKey/,
        JSON.stringify(notAKey),
      );
    }
  });

  it("is accepted when it is an Ed25519 private key, and nothing is reached at construction", () => {
    assert.doesNotThrow(() => createOpenClawRuntime({ ...sound, deviceKey }));
  });
});

describe("the daemon the Operator has to run", () => {
  it("is a failed Run naming the address when nothing is listening", async () => {
    const port = await unusedPort();
    const runtime = createOpenClawRuntime({
      url: `ws://127.0.0.1:${port}`,
      token: "shared",
      deviceKey,
      logger: silent,
    });

    const error = failure(await runtime.run(prompt));
    assert.match(
      error,
      new RegExp(
        `^Session user_42: Cannot connect to the OpenClaw daemon at ws://127\\.0\\.0\\.1:${port}`,
      ),
    );
  });

  it("is a failed Run carrying the daemon's refusal when the shared token is wrong", async () => {
    const { outcome, daemon } = await runAgainst(scriptedDaemon(), prompt, { token: "not-it" });

    assert.match(failure(outcome), /Cannot connect to the OpenClaw daemon .*token mismatch/);
    assert.deepEqual(
      daemon.received.map((request) => request.method),
      ["connect"],
    );
    await waitFor(() => daemon.ended() === 1, "the refused connection should be closed");
  });

  it("is a failed Run when the daemon hangs up before the Run ends", async () => {
    const { outcome } = await runAgainst(
      scriptedDaemon([
        { event: "chat", payload: { seq: 1, state: "status", phase: "preparing_workspace" } },
        dropsTheConnection,
      ]),
    );

    assert.match(failure(outcome), /^Session user_42: The connection closed/);
  });
});

function failedRun(errorMessage: string): readonly Written[] {
  return [
    { event: "chat", payload: { seq: 1, state: "status", phase: "preparing_workspace" } },
    {
      event: "chat",
      payload: {
        seq: 12,
        state: "error",
        stopReason: "timeout",
        errorMessage,
        errorKind: "timeout",
      },
    },
  ];
}

async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((listening) => socket.listen(0, "127.0.0.1", listening));
  const address = socket.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  await new Promise<void>((closed) => socket.close(() => closed()));
  return address.port;
}

async function waitFor(done: () => boolean, why: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (done()) return;
    await new Promise((later) => setTimeout(later, 5));
  }
  assert.fail(why);
}
