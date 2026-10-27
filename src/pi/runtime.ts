import { posix } from "node:path";
import { defaultLogger, type Logger } from "../logging/index.ts";
import type { RunObserver, RunOutcome, RunPrompt, Runtime } from "../signals/runtime.ts";
import { readOutcome } from "./output.ts";
import { openRpcChannel, type RpcChannel } from "./rpc.ts";

export type PiInstance = {
  readonly host: string;
  readonly port: number;
  /** Absolute POSIX path on the agent instance. Persist this directory to retain sessions. */
  readonly sessionsDir: string;
  readonly logger?: Logger;
};

// Matches pi assertValidSessionId; also prevents paths from escaping sessionsDir.
const sessionNames = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Connects to an operator-run pi RPC listener once per run. It does not start the agent instance
 * or configure its model, credentials, tools, or workspace.
 *
 * session names must begin and end with an ASCII letter or digit; interior characters may also
 * include `.`, `_`, and `-`. Blank prompt text fails the run. Completion requires `agent_settled`
 * and a final assistant stop reason of `stop` or `length`. There is no execution timeout.
 *
 * Reports usage at each assistant `message_end`, including retries. Calls that summarize the
 * Session's history report usage at `compaction_end`. If the observer throws an error or usage
 * goes over the Prompt's `usageLimit`, the runtime sends `abort` to pi. It waits for
 * `agent_settled`, then fails the Run and keeps the Session file.
 *
 * Token counts come from the provider. If a response is interrupted before it finishes, its
 * reported output count is lower than the actual count. If the server reports no usage, the
 * recorded count is zero.
 */
export function createPiRuntime(instance: PiInstance): Runtime {
  const { host, port, sessionsDir } = instance;
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

  return {
    async run(prompt: RunPrompt, observer?: RunObserver): Promise<RunOutcome> {
      const failed = (why: string): RunOutcome => ({
        ok: false,
        error: `Session ${prompt.session}: ${why}`,
      });

      if (!sessionNames.test(prompt.session)) {
        return failed(
          `Invalid session name. Use letters, digits, dots, underscores, or dashes, starting and ending with a letter or digit.`,
        );
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

      const sessionFile = posix.join(sessionsDir, `${prompt.session}.jsonl`);

      let rpc: RpcChannel;
      try {
        rpc = await openRpcChannel(host, port);
      } catch (error) {
        return failed(messageOf(error));
      }

      log.debug({ session: prompt.session, sessionFile, host, port }, "connected to the agent");

      try {
        return await performRun(rpc, prompt, sessionFile, failed, observer);
      } catch (error) {
        return failed(messageOf(error));
      } finally {
        rpc.close();
        log.debug({ session: prompt.session, dropped: rpc.dropped() }, "closed the connection");
      }
    },
  };
}

async function performRun(
  rpc: RpcChannel,
  prompt: RunPrompt,
  sessionFile: string,
  failed: (why: string) => RunOutcome,
  observer: RunObserver | undefined,
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

  let aborted = false;
  const abort = (): void => {
    if (aborted) return;
    aborted = true;
    rpc.notify("abort");
  };
  const outcome = await readOutcome(rpc.records, prompt.session, {
    ...(observer === undefined ? {} : { observer }),
    ...(prompt.usageLimit === undefined ? {} : { usageLimit: prompt.usageLimit }),
    abort,
  });
  const dropped = rpc.dropped();
  if (outcome.ok || dropped === undefined) return outcome;
  return { ok: false, error: `${outcome.error}. The connection failed: ${dropped}` };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
