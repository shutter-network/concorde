import { type KeyObject, KeyObject as KeyObjectClass, randomUUID } from "node:crypto";
import type { ChatEvent } from "@openclaw/gateway-protocol";
import { defaultLogger, type Logger } from "../logging/index.ts";
import type { RunOutcome, RunPrompt, Runtime, UsageReport } from "../signals/runtime.ts";
import { type Connection, deviceIdentityOf, openConnection } from "./connection.ts";
import { refusedSessionName } from "./session-names.ts";
import { usageOf } from "./usage.ts";

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
 * `agent:<agentId>:<name>`, under `agentId` or its sole agent when none is given. The names this
 * Runtime accepts are its own grammar, decided from what the daemon does with a key: the daemon
 * refuses an empty key and one over 512 characters, and it normalises the rest in silence, by
 * lowercasing every key, trimming surrounding whitespace and folding `global` into `main`. So a
 * name is refused, and the Run fails before a connection is opened, when it is blank or
 * whitespace-only; over 512 characters; contains a colon, the daemon's key segment separator,
 * which keeps the name one segment and the daemon's own `agent:`, `subagent:`, `cron:` and `acp:`
 * forms out of a Handler's reach; is `main` or `global`, the agent's main Session, where the
 * daemon's heartbeats and channel traffic go; contains an uppercase letter, since the daemon
 * lowercases and `User_42` would silently share a Session with `user_42`; or has leading or
 * trailing whitespace, which the daemon trims. Everything else is passed through: dots, dashes,
 * underscores, slashes, spaces inside, non-ASCII and the `incognito-` prefix. The `run_<uuid>` the
 * Signal Worker mints for a fresh Session is within the grammar and accepted unchanged. Blank
 * Prompt text and a `usageLimit` that is not a positive whole number fail the Run the same way,
 * before any connection.
 *
 * The daemon approves a device once. The first connection from a new key is refused with a pairing
 * request, and the Run fails with the request id and the command that approves it on the daemon
 * host (`openclaw devices approve <requestId>`); every later connection from the same key is
 * accepted. The Runtime persists nothing of its own, no key file and no device token. Construction
 * throws if `deviceKey` is not an Ed25519 private key, so the mistake fails `createGateway` and
 * never a Signal.
 *
 * Every failure is an `ok: false` outcome and `run` throws nothing: a daemon that cannot be
 * reached, a refused connection, a connection dropped mid-Run, and a Run the daemon ends with an
 * error each fail the Run with the reason, and the connection is closed either way.
 *
 * The client package refuses plaintext `ws://` to a hostname that is not an IP literal,
 * `localhost`, `.local` or `.ts.net` unless the Gateway process has
 * `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` in its environment; an Operator on a private Docker
 * network reaching the daemon by its service name sets that variable. `wss://` needs nothing.
 *
 * The outcome carries one Usage report per model call the Run made, on success and on failure,
 * read from the transcript records the daemon streams to a connection subscribed to the Session:
 * provider, model, the four token counts and the daemon's own cost figure. A record counts for
 * this Run by the run id it carries, never by order, since the connection hears every Run in the
 * Session. The daemon's all-zero record for a call it refused or cut off is kept as a call that
 * charged nothing. Usage for a call in flight when the Run was aborted does not exist on the wire
 * and is not reported. The daemon's session-level usage method is never called: it reports per
 * Session, not per Run, and would count turns that were never ours.
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

      const refusedName = refusedSessionName(prompt.session);
      if (refusedName !== undefined) {
        return failed(refusedName);
      }
      if (prompt.text.trim() === "") {
        return failed("Prompt text must not be blank");
      }
      if (
        prompt.usageLimit !== undefined &&
        !(Number.isSafeInteger(prompt.usageLimit) && prompt.usageLimit > 0)
      ) {
        return failed(
          `usageLimit must be a positive whole number of tokens; received ${String(prompt.usageLimit)}`,
        );
      }

      let connection: Connection;
      try {
        connection = await openConnection({ url, token, identity, agentId });
      } catch (error) {
        return failed(`Cannot connect to the OpenClaw daemon at ${url}: ${connectRefusal(error)}`);
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
// The Run's Usage is the session.message records collected until then: every record of a Run
// arrived before its terminal frame in every observed Run, so nothing waits after it.
async function followRun(
  connection: Connection,
  runId: string,
  failed: (why: string) => RunOutcome,
): Promise<RunOutcome> {
  const usage: UsageReport[] = [];
  const failedWithUsage = (why: string): RunOutcome => ({ ...failed(why), usage });

  for await (const frame of connection.events()) {
    if (frame.event === "session.message") {
      const report = usageOf(frame.payload, runId);
      if (report !== undefined) usage.push(report);
      continue;
    }
    if (frame.event !== "chat" || !isChatEvent(frame.payload) || frame.payload.runId !== runId) {
      continue;
    }
    const chat = frame.payload;
    switch (chat.state) {
      case "final":
        return { ok: true, usage };
      case "error":
        return failedWithUsage(
          `The agent failed: ${chat.errorMessage ?? "the daemon gave no reason"}`,
        );
      case "aborted":
        return failedWithUsage(
          `The Run was aborted${chat.errorMessage === undefined ? "" : `: ${chat.errorMessage}`}`,
        );
      default:
        continue;
    }
  }
  return failedWithUsage(connection.closed() ?? "The connection closed before the Run ended");
}

function isChatEvent(payload: unknown): payload is ChatEvent {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { runId?: unknown }).runId === "string" &&
    typeof (payload as { state?: unknown }).state === "string"
  );
}

// The daemon refuses a key it has never seen with `details.code: "PAIRING_REQUIRED"` and the id of
// the pairing request it opened; approving that id on the daemon host is the Operator's one step.
function connectRefusal(error: unknown): string {
  const details = (error as { details?: unknown })?.details;
  if (
    typeof details === "object" &&
    details !== null &&
    (details as { code?: unknown }).code === "PAIRING_REQUIRED"
  ) {
    const requestId = (details as { requestId?: unknown }).requestId;
    const id = typeof requestId === "string" ? requestId : "<requestId>";
    return `this Gateway's device key is not approved yet. On the daemon host run \`openclaw devices approve ${id}\` (pairing request ${id}), then the next Run connects`;
  }
  return messageOf(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
