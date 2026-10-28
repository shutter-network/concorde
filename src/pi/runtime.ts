import { posix } from "node:path";
import { defaultLogger, type Logger } from "../logging/index.ts";
import type { RunOutcome, RunPrompt, Runtime } from "../signals/runtime.ts";
import { readOutcome } from "./output.ts";
import { openRpcChannel, type RpcChannel } from "./rpc.ts";

export type PiInstance = {
  readonly host: string;
  readonly port: number;
  /** Absolute POSIX path on the agent instance. Persist this directory to retain sessions. */
  readonly sessionsDir: string;
  /**
   * How long a Run may take, in milliseconds, before the runtime sends `abort` to pi. Defaults to
   * 15 minutes. The Run fails with the usage reported so far.
   */
  readonly timeoutMs?: number;
  readonly logger?: Logger;
};

const defaultTimeoutMs = 15 * 60_000;
const abortGraceMs = 10_000;

// Matches pi assertValidSessionId; also prevents paths from escaping sessionsDir.
const sessionNames = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Connects to an operator-run pi RPC listener once per run. It does not start the agent instance
 * or configure its model, credentials, tools, or workspace.
 *
 * session names must begin and end with an ASCII letter or digit; interior characters may also
 * include `.`, `_`, and `-`. Blank prompt text fails the run. Completion requires `agent_settled`
 * and a final assistant stop reason of `stop` or `length`.
 *
 * The outcome carries the usage of each assistant `message_end` and each `compaction_end`,
 * including retries, on success and on failure. Token counts come from the provider. A response
 * interrupted mid-stream reports less output than was generated. If the server reports no usage,
 * the recorded count is zero.
 *
 * After `timeoutMs` the runtime sends `abort` and waits up to 10 seconds for pi to settle, so the
 * call in progress still reports its usage. If pi does not settle, the connection is closed and
 * that call's usage is missing from the outcome.
 */
export function createPiRuntime(instance: PiInstance): Runtime {
  return piRuntime(instance, abortGraceMs);
}

/** `createPiRuntime` with the wait after `abort` shortened, for tests. */
export function piRuntime(instance: PiInstance, graceMs: number): Runtime {
  const { host, port, sessionsDir } = instance;
  const timeoutMs = instance.timeoutMs ?? defaultTimeoutMs;
  const log = instance.logger ?? defaultLogger();

  if (typeof sessionsDir !== "string" || sessionsDir.trim() === "") {
    throw new Error(
      "Missing sessionsDir. Pass the absolute session directory path as seen by the agent instance.",
    );
  }
  if (!posix.isAbsolute(sessionsDir)) {
    throw new Error(
      `sessionsDir must be an absolute path on the agent instance; received ${JSON.stringify(sessionsDir)}`,
    );
  }
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
    throw new Error(
      `timeoutMs must be a positive whole number of milliseconds; received ${String(timeoutMs)}`,
    );
  }

  return {
    async run(prompt: RunPrompt): Promise<RunOutcome> {
      const failed = (why: string): RunOutcome => ({
        ok: false,
        error: `Session ${prompt.session}: ${why}`,
        usage: [],
      });

      if (!sessionNames.test(prompt.session)) {
        return failed(
          `Invalid session name. Use letters, digits, dots, underscores, or dashes, starting and ending with a letter or digit.`,
        );
      }
      if (prompt.text.trim() === "") {
        return failed("Prompt text must not be blank");
      }

      const sessionFile = posix.join(sessionsDir, `${prompt.session}.jsonl`);

      let rpc: RpcChannel;
      try {
        rpc = await openRpcChannel(host, port);
      } catch (error) {
        return failed(messageOf(error));
      }

      log.debug({ session: prompt.session, sessionFile, host, port }, "connected to the agent");

      let timedOut = false;
      let unsettled = false;
      let grace: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        log.warn({ session: prompt.session, timeoutMs }, "run timed out; sending abort");
        rpc.notify("abort");
        grace = setTimeout(() => {
          unsettled = true;
          rpc.close();
        }, graceMs);
      }, timeoutMs);

      let outcome: RunOutcome;
      try {
        outcome = await performRun(rpc, prompt, sessionFile, failed);
      } catch (error) {
        outcome = failed(messageOf(error));
      } finally {
        clearTimeout(timer);
        clearTimeout(grace);
        rpc.close();
        log.debug({ session: prompt.session, dropped: rpc.dropped() }, "closed the connection");
      }

      if (outcome.ok || !timedOut) return outcome;
      const missing = unsettled
        ? `; pi did not settle within ${graceMs} ms of abort, so the usage of the call in progress is missing`
        : "";
      return {
        ok: false,
        error: `Session ${prompt.session}: Run timed out after ${timeoutMs} ms${missing}`,
        usage: outcome.usage,
      };
    },
  };
}

async function performRun(
  rpc: RpcChannel,
  prompt: RunPrompt,
  sessionFile: string,
  failed: (why: string) => RunOutcome,
): Promise<RunOutcome> {
  const switched = await rpc.send("switch_session", { sessionPath: sessionFile });
  if (!switched.success) {
    return failed(`Cannot open ${sessionFile}: ${switched.error ?? "switch_session was refused"}`);
  }
  if (switched.data?.cancelled === true) {
    return failed(`Session switch to ${sessionFile} was cancelled by an agent extension`);
  }

  // switch_session can report success without selecting the requested file; verify before prompting.
  const state = await rpc.send("get_state");
  if (!state.success) {
    return failed(
      `Cannot confirm session: get_state failed${state.error === undefined ? "" : `: ${state.error}`}`,
    );
  }
  const reached = state.data?.sessionFile;
  if (reached !== sessionFile) {
    return failed(
      `Session mismatch: requested ${sessionFile}, received ${typeof reached === "string" ? reached : JSON.stringify(reached)}`,
    );
  }

  const prompted = await rpc.send("prompt", { message: prompt.text });
  if (!prompted.success) {
    return failed(`Prompt rejected: ${prompted.error ?? "no error details"}`);
  }

  const outcome = await readOutcome(rpc.records, prompt.session);
  const dropped = rpc.dropped();
  if (outcome.ok || dropped === undefined) return outcome;
  return { ...outcome, error: `${outcome.error}. The connection failed: ${dropped}` };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
