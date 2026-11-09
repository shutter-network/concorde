import { KeyObject, randomUUID } from "node:crypto";
import type { ChatEvent } from "@openclaw/gateway-protocol";
import { defaultLogger, type Logger } from "../logging/index.ts";
import type { RunOutcome, RunPrompt, Runtime, UsageReport } from "../signals/runtime.ts";
import { type Connection, deviceIdentityOf, openConnection } from "./connection.ts";
import { refusedSessionName } from "./session-names.ts";
import { usageOf } from "./usage.ts";

export type OpenClawDaemon = {
  readonly url: string;
  /** Matches `gateway.auth.token` in the daemon's configuration. */
  readonly token: string;
  /** Ed25519 private key for a device approved on the daemon host. */
  readonly deviceKey: KeyObject;
  /** May be omitted when the daemon hosts a single agent. */
  readonly agentId?: string;
  readonly logger?: Logger;
};

/**
 * Connects to an operator-run OpenClaw daemon once per run. The operator configures the daemon's
 * model, credentials, tools, workspace, and channels. Concurrent runs use separate connections
 * to the same daemon.
 *
 * Replies are not delivered through OpenClaw's channels. The agent must send messages through
 * the messenger for users to receive them and for them to appear in the message log.
 *
 * Session names are limited to 512 characters and must be nonblank, lowercase, and free of
 * colons and surrounding whitespace. `main` and `global` are reserved for the daemon's own
 * traffic. These restrictions prevent distinct names from resolving to the same session after
 * the daemon normalizes them. The daemon stores a name as `agent:<agentId>:<name>`, using its
 * sole agent if `agentId` is omitted. Fresh session names (`run_<uuid>`) are accepted.
 * Blank prompt text and a usage limit other than a positive safe integer fail before connecting.
 *
 * A new device key requires approval on the daemon host. The first run fails with a pairing
 * request id and an `openclaw devices approve <requestId>` command. Approve it and submit a new
 * prompt. Approval persists in the daemon's state; the runtime stores no key or device token.
 * Invalid configuration, including a non-Ed25519 key, throws at construction.
 * Connection and execution failures return failed outcomes with a reason.
 *
 * For `ws://` connections to a Compose service name, set
 * `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` in the gateway's environment. Without it, the client
 * permits plaintext connections only to IP literals, `localhost`, `.local`, and `.ts.net`.
 * Use `wss://` outside a private network.
 *
 * Outcomes include usage for each reported model call, including retries and failed calls.
 * Cost comes from the daemon's price table. A zero-usage record does not prove a call was free:
 * an interrupted call's usage may never reach the daemon.
 *
 * When reported tokens exceed `usageLimit`, the runtime asks the daemon to abort. The run fails
 * with `limited: true`, even if completion races with the abort, and keeps its session history.
 * The call interrupted by the abort contributes no reported usage, so saved usage may understate
 * tokens used. An abort requested elsewhere fails the run without marking it limited.
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
  if (!(deviceKey instanceof KeyObject) || deviceKey.type !== "private") {
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
        connection = await openConnection({ url, token, identity });
      } catch (error) {
        return failed(`Cannot connect to the OpenClaw daemon at ${url}: ${connectRefusal(error)}`);
      }

      log.debug({ session: prompt.session, url }, "connected to the OpenClaw daemon");

      try {
        return await performRun(connection, prompt, agentId, failed, log);
      } catch (error) {
        return failed(messageOf(error));
      } finally {
        // A close timeout must not discard the outcome and its usage.
        try {
          await connection.close();
          log.debug(
            { session: prompt.session, closed: connection.closed() },
            "closed the connection",
          );
        } catch (error) {
          log.warn(
            { session: prompt.session, error: messageOf(error) },
            "the connection to the OpenClaw daemon did not close in time; the outcome stands",
          );
        }
      }
    },
  };
}

async function performRun(
  connection: Connection,
  prompt: RunPrompt,
  agentId: string | undefined,
  failed: (why: string) => RunOutcome,
  log: Logger,
): Promise<RunOutcome> {
  const agent = agentId === undefined ? {} : { agentId };

  // Subscribe before sending: the daemon does not replay usage records missed at run start.
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

  const run: StartedRun = { sessionKey: prompt.session, ...agent, runId: started.runId };
  return followRun(connection, run, prompt.usageLimit, failed, log);
}

type StartedRun = {
  readonly sessionKey: string;
  readonly agentId?: string;
  readonly runId: string;
};

// The daemon broadcasts chat frames across connections, so filter by runId. Completed calls'
// usage arrives before the terminal frame; later zero-usage abort records add no tokens.
async function followRun(
  connection: Connection,
  run: StartedRun,
  usageLimit: number | undefined,
  failed: (why: string) => RunOutcome,
  log: Logger,
): Promise<RunOutcome> {
  const { runId } = run;
  const usage: UsageReport[] = [];
  let used = 0;
  let limited: string | undefined;
  const ended = (why: string): RunOutcome => ({
    ...failed(why),
    usage,
    ...(limited === undefined ? {} : { limited: true }),
  });

  for await (const frame of connection.events()) {
    if (frame.event === "session.message") {
      const report = usageOf(frame.payload, runId);
      if (report === undefined) continue;
      usage.push(report);
      used += report.totalTokens;
      if (limited === undefined && usageLimit !== undefined && used > usageLimit) {
        limited = `Usage limit reached: ${used} of ${usageLimit} tokens`;
        await abortRun(connection, run, log);
      }
      continue;
    }
    if (frame.event !== "chat" || !isChatEvent(frame.payload) || frame.payload.runId !== runId) {
      continue;
    }
    const chat = frame.payload;
    switch (chat.state) {
      case "final":
        return limited === undefined
          ? { ok: true, usage }
          : ended(`${limited}; the Run finished before the abort landed`);
      case "error": {
        const reason = chat.errorMessage ?? "the daemon gave no reason";
        return ended(
          limited === undefined
            ? `The agent failed: ${reason}`
            : `${limited}; the agent then failed: ${reason}`,
        );
      }
      case "aborted":
        return ended(
          limited ??
            `The Run was aborted${chat.errorMessage === undefined ? "" : `: ${chat.errorMessage}`}`,
        );
      default:
        continue;
    }
  }
  return ended(connection.closed() ?? "The connection closed before the Run ended");
}

// If abort is refused, keep collecting usage until the daemon ends the run.
async function abortRun(connection: Connection, run: StartedRun, log: Logger): Promise<void> {
  try {
    await connection.request("chat.abort", run);
  } catch (error) {
    log.warn(
      { session: run.sessionKey, runId: run.runId, error: messageOf(error) },
      "the daemon refused to abort the Run over its usage limit; following it to its end",
    );
  }
}

function isChatEvent(payload: unknown): payload is ChatEvent {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { runId?: unknown }).runId === "string" &&
    typeof (payload as { state?: unknown }).state === "string"
  );
}

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
