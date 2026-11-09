import { type KeyObject, KeyObject as KeyObjectClass, randomUUID } from "node:crypto";
import type { ChatEvent } from "@openclaw/gateway-protocol";
import { defaultLogger, type Logger } from "../logging/index.ts";
import type { RunOutcome, RunPrompt, Runtime } from "../signals/runtime.ts";
import { type Connection, deviceIdentityOf, openConnection } from "./connection.ts";

export type OpenClawDaemon = {
  /** `ws://` for a private network, `wss://` for everything else. */
  readonly url: string;
  /** The daemon's shared token, `gateway.auth.token` in its configuration. */
  readonly token: string;
  /** The Ed25519 private key the daemon knows this Gateway by; approved once on the daemon host. */
  readonly deviceKey: KeyObject;
  /** The OpenClaw agent Runs go to. Omit when the daemon hosts one agent. */
  readonly agentId?: string;
  readonly logger?: Logger;
};

/**
 * Connects to an Operator-run OpenClaw daemon once per Run, over the daemon's own WebSocket
 * protocol. It does not start the daemon or configure its model, credentials, tools, workspace or
 * channels: the Operator owns all of that, and every Run shares the one daemon process.
 *
 * Each Run opens one connection, signs the daemon's challenge with `deviceKey`, subscribes to the
 * Session, sends the Prompt with delivery switched off, follows the Run's `chat` frames to the
 * first `final`, `error` or `aborted` one and closes the connection. Runs the Signal Worker starts
 * together hold separate connections. The agent's reply goes nowhere: with delivery off the daemon
 * routes it to none of its channels, so a User hears from the agent through the Messenger alone.
 *
 * A Session name is the daemon's session key, passed through verbatim; the daemon stores it as
 * `agent:<agentId>:<name>`, under `agentId` or its sole agent when none is given. A blank name
 * fails the Run before a connection is opened, as does blank Prompt text. The `run_<uuid>` the
 * Signal Worker mints for a fresh Session is accepted unchanged.
 *
 * The daemon approves a device once. The first connection from a new key is refused with a pairing
 * request, which the Operator approves on the daemon host (`openclaw devices approve <requestId>`);
 * every later connection from the same key is accepted. The Runtime persists nothing of its own,
 * no key file and no device token. Construction throws if `deviceKey` is not an Ed25519 private
 * key, so the mistake fails `createGateway` and never a Signal.
 *
 * The client package refuses plaintext `ws://` to a hostname that is not an IP literal,
 * `localhost`, `.local` or `.ts.net` unless the Gateway process has
 * `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` in its environment; an Operator on a private Docker
 * network reaching the daemon by its service name sets that variable. `wss://` needs nothing.
 *
 * The outcome carries no Usage yet: this Runtime does not read the daemon's per-call records.
 */
export function createOpenClawRuntime(daemon: OpenClawDaemon): Runtime {
  const { url, token, deviceKey, agentId } = daemon;
  const log = daemon.logger ?? defaultLogger();

  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("Missing url. Pass the OpenClaw daemon's ws:// or wss:// address.");
  }
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("Missing token. Pass the OpenClaw daemon's shared gateway token.");
  }
  if (!(deviceKey instanceof KeyObjectClass) || deviceKey.type !== "private") {
    throw new Error("deviceKey must be a private KeyObject; received something else.");
  }
  if (deviceKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `deviceKey must be an Ed25519 private key, which is what the OpenClaw daemon verifies a challenge with; received ${deviceKey.asymmetricKeyType ?? "an unknown key type"}.`,
    );
  }
  if (agentId !== undefined && agentId.trim() === "") {
    throw new Error("agentId must name an agent the daemon hosts, or be left out.");
  }

  const identity = deviceIdentityOf(deviceKey);

  return {
    async run(prompt: RunPrompt): Promise<RunOutcome> {
      const failed = (why: string): RunOutcome => ({
        ok: false,
        error: `Session ${prompt.session}: ${why}`,
        usage: [],
      });

      if (prompt.session.trim() === "") {
        return failed("Session name must not be blank");
      }
      if (prompt.text.trim() === "") {
        return failed("Prompt text must not be blank");
      }

      let connection: Connection;
      try {
        connection = await openConnection({ url, token, identity, agentId });
      } catch (error) {
        return failed(`Cannot connect to the OpenClaw daemon at ${url}: ${messageOf(error)}`);
      }

      log.debug({ session: prompt.session, url }, "connected to the OpenClaw daemon");

      try {
        return await performRun(connection, prompt, agentId, failed);
      } catch (error) {
        return failed(messageOf(error));
      } finally {
        await connection.close();
        log.debug(
          { session: prompt.session, closed: connection.closed() },
          "closed the connection",
        );
      }
    },
  };
}

async function performRun(
  connection: Connection,
  prompt: RunPrompt,
  agentId: string | undefined,
  failed: (why: string) => RunOutcome,
): Promise<RunOutcome> {
  const agent = agentId === undefined ? {} : { agentId };

  // The per-call Usage records of a Run reach only a connection that subscribed to the Session
  // before the Run started, so the subscription precedes chat.send.
  await connection.request("sessions.messages.subscribe", { key: prompt.session, ...agent });

  const started = await connection.request<{ runId?: unknown }>("chat.send", {
    sessionKey: prompt.session,
    ...agent,
    message: prompt.text,
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  if (typeof started.runId !== "string") {
    return failed(`chat.send answered without a run id: ${JSON.stringify(started)}`);
  }

  return followRun(connection, started.runId, failed);
}

// Every connection with operator.read receives every Run's chat frames, so a frame belongs to this
// Run only by its runId. A failed Run sends two error frames; the first terminal frame ends it.
async function followRun(
  connection: Connection,
  runId: string,
  failed: (why: string) => RunOutcome,
): Promise<RunOutcome> {
  for await (const frame of connection.events()) {
    if (frame.event !== "chat" || !isChatEvent(frame.payload) || frame.payload.runId !== runId) {
      continue;
    }
    const chat = frame.payload;
    switch (chat.state) {
      case "final":
        return { ok: true, usage: [] };
      case "error":
        return failed(`The agent failed: ${chat.errorMessage ?? "the daemon gave no reason"}`);
      case "aborted":
        return failed(
          `The Run was aborted${chat.errorMessage === undefined ? "" : `: ${chat.errorMessage}`}`,
        );
      default:
        continue;
    }
  }
  return failed(connection.closed() ?? "The connection closed before the Run ended");
}

function isChatEvent(payload: unknown): payload is ChatEvent {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { runId?: unknown }).runId === "string" &&
    typeof (payload as { state?: unknown }).state === "string"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
