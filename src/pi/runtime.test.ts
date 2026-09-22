/**
 * One Run against an Agent Instance, over a real socket to a fake one.
 *
 * The fake is `../test-support/agent-instance.ts`: a TCP server speaking `pi`'s RPC framing, driven
 * by a script. That is the whole seam now — the Gateway starts nothing, so everything between "a
 * Prompt exists" and "a Run is recorded" is a connection, three commands and a stream of events, and
 * all of it is exercised here with no Docker, no image, no model and no network beyond loopback.
 *
 * What this file cannot prove is the one thing the design rests on: that `pi`'s `switch_session`
 * creates a Session at a path that does not exist and resumes one that does. A fake that was
 * scripted to do it would only pin our reading of the protocol. `./agent-instance.test.ts` drives
 * the real program and is where that claim lives.
 *
 * The assertions are on the **sequence** as much as on the outcome, because that is the property a
 * mistake breaks. A Run that prompts after a switch it did not check is a Prompt delivered into
 * whatever Session the instance was already in, and the outcome of such a Run is a perfectly
 * ordinary success.
 */

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

/** Where Sessions live as the Agent Instance sees them, which is the only path anything names. */
const sessionsDir = "/sessions";

const prompt: RunPrompt = { session: "user_42", text: "what happened?" };

/** Every fake started by a case, closed when the file is done. */
const running: FakeInstance[] = [];

after(async () => {
  await Promise.all(running.map((instance) => instance.close()));
});

/** A fake on loopback, and the Runtime pointed at it. */
async function instanceOf(reply: Reply): Promise<FakeInstance> {
  const instance = await startFakeInstance(reply);
  running.push(instance);
  return instance;
}

/** What the Runtime makes of one Run against `reply`, and what that fake saw. */
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

/** The failure of a Run that must have failed. */
function failure(outcome: RunOutcome): string {
  assert.equal(outcome.ok, false, `this Run should have failed; it was ${JSON.stringify(outcome)}`);
  return outcome.ok ? "" : outcome.error;
}

/** The commands a fake was sent, by type, which is what "in that order" is asserted on. */
function commandTypes(instance: FakeInstance): string[] {
  return instance.received.map((command) => command.type);
}

/** Nothing on the console: a Run logs at debug, and these cases run by the dozen. */
const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("the shape of one Run", () => {
  it("switches, verifies, prompts and reads to the settle, in that order", async () => {
    const { outcome, instance } = await runAgainst(scriptedInstance());

    assert.deepEqual(outcome, { ok: true });
    // Three commands and no fourth. Nothing asks the Agent Instance what model it holds, what
    // extensions it has or where its agent directory is: everything about it is the Operator's.
    assert.deepEqual(commandTypes(instance), ["switch_session", "get_state", "prompt"]);
  });

  it("addresses the Session as one file under the directory the Operator named", async () => {
    const { instance } = await runAgainst(scriptedInstance());

    assert.equal(instance.received[0]?.sessionPath, "/sessions/user_42.jsonl");
  });

  it("writes the Prompt as the message, byte for byte, whatever it starts with", async () => {
    // There is no argv any more, so the two treatments that made stdin the only safe channel are
    // gone with it: `pi` reads a leading `@word` on a command line as a file to include and refuses
    // an argument starting with `-`. A JSON string is a JSON string.
    for (const text of ["@file.md and more", "--help", "-p", "  leading space", "it's <b>&</b>"]) {
      const { instance } = await runAgainst(scriptedInstance(), { session: "user_42", text });
      assert.equal(instance.received[2]?.message, text);
    }
  });

  it("correlates every response by id rather than by arrival", async () => {
    const { instance } = await runAgainst(scriptedInstance());

    // Distinct, and per connection: a connection is per Run, so nothing is correlated across Runs.
    assert.deepEqual(
      instance.received.map((command) => command.id),
      ["1", "2", "3"],
    );
  });

  it("fails the Run when an answer carries another request's id, rather than matching it up", async () => {
    // The whole correlation claim, made testable: commands are never pipelined, so a response
    // arriving under some other id means the assumption underneath the channel is false. Reading it
    // as this command's answer is how a Run comes to be switched into a Session nobody asked for.
    const { outcome, instance } = await runAgainst((command) => [
      { type: "response", id: "99", command: command.type, success: true, data: {} },
    ]);

    assert.match(failure(outcome), /"99".*"1"|"1".*"99"/s);
    assert.deepEqual(commandTypes(instance), ["switch_session"]);
  });

  it("fails the Run when an answer carries the right id under another command's name", async () => {
    // The second correlation guard, and the one an id alone cannot make: an instance that numbers
    // its answers correctly and labels them wrongly is still an instance whose answers cannot be
    // read. `switch_session` and `get_state` differ in exactly the field the next step branches on,
    // so taking one for the other is a Prompt sent into an unverified Session.
    const { outcome, instance } = await runAgainst((command) => [
      { type: "response", id: command.id, command: "get_state", success: true, data: {} },
    ]);

    assert.match(failure(outcome), /"get_state".*"switch_session"|"switch_session".*"get_state"/s);
    assert.deepEqual(commandTypes(instance), ["switch_session"]);
  });

  it("closes the connection, whether the Run succeeded or failed", async () => {
    // With `socat ...,fork` every connection is a `pi` process, so one left open is one left
    // running. The Operator's listener started it and nothing else will reap it.
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
    // `success: true` with `cancelled: true`, which is the shape that would otherwise pass every
    // check: the command worked, and the switch did not happen. The agent is in some other Session,
    // and a Prompt sent now goes to it.
    const { outcome, instance } = await runAgainst(
      answering("switch_session", { cancelled: true }),
    );

    assert.match(failure(outcome), /cancelled/);
    assert.match(failure(outcome), /Session user_42/);
    assert.deepEqual(commandTypes(instance), ["switch_session"]);
  });

  it("is verified with get_state, and a disagreement fails the Run naming both paths", async () => {
    // Why the verification exists at all: `switch_session` is create-or-resume, which is
    // undocumented behaviour of `pi`'s that the whole design rests on. Reading `sessionFile` back is
    // what tells "it created the Session I named" apart from "it did something and reported
    // success".
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
    // The only failure `prompt` reports as a response: everything that goes wrong after acceptance
    // arrives in the event stream instead.
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

      assert.match(failure(outcome), /no text/);
      assert.equal(instance.connections(), 0);
    }
  });
});

describe("a Session name outside pi's grammar", () => {
  /** `pi`'s own `assertValidSessionId`, which this Runtime now carries a copy of. */
  const refused = ["../escape", "user:42", "a/b", "", ".", "..", "-leading", "trailing-", "a b"];
  const accepted = ["user_42", "a", "1", "run_01K9-x.y", "A.B_C-1"];

  it("fails that Run alone, naming the Session, and reaches the Agent Instance not at all", async () => {
    for (const session of refused) {
      const { outcome, instance } = await runAgainst(scriptedInstance(), {
        session,
        text: "hello",
      });

      assert.match(failure(outcome), new RegExp(`^Session ${escaped(session)} is not a name pi`));
      // Nothing was sent, which is the point: `pi` will open any path it is handed over RPC, so a
      // name that climbs would be a traversal rather than a refusal.
      assert.equal(instance.connections(), 0);
    }
  });

  it("lets through every name pi would take, so no deployment's Sessions are renamed", async () => {
    for (const session of accepted) {
      const { outcome, instance } = await runAgainst(scriptedInstance(), {
        session,
        text: "hello",
      });

      assert.deepEqual(outcome, { ok: true }, session);
      assert.equal(instance.received[0]?.sessionPath, `/sessions/${session}.jsonl`);
    }
  });
});

describe("the Agent Instance the Operator has to run", () => {
  it("is not reached at construction, so an unreachable one is not a boot failure", async () => {
    // The **Relay** precedent, and there is no startup probe: a remote thing the Operator runs is an
    // outage, and a Gateway that would not start takes every other Party's access down with the
    // agent's.
    assert.doesNotThrow(() =>
      createPiRuntime({ host: "127.0.0.1", port: 1, sessionsDir, logger: silent }),
    );
  });

  it("is a failed Run carrying the address when nothing is listening", async () => {
    const port = await unusedPort();
    const runtime = createPiRuntime({ host: "127.0.0.1", port, sessionsDir, logger: silent });

    const error = failure(await runtime.run(prompt));
    assert.match(error, /^Session user_42 could not reach the Agent Instance at 127\.0\.0\.1:/);
    assert.match(error, new RegExp(`127\\.0\\.0\\.1:${port}`));
  });

  it("is a failed Run saying the stream ended when it hangs up mid-Run", async () => {
    const { outcome } = await runAgainst(
      scriptedInstance([{ type: "agent_start" }, dropsTheConnection]),
    );

    assert.match(failure(outcome), /without an agent_settled record/);
  });

  it("says so as well when the connection fails rather than ending", async () => {
    // An RST rather than a FIN: the process died. The reader sees the same absence either way, so
    // without the socket's own word the two produce the same sentence.
    const { outcome } = await runAgainst(
      scriptedInstance([{ type: "agent_start" }, resetsTheConnection]),
    );

    const error = failure(outcome);
    assert.match(error, /without an agent_settled record/);
    assert.match(error, /connection failed/);
  });

  it("is a failed Run when it goes away before answering a command", async () => {
    const { outcome } = await runAgainst(() => [dropsTheConnection]);

    assert.match(failure(outcome), /without answering the switch_session command/);
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
    // The check the container-per-Run design could not make: it named no path at all, so a
    // deployment with the wrong one was a Gateway that started, served, and failed every Run.
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

    assert.deepEqual(await runtime.run(prompt), { ok: true });
    assert.equal(instance.received[0]?.sessionPath, "/srv/agent/sessions/user_42.jsonl");
  });
});

/** A fake that answers one command with `success: false` and drives the rest normally. */
function refusing(command: string, why: string): Reply {
  const healthy = scriptedInstance();
  return (received) =>
    received.type === command
      ? [{ type: "response", id: received.id, command, success: false, error: why }]
      : healthy(received);
}

/** A fake that answers one command successfully but with `data` of the test's choosing. */
function answering(command: string, data: Written): Reply {
  const healthy = scriptedInstance();
  return (received: Received) =>
    received.type === command
      ? [{ type: "response", id: received.id, command, success: true, data }]
      : healthy(received);
}

/** A regular expression's worth of a Session name, several of which are not literal. */
function escaped(session: string): string {
  return session.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** A TCP port nothing is listening on, taken and given back. */
async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((listening) => socket.listen(0, "127.0.0.1", listening));
  const address = socket.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  await new Promise<void>((closed) => socket.close(() => closed()));
  return address.port;
}

/** Waits for something the other end of a socket does, which is never synchronous with our side. */
async function waitFor(done: () => boolean, why: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (done()) return;
    await new Promise((later) => setTimeout(later, 5));
  }
  assert.fail(why);
}
