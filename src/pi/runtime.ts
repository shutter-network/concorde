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
 */
export function createPiRuntime(instance: PiInstance): Runtime {
  const { host, port, sessionsDir } = instance;
  const log = instance.logger ?? defaultLogger();

  if (typeof sessionsDir !== "string" || sessionsDir.trim() === "") {
    throw new Error(
      "the pi Runtime needs a sessionsDir: the directory Sessions are kept in, as the Agent Instance sees it. Every Run names a file under it, so there is no default that could be right",
    );
  }
  if (!posix.isAbsolute(sessionsDir)) {
    throw new Error(
      `the pi Runtime's sessionsDir must be absolute, and ${JSON.stringify(sessionsDir)} is not. It is resolved by the Agent Instance and never by this process, so a relative path would be read against a working directory nothing here can see`,
    );
  }

  return {
    async run(prompt: RunPrompt): Promise<RunOutcome> {
      const failed = (why: string): RunOutcome => ({
        ok: false,
        error: `Session ${prompt.session} ${why}`,
      });

      if (!sessionNames.test(prompt.session)) {
        return failed(
          `is not a name pi will accept: a Session name is one or more of A-Z, a-z, 0-9, '.', '_' and '-', beginning and ending with a letter or a digit`,
        );
      }
      if (prompt.text.trim() === "") {
        return failed("was given a Prompt with no text, so the agent would answer nothing");
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
        return await performRun(rpc, prompt, sessionFile, failed);
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
): Promise<RunOutcome> {
  const switched = await rpc.send("switch_session", { sessionPath: sessionFile });
  if (!switched.success) {
    return failed(
      `could not be opened at ${sessionFile}: ${switched.error ?? "the Agent Instance refused the switch and said why nowhere"}`,
    );
  }
  if (switched.data?.cancelled === true) {
    return failed(
      `was not opened at ${sessionFile}: an extension of the Agent Instance cancelled the switch, so the agent is in some other Session and this Prompt is not for it`,
    );
  }

  // switch_session can report success without selecting the requested file; verify before prompting.
  const state = await rpc.send("get_state");
  if (!state.success) {
    return failed(
      `could not be confirmed: the Agent Instance refused to say what state it is in${state.error === undefined ? "" : `: ${state.error}`}`,
    );
  }
  const reached = state.data?.sessionFile;
  if (reached !== sessionFile) {
    return failed(
      `was asked for at ${sessionFile} and the Agent Instance is in ${typeof reached === "string" ? reached : JSON.stringify(reached)}, so the Prompt would go to the wrong Session`,
    );
  }

  const prompted = await rpc.send("prompt", { message: prompt.text });
  if (!prompted.success) {
    return failed(
      `was refused the Prompt: ${prompted.error ?? "the Agent Instance rejected it and said why nowhere"}`,
    );
  }

  const outcome = await readOutcome(rpc.records, prompt.session);
  const dropped = rpc.dropped();
  if (outcome.ok || dropped === undefined) return outcome;
  return { ok: false, error: `${outcome.error}. The connection failed: ${dropped}` };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
