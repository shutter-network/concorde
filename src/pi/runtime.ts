/**
 * The Gateway does not run the agent, which is the load-bearing decision underneath all of
 * `src/pi/`. An Operator runs an **Agent Instance** — `pi --mode rpc` behind a listener, in a
 * container of their own — and this Runtime opens one connection to it per Run. What that buys is
 * that the Gateway holds no container runtime socket, names no host path, and carries no part of
 * the agent's environment: the image, the model credential, the files the agent reads and the flags
 * it is started with are all on the other side of a TCP address.
 *
 * Driving `pi` in-process through its TypeScript SDK is the alternative, and it stays refused on
 * the same ground it always was: `pi`'s shell tool hands its child `{ ...process.env }`, so an
 * in-process agent would hold the Gateway's `DATABASE_URL` and could write every table directly,
 * bypassing the Agent server. The separation is now the Operator's arrangement rather than the
 * framework's, and it is a stronger one — the agent's process never shared an address space, a
 * filesystem or an environment with the Gateway to begin with.
 *
 * Container-per-Run is gone with the Docker socket. The isolation it bought did not disappear; it
 * moved into the Operator's compose file, where it was always better expressed. An Operator who
 * wants a fresh container per Run writes a {@link Runtime}, which is one method.
 */

import { posix } from "node:path";
import { defaultLogger, type Logger } from "../logging/index.ts";
import type { RunOutcome, RunPrompt, Runtime } from "../signals/runtime.ts";
import { readOutcome } from "./output.ts";
import { openRpcChannel, type RpcChannel } from "./rpc.ts";

/**
 * Where the Agent Instance is and where its Sessions are kept.
 *
 * Three required values and no fourth. There is no model, no provider, no image, no flag and no
 * credential, because the Gateway starts nothing: everything `pi` reads on disk or takes on its
 * command line is the Operator's to place in the instance they run, and a field here would be a
 * second place to say it.
 */
export type PiInstance = {
  /** The host the Agent Instance accepts RPC on, as this process resolves it. */
  readonly host: string;
  /** The port it accepts on. */
  readonly port: number;
  /**
   * The directory Sessions live in, **as the Agent Instance sees it**.
   *
   * Absolute, and refused in {@link createPiRuntime} rather than at the first Run. This is the check
   * the container-per-Run design could not make and recorded its regret at not making: it named no
   * path at all, so a deployment that had mounted the wrong thing was a Gateway which started,
   * served, and then failed every Run permanently. A path can be checked for what it *is* even
   * where it cannot be checked for what is *there*, and the Operator wrote it in the same file as
   * this option, which is where a refusal belongs.
   *
   * It is not a path on this host and must not be read as one. The Gateway never opens it, creates
   * nothing in it and does not need to be able to reach it; the two ends agree on it because the
   * Operator wrote the same string in the compose file and here.
   */
  readonly sessionsDir: string;
  readonly logger?: Logger;
};

/**
 * `pi`'s own Session id grammar, copied verbatim from `assertValidSessionId` in its
 * `core/session-manager`.
 *
 * Copied, which the framework never had to do before: `pi` used to be handed `--session-id` and to
 * refuse a bad one itself, so the framework carried no transcription that could go stale and the
 * Operator got `pi`'s own message. A Session is addressed **by path** over RPC, and `pi` will open
 * any path it is handed, so the grammar has to live somewhere and the only honest place is beside
 * the code that joins the path.
 *
 * Traversal-safe by construction rather than by a second check: there is no `/` in it, and `.` and
 * `..` are excluded because both ends must be alphanumeric. So a Signal Handler's Session name
 * cannot climb out of `sessionsDir`, and nothing here needs to compare a resolved path against a
 * prefix.
 */
const sessionNames = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Builds the Runtime that performs each Run against an Agent Instance.
 *
 * Nothing is connected here and nothing is probed. An Agent Instance that is not listening is a
 * failed Run carrying the address, on the **Relay** precedent: a remote thing the Operator runs is
 * an outage, and a Gateway that refused to start would take every other Party's access down with
 * the agent's. What is refused here is only what an Operator got wrong in the file in front of
 * them.
 *
 * @throws If `sessionsDir` is missing, empty or relative.
 */
export function createPiRuntime(instance: PiInstance): Runtime {
  const { host, port, sessionsDir } = instance;
  const log = instance.logger ?? defaultLogger();

  if (typeof sessionsDir !== "string" || sessionsDir.trim() === "") {
    throw new Error(
      "the pi Runtime needs a sessionsDir: the directory Sessions are kept in, as the Agent Instance sees it. Every Run names a file under it, so there is no default that could be right",
    );
  }
  // `posix` and not the platform's `path`, deliberately: this is a path in the Agent Instance's
  // filesystem, which is a container, and a Gateway that happened to be running on Windows would
  // otherwise refuse `/sessions` and join with a backslash.
  if (!posix.isAbsolute(sessionsDir)) {
    throw new Error(
      `the pi Runtime's sessionsDir must be absolute, and ${JSON.stringify(sessionsDir)} is not. It is resolved by the Agent Instance and never by this process, so a relative path would be read against a working directory nothing here can see`,
    );
  }

  return {
    async run(prompt: RunPrompt): Promise<RunOutcome> {
      // Every failure below is this Run's Session, which is the only thing an Operator has to find
      // a transcript by.
      const failed = (why: string): RunOutcome => ({
        ok: false,
        error: `Session ${prompt.session} ${why}`,
      });

      if (!sessionNames.test(prompt.session)) {
        // This Run and no other. A Handler that writes a bad name writes it for one Prompt, and a
        // Signal that produced several must not lose the rest of them to it.
        return failed(
          `is not a name pi will accept: a Session name is one or more of A-Z, a-z, 0-9, '.', '_' and '-', beginning and ending with a letter or a digit`,
        );
      }
      if (prompt.text.trim() === "") {
        // The agent drops an empty message rather than answering it, so the Run would settle having
        // said nothing and be recorded as a success. A failed Run rather than a throw, because
        // everything else that can go wrong here is one and the Signal Worker treats them alike.
        return failed("was given a Prompt with no text, so the agent would answer nothing");
      }

      const sessionFile = posix.join(sessionsDir, `${prompt.session}.jsonl`);

      let rpc: RpcChannel;
      try {
        rpc = await openRpcChannel(host, port);
      } catch (error) {
        return failed(messageOf(error));
      }

      // No Run id on this line. The Signal Worker is serial globally, so its own "Run started" and
      // "Run finished" lines bracket this one, and the Run a connection belongs to is the one
      // immediately above it.
      log.debug({ session: prompt.session, sessionFile, host, port }, "connected to the agent");

      try {
        return await performRun(rpc, prompt, sessionFile, failed);
      } catch (error) {
        return failed(messageOf(error));
      } finally {
        // Whatever happened. A connection left open is a `pi` process the Operator's listener
        // started and will not reap, and with `fork` there is one per Run.
        rpc.close();
        log.debug({ session: prompt.session, dropped: rpc.dropped() }, "closed the connection");
      }
    },
  };
}

/**
 * The four steps of one Run, strictly in sequence.
 *
 * `switch_session` is **create-or-resume**: a path that does not exist becomes a fresh Session kept
 * at that path, and a path that does is loaded. That behaviour is undocumented, the whole design
 * rests on it, and `get_state` is here because of it — the one thing that can tell "created it"
 * apart from "did something else and said it went fine". Reading `sessionFile` back and comparing it
 * to what was asked for costs one round trip per Run and is the difference between a Session that
 * continues and a Session that silently starts over, or worse, a Prompt delivered into the Session
 * the previous connection happened to leave open.
 */
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
    // `success: true` with `cancelled: true`, which is an extension of the Operator's refusing the
    // switch in a `session_before_switch` handler. Prompting anyway would deliver this Prompt into
    // whichever Session the instance is in, which is the failure this whole sequence exists to make
    // impossible.
    return failed(
      `was not opened at ${sessionFile}: an extension of the Agent Instance cancelled the switch, so the agent is in some other Session and this Prompt is not for it`,
    );
  }

  const state = await rpc.send("get_state");
  if (!state.success) {
    return failed(
      `could not be confirmed: the Agent Instance refused to say what state it is in${state.error === undefined ? "" : `: ${state.error}`}`,
    );
  }
  const reached = state.data?.sessionFile;
  if (reached !== sessionFile) {
    // Both, because either one alone leaves the reader guessing which end was wrong.
    return failed(
      `was asked for at ${sessionFile} and the Agent Instance is in ${typeof reached === "string" ? reached : JSON.stringify(reached)}, so the Prompt would go to the wrong Session`,
    );
  }

  const prompted = await rpc.send("prompt", { message: prompt.text });
  if (!prompted.success) {
    // A refusal before acceptance, which is the only failure `prompt` reports this way: anything
    // that goes wrong afterwards arrives in the event stream instead.
    return failed(
      `was refused the Prompt: ${prompted.error ?? "the Agent Instance rejected it and said why nowhere"}`,
    );
  }

  // Accepted, not finished. What ends the Run is `agent_settled` in the stream that follows.
  const outcome = await readOutcome(rpc.records, prompt.session);
  const dropped = rpc.dropped();
  if (outcome.ok || dropped === undefined) return outcome;
  // The reader saw records stop; only the socket knows whether that was a failure. Appended rather
  // than replacing the reader's sentence, because which record was missing is the useful half.
  return { ok: false, error: `${outcome.error}. The connection failed: ${dropped}` };
}

/** What a thrown value says, for a Run's `error` column, which nothing parses. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
