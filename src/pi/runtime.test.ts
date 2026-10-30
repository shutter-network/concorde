import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, describe, it } from "node:test";
import type { RunOutcome, RunPrompt } from "../signals/runtime.ts";
import {
  dropsTheConnection,
  type FakeInstance,
  type Received,
  type Reply,
  resetsTheConnection,
  scriptedInstance,
  startFakeInstance,
  type Written,
} from "../test-support/agent-instance.ts";
import { createPiRuntime } from "./runtime.ts";

const sessionsDir = "/sessions";

const prompt: RunPrompt = { session: "user_42", text: "what happened?" };

const running: FakeInstance[] = [];

after(async () => {
  await Promise.all(running.map((instance) => instance.close()));
});

async function instanceOf(reply: Reply): Promise<FakeInstance> {
  const instance = await startFakeInstance(reply);
  running.push(instance);
  return instance;
}

async function runAgainst(
  reply: Reply,
  given: RunPrompt = prompt,
): Promise<{ outcome: RunOutcome; instance: FakeInstance }> {
  const instance = await instanceOf(reply);
  const runtime = createPiRuntime({
    host: instance.host,
    port: instance.port,
    sessionsDir,
    logger: silent,
  });
  return { outcome: await runtime.run(given), instance };
}

function failure(outcome: RunOutcome): string {
  assert.equal(outcome.ok, false, `this Run should have failed; it was ${JSON.stringify(outcome)}`);
  return outcome.ok ? "" : outcome.error;
}

function withoutUsage({ usage: _, ...rest }: RunOutcome): Omit<RunOutcome, "usage"> {
  return rest;
}

function commandTypes(instance: FakeInstance): string[] {
  return instance.received.map((command) => command.type);
}

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("the shape of one Run", () => {
  it("switches, verifies, prompts and reads to the settle, in that order", async () => {
    const { outcome, instance } = await runAgainst(scriptedInstance());

    assert.deepEqual(withoutUsage(outcome), { ok: true });
    assert.deepEqual(commandTypes(instance), ["switch_session", "get_state", "prompt"]);
  });

  it("addresses the Session as one file under the directory the Operator named", async () => {
    const { instance } = await runAgainst(scriptedInstance());

    assert.equal(instance.received[0]?.sessionPath, "/sessions/user_42.jsonl");
  });

  it("writes the Prompt as the message, byte for byte, whatever it starts with", async () => {
    for (const text of ["@file.md and more", "--help", "-p", "  leading space", "it's <b>&</b>"]) {
      const { instance } = await runAgainst(scriptedInstance(), { session: "user_42", text });
      assert.equal(instance.received[2]?.message, text);
    }
  });

  it("correlates every response by id rather than by arrival", async () => {
    const { instance } = await runAgainst(scriptedInstance());

    assert.deepEqual(
      instance.received.map((command) => command.id),
      ["1", "2", "3"],
    );
  });

  it("fails the Run when an answer carries another request's id, rather than matching it up", async () => {
    const { outcome, instance } = await runAgainst((command) => [
      { type: "response", id: "99", command: command.type, success: true, data: {} },
    ]);

    assert.match(failure(outcome), /"99".*"1"|"1".*"99"/s);
    assert.deepEqual(commandTypes(instance), ["switch_session"]);
  });

  it("fails the Run when an answer carries the right id under another command's name", async () => {
    const { outcome, instance } = await runAgainst((command) => [
      { type: "response", id: command.id, command: "get_state", success: true, data: {} },
    ]);

    assert.match(failure(outcome), /"get_state".*"switch_session"|"switch_session".*"get_state"/s);
    assert.deepEqual(commandTypes(instance), ["switch_session"]);
  });

  it("closes the connection, whether the Run succeeded or failed", async () => {
    for (const reply of [scriptedInstance(), refusing("prompt", "already streaming")]) {
      const { instance } = await runAgainst(reply);
      assert.equal(instance.connections(), 1);
      await waitFor(() => instance.ended() === 1, "the connection should have been closed");
    }
  });

  it("opens one connection per Run and holds none between them", async () => {
    const instance = await instanceOf(scriptedInstance());
    const runtime = createPiRuntime({
      host: instance.host,
      port: instance.port,
      sessionsDir,
      logger: silent,
    });

    await runtime.run(prompt);
    await runtime.run({ session: "user_7", text: "and then?" });

    assert.equal(instance.connections(), 2);
    assert.deepEqual(commandTypes(instance), [
      "switch_session",
      "get_state",
      "prompt",
      "switch_session",
      "get_state",
      "prompt",
    ]);
  });
});

describe("the switch, which is the step everything else assumes", () => {
  it("fails the Run and never prompts when the Agent Instance refuses it", async () => {
    const { outcome, instance } = await runAgainst(refusing("switch_session", "no such directory"));

    assert.match(failure(outcome), /\/sessions\/user_42\.jsonl.*no such directory/s);
    assert.deepEqual(commandTypes(instance), ["switch_session"]);
  });

  it("fails the Run and never prompts when an extension cancelled it", async () => {
    const { outcome, instance } = await runAgainst(
      answering("switch_session", { cancelled: true }),
    );

    assert.match(failure(outcome), /cancelled/);
    assert.match(failure(outcome), /Session user_42/);
    assert.deepEqual(commandTypes(instance), ["switch_session"]);
  });

  it("is verified with get_state, and a disagreement fails the Run naming both paths", async () => {
    const { outcome, instance } = await runAgainst(
      answering("get_state", { sessionFile: "/sessions/somebody-else.jsonl" }),
    );

    const error = failure(outcome);
    assert.match(error, /\/sessions\/user_42\.jsonl/);
    assert.match(error, /\/sessions\/somebody-else\.jsonl/);
    assert.deepEqual(commandTypes(instance), ["switch_session", "get_state"]);
  });

  it("fails the Run when get_state names no file at all", async () => {
    const { outcome } = await runAgainst(answering("get_state", { isStreaming: false }));

    assert.match(failure(outcome), /\/sessions\/user_42\.jsonl/);
  });
});

describe("the Prompt", () => {
  it("fails the Run when the Agent Instance rejects it before accepting it", async () => {
    const { outcome, instance } = await runAgainst(refusing("prompt", "already streaming"));

    assert.match(failure(outcome), /already streaming/);
    assert.deepEqual(commandTypes(instance), ["switch_session", "get_state", "prompt"]);
  });

  it("is refused when it is empty, without opening a connection at all", async () => {
    for (const text of ["", "   ", "\n\n"]) {
      const { outcome, instance } = await runAgainst(scriptedInstance(), {
        session: "user_42",
        text,
      });

      assert.match(failure(outcome), /must not be blank/);
      assert.equal(instance.connections(), 0);
    }
  });
});

describe("a Session name outside pi's grammar", () => {
  const refused = ["../escape", "user:42", "a/b", "", ".", "..", "-leading", "trailing-", "a b"];
  const accepted = ["user_42", "a", "1", "run_01K9-x.y", "A.B_C-1"];

  it("fails that Run alone, naming the Session, and reaches the Agent Instance not at all", async () => {
    for (const session of refused) {
      const { outcome, instance } = await runAgainst(scriptedInstance(), {
        session,
        text: "hello",
      });

      assert.match(
        failure(outcome),
        new RegExp(`^Session ${escaped(session)}: Invalid session name`),
      );
      assert.equal(instance.connections(), 0);
    }
  });

  it("lets through every name pi would take, so no deployment's Sessions are renamed", async () => {
    for (const session of accepted) {
      const { outcome, instance } = await runAgainst(scriptedInstance(), {
        session,
        text: "hello",
      });

      assert.deepEqual(withoutUsage(outcome), { ok: true }, session);
      assert.equal(instance.received[0]?.sessionPath, `/sessions/${session}.jsonl`);
    }
  });
});

describe("the Agent Instance the Operator has to run", () => {
  it("is not reached at construction, so an unreachable one is not a boot failure", async () => {
    assert.doesNotThrow(() =>
      createPiRuntime({ host: "127.0.0.1", port: 1, sessionsDir, logger: silent }),
    );
  });

  it("is a failed Run carrying the address when nothing is listening", async () => {
    const port = await unusedPort();
    const runtime = createPiRuntime({ host: "127.0.0.1", port, sessionsDir, logger: silent });

    const error = failure(await runtime.run(prompt));
    assert.match(error, /^Session user_42: Cannot connect to agent instance at 127\.0\.0\.1:/);
    assert.match(error, new RegExp(`127\\.0\\.0\\.1:${port}`));
  });

  it("is a failed Run saying the stream ended when it hangs up mid-Run", async () => {
    const { outcome } = await runAgainst(
      scriptedInstance([{ type: "agent_start" }, dropsTheConnection]),
    );

    assert.match(failure(outcome), /without agent_settled/);
  });

  it("says so as well when the connection fails rather than ending", async () => {
    const { outcome } = await runAgainst(
      scriptedInstance([{ type: "agent_start" }, resetsTheConnection]),
    );

    const error = failure(outcome);
    assert.match(
      error,
      /^Session user_42: (No records received|Stream ended after \d+ records without agent_settled)/,
    );
    assert.match(error, /The connection failed: .*ECONNRESET/);
  });

  it("is a failed Run when it goes away before answering a command", async () => {
    const { outcome } = await runAgainst(() => [dropsTheConnection]);

    assert.match(failure(outcome), /before answering switch_session/);
  });
});

describe("the sessionsDir an Operator declares", () => {
  it("is required, because every Run names a file under it", () => {
    for (const missing of [undefined, "", "   "]) {
      assert.throws(
        () =>
          createPiRuntime({
            host: "agent",
            port: 4000,
            sessionsDir: missing as unknown as string,
          }),
        /sessionsDir/,
        JSON.stringify(missing),
      );
    }
  });

  it("must be absolute, refused where the Operator wrote it rather than at the first Run", () => {
    for (const relative of ["sessions", "./sessions", "../sessions", "sessions/nested"]) {
      assert.throws(
        () => createPiRuntime({ host: "agent", port: 4000, sessionsDir: relative }),
        /absolute/,
        relative,
      );
    }
  });

  it("takes any absolute path, including one with a trailing slash", async () => {
    const instance = await instanceOf(scriptedInstance());
    const runtime = createPiRuntime({
      host: instance.host,
      port: instance.port,
      sessionsDir: "/srv/agent/sessions/",
      logger: silent,
    });

    assert.deepEqual(withoutUsage(await runtime.run(prompt)), { ok: true });
    assert.equal(instance.received[0]?.sessionPath, "/srv/agent/sessions/user_42.jsonl");
  });
});

describe("the usage a Run reports", () => {
  const spending = (stopReason: string): Written => ({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "mock",
      model: "mock-1",
      stopReason,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    },
  });

  it("returns each model call in the outcome of a Run that succeeds", async () => {
    const { outcome } = await runAgainst(
      scriptedInstance([spending("toolUse"), spending("stop"), { type: "agent_settled" }]),
    );

    assert.equal(outcome.ok, true);
    assert.deepEqual(
      outcome.usage.map((report) => report.totalTokens),
      [15, 15],
    );
  });

  it("returns the calls made before pi hung up", async () => {
    const { outcome } = await runAgainst(
      scriptedInstance([spending("toolUse"), dropsTheConnection]),
    );

    assert.match(failure(outcome), /without agent_settled/);
    assert.equal(outcome.usage.length, 1);
  });

  it("returns no usage for a Run refused before it reached the model", async () => {
    const { outcome } = await runAgainst(scriptedInstance(), { ...prompt, text: " " });

    assert.match(failure(outcome), /blank/);
    assert.deepEqual(outcome.usage, []);
  });
});

function refusing(command: string, why: string): Reply {
  const healthy = scriptedInstance();
  return (received) =>
    received.type === command
      ? [{ type: "response", id: received.id, command, success: false, error: why }]
      : healthy(received);
}

function answering(command: string, data: Written): Reply {
  const healthy = scriptedInstance();
  return (received: Received) =>
    received.type === command
      ? [{ type: "response", id: received.id, command, success: true, data }]
      : healthy(received);
}

function escaped(session: string): string {
  return session.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (done()) return;
    await new Promise((later) => setTimeout(later, 5));
  }
  assert.fail(why);
}
