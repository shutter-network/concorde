/**
 * The highest-risk logic in the `pi` adapter, which is why it is a module of its own with no socket
 * in it. Three properties of `pi`'s event stream each produce a plausible wrong answer rather than
 * an error, so getting a Run to work once catches none of them and only a test over a crafted
 * stream does.
 *
 * Two of the three are rendered on the function below, having consequences a caller acts on: the
 * terminal record is not the obvious one, and an error the model returned is announced nowhere but
 * inside an assistant message. The third is framing, and it moved to `./framing.ts` when the
 * RPC channel arrived, because a response to a command and an event of a Run are the same bytes
 * read the same way. Nothing here sees a byte.
 *
 * `agent_settled` is missing from `pi`'s own `docs/json.md`, which is stale; `docs/rpc.md` has it.
 * Read the code rather than either page before changing which record ends a Run.
 */

import type { RunOutcome } from "../signals/runtime.ts";
import type { Framed } from "./framing.ts";

/**
 * The stop reasons that mean the agent finished answering. Anything else is a failed Run.
 *
 * An allow-list and not a list of failures, which is the difference between "never a false success"
 * and nearly that. `pi`'s own `mode: "text"` exit-code rule runs the other way round: it fails on
 * `error` and `aborted` and prints anything else. Copied here, that would report a Run as successful
 * on `pending`, which a streaming assistant message carries, and on `toolUse`, where the agent
 * stopped to call a tool and never continued. Neither is an answer, both are reachable when the
 * stream is cut in the wrong place, and both look like success.
 *
 * `length` is a success. The model ran out of output tokens, so the answer is truncated rather than
 * absent, and `pi` treats it the same way.
 */
const answeredStopReasons = new Set(["stop", "length"]);

/** All the outcome depends on: how the agent stopped, and what it said if that was an error. */
type Answer = {
  readonly stopReason: string;
  readonly errorMessage: string | undefined;
};

/**
 * Reads the events of one Run and reports how it ended, **stopping at the settle**.
 *
 * No exit status is read and there is none to read: the Agent Instance is a process the Operator
 * runs and the Gateway only ever holds a connection to it. That is the same trade the old
 * container-per-Run reader made for a different reason — `--mode json` exits 0 on a model error —
 * and it is now structural rather than a choice. What decides the outcome is the stop reason on the
 * last assistant message before the agent settled. An `agent_end` record is not that settle: it
 * fires per low-level agent run, and a retry or a compaction can follow it and continue the same
 * Run, so a stream ending after one is a Run that did not finish.
 *
 * An `AsyncIterator` and not an `AsyncIterable`, which is the whole point of this signature. The
 * records are the channel's, shared with the commands that were sent before the Prompt, and this
 * reader must take exactly what it needs and leave the iterator alone: `for await` would call
 * `return()` on it at the settle and close the connection from underneath the caller, which is the
 * caller's to do and to log. It also means the reader never drains to EOF. Nothing closes the
 * connection but us, so draining would be waiting for a peer with no reason to hang up.
 *
 * Bad output never throws. A stream that stopped early, ended mid-record, or carried a line that is
 * not a record is a failed Run with a reason, and never a success inferred from the records that did
 * parse. Every reason names the `session`, because a Run's `error` column is the only thing an
 * Operator has to go on, and `Session user_42 said nothing at all` says where to look.
 */
export async function readOutcome(
  records: AsyncIterator<Framed>,
  session: string,
): Promise<RunOutcome> {
  // Every failure below is this Session's, so it says so once here rather than seven times.
  const failed = (why: string): RunOutcome => ({ ok: false, error: `Session ${session} ${why}` });
  /** How many records were read, for a message about a stream that stopped early. */
  let read = 0;
  /** The last assistant message seen so far, which at the settle is the one that decides. */
  let answer: Answer | undefined;

  for (;;) {
    const step = await records.next();
    if (step.done === true) {
      // The dropped connection, and the one failure mode a Runtime over a socket has that a
      // Runtime over a pipe did not: the Agent Instance is somebody else's process on somebody
      // else's schedule, and it can go away in the middle of a Run.
      return read === 0
        ? failed(
            "said nothing at all after the Prompt was accepted, so nothing says whether the Run happened",
          )
        : failed(
            `ended after ${read} records without an agent_settled record, so the Run did not finish. An agent_end is not the end: it can be followed by a retry or a compaction`,
          );
    }
    const framed = step.value;
    if (framed.kind === "unreadable") {
      // Reported the moment it is seen, and a settle after it cannot rescue it. The half that was
      // lost might have been the half that mattered, and "the rest of it parsed" is not evidence
      // of anything.
      return failed(
        `wrote a line that could not be read as a record (${framed.why}), so its output cannot be trusted: ${excerpt(framed.line)}`,
      );
    }
    if (framed.kind === "truncated") {
      return failed(
        `ended mid-record after ${read} records, so the Run did not finish: ${excerpt(framed.line)}`,
      );
    }

    read += 1;
    const record = framed.record;
    switch (record.type) {
      case "message_end":
      case "turn_end":
        answer = answerIn(record.message) ?? answer;
        break;
      case "agent_end":
        // `agent_end` carries the whole message list. Read for the answer, never as the end of the
        // Run: a retry or a compaction can follow it and continue the same Run.
        if (Array.isArray(record.messages)) {
          const found = record.messages.map(answerIn).findLast((one) => one !== undefined);
          if (found !== undefined) answer = found;
        }
        break;
      case "agent_settled":
        return settlement(failed, answer, read);
      default:
        break;
    }
  }
}

/** What the settle means, given the answer as it stood when it arrived. */
function settlement(
  failed: (why: string) => RunOutcome,
  answer: Answer | undefined,
  read: number,
): RunOutcome {
  if (answer === undefined) {
    return failed(
      `settled after ${read} records with no assistant message, so there is nothing that says the Run succeeded`,
    );
  }
  if (!answeredStopReasons.has(answer.stopReason)) {
    // The stop reason is named because nothing else says anything: the agent settled, the
    // connection is healthy, and this string is all the Operator gets.
    return failed(
      `settled with stopReason ${JSON.stringify(answer.stopReason)} and reported no failure of its own: ${answer.errorMessage ?? `the agent's last message was not an answer (${answer.stopReason})`}`,
    );
  }
  return { ok: true };
}

/** The answer a message holds, if that message is one of the agent's own. */
function answerIn(message: unknown): Answer | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const fields = message as Record<string, unknown>;
  if (fields.role !== "assistant" || typeof fields.stopReason !== "string") return undefined;
  return {
    stopReason: fields.stopReason,
    errorMessage: typeof fields.errorMessage === "string" ? fields.errorMessage : undefined,
  };
}

/** Enough of a line to recognise it by, without putting a whole Session into a log. */
function excerpt(line: string): string {
  const trimmed = line.trim();
  return JSON.stringify(trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed);
}
