/**
 * The highest-risk logic in the `pi` adapter, which is why it is a module of its own with no
 * process in it. Three properties of `pi --mode json` each produce a plausible wrong answer rather
 * than an error, so getting a Run to work once catches none of them and only a test over a crafted
 * stream does (ADR-0025).
 *
 * Two of the three are the worthless exit code and the terminal record, and both are rendered on the
 * function, having consequences a caller acts on. The third is here, because it has none until
 * somebody undoes it: framing is strictly LF, and nothing here may reach for `node:readline`. That
 * splits on U+2028 and U+2029 as well. Both are legal inside a JSON string and `JSON.stringify`
 * emits them literally, so one record would arrive as two malformed halves.
 *
 * `agent_settled` is missing from `pi`'s own `docs/json.md`, which is stale. Read the code rather
 * than that page before changing which record ends a Run.
 */

import type { RunOutcome } from "../signals/runtime.ts";

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

/** What one interpretation carries across the stream. Mutable, and never shared between two. */
type Reading = {
  /** Bytes decoded but not yet terminated by an LF. */
  pending: string;
  /** How many records were read, for a message about a stream that stopped early. */
  records: number;
  /** The first line that could not be read as a record, and why, if there was one. */
  unreadable: { readonly line: string; readonly why: string } | undefined;
  /** The last assistant message seen so far. */
  answer: Answer | undefined;
  /** The answer as it stood at the settle, which is the one the outcome is read from. */
  settledAnswer: Answer | undefined;
  /** Whether `agent_settled` has been seen. */
  settled: boolean;
};

/**
 * Reads one Run's `pi --mode json` output and reports how the Run ended.
 *
 * No exit code is read and none is taken, because `--mode json` exits 0 on a model error and on an
 * API error. What decides the outcome is the stop reason on the last assistant message before the
 * agent settled. An `agent_end` record is not that settle: it fires per low-level agent run, and a
 * retry or a compaction can follow it and continue the same Run, so a stream ending after one is a
 * Run that did not finish.
 *
 * The `source` is the container's stdout as raw chunks rather than as decoded text, a chunk boundary
 * falling wherever the operating system puts it, including inside a multi-byte character.
 *
 * Bad output never throws. A stream that stopped early, ended mid-record, or carried a line that is
 * not a record is a failed Run with a reason, and never a success inferred from the records that did
 * parse. Every reason names the `session`, because a Run's `error` column is the only thing an
 * Operator has to go on, and `Session user_42 produced no output at all` says where to look.
 *
 * The whole source is consumed even once the outcome is known, a subprocess whose stdout stops being
 * read blocking as soon as the pipe fills, which would turn a finished Run into a hang. There is no
 * timeout here or anywhere else, so a stream that never ends never returns.
 */
export async function interpretPiOutput(
  source: AsyncIterable<Uint8Array>,
  session: string,
): Promise<RunOutcome> {
  const reading: Reading = {
    pending: "",
    records: 0,
    unreadable: undefined,
    answer: undefined,
    settledAnswer: undefined,
    settled: false,
  };
  // `stream: true` is what makes a character split across two chunks survive. A per-chunk
  // `toString()` would produce U+FFFD and a record that no longer parses.
  const decoder = new TextDecoder("utf-8");

  for await (const chunk of source) {
    frameLines(reading, decoder.decode(chunk, { stream: true }));
  }
  frameLines(reading, decoder.decode());

  return outcomeOf(reading, session);
}

/** Cuts `text` into lines on LF and on nothing else, for the reason the file header gives. */
function frameLines(reading: Reading, text: string): void {
  reading.pending += text;
  for (;;) {
    const end = reading.pending.indexOf("\n");
    if (end === -1) return;
    const line = reading.pending.slice(0, end);
    reading.pending = reading.pending.slice(end + 1);
    readRecord(reading, line);
  }
}

/** Reads one framed line as a record, or notes why it could not be read as one. */
function readRecord(reading: Reading, line: string): void {
  // `pi` writes no blank lines, but a trailing LF leaves one behind here, and a reader that failed
  // on it would fail on every well-formed stream.
  if (line.trim() === "") return;

  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    reading.unreadable ??= { line, why: "it is not JSON" };
    return;
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    reading.unreadable ??= { line, why: "it is JSON but not an object" };
    return;
  }
  const fields = record as Record<string, unknown>;
  if (typeof fields.type !== "string") {
    reading.unreadable ??= { line, why: "it has no type field" };
    return;
  }

  reading.records += 1;
  // Past the settle the Run's outcome is already decided, so nothing is read from what follows.
  // Still counted and still framed, so the stream keeps draining.
  if (reading.settled) return;

  switch (fields.type) {
    case "message_end":
    case "turn_end":
      reading.answer = answerIn(fields.message) ?? reading.answer;
      return;
    case "agent_end":
      // `agent_end` carries the whole message list. Read for the answer, never as the end of the
      // Run: a retry or a compaction can follow it and continue the same Run.
      if (Array.isArray(fields.messages)) {
        const answer = fields.messages.map(answerIn).findLast((found) => found !== undefined);
        if (answer !== undefined) reading.answer = answer;
      }
      return;
    case "agent_settled":
      reading.settled = true;
      reading.settledAnswer = reading.answer;
      return;
    default:
      return;
  }
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

/**
 * The outcome, with the reasons in the order they take precedence.
 *
 * A stream that could not be read whole is reported as such, and that holds even where the records
 * which did parse settled successfully. The half that was lost might have been the half that
 * mattered, and "some of it parsed" is not evidence of anything.
 */
function outcomeOf(reading: Reading, session: string): RunOutcome {
  // Every failure below is this Session's, so it says so once here rather than six times. The Run's
  // `error` column is the only thing an Operator has to go on.
  const failed = (why: string): RunOutcome => ({ ok: false, error: `Session ${session} ${why}` });

  if (reading.unreadable !== undefined) {
    const { line, why } = reading.unreadable;
    return failed(
      `wrote a line that could not be read as a record (${why}), so its output cannot be trusted: ${excerpt(line)}`,
    );
  }
  if (reading.pending.trim() !== "") {
    return failed(
      `ended mid-record after ${reading.records} records, so the Run did not finish: ${excerpt(reading.pending)}`,
    );
  }
  if (reading.records === 0) {
    return failed("produced no output at all, so nothing says whether the Run happened");
  }
  if (!reading.settled) {
    return failed(
      `ended after ${reading.records} records without an agent_settled record, so the Run did not finish. An agent_end is not the end: it can be followed by a retry or a compaction`,
    );
  }
  const answer = reading.settledAnswer;
  if (answer === undefined) {
    return failed(
      `settled after ${reading.records} records with no assistant message, so there is nothing that says the Run succeeded`,
    );
  }
  if (!answeredStopReasons.has(answer.stopReason)) {
    // The stop reason is named because the exit code was zero and this string is all the Operator
    // gets.
    return failed(
      `settled with stopReason ${JSON.stringify(answer.stopReason)} and exited successfully anyway: ${answer.errorMessage ?? `the agent's last message was not an answer (${answer.stopReason})`}`,
    );
  }
  return { ok: true };
}

/** Enough of a line to recognise it by, without putting a whole Session into a log. */
function excerpt(line: string): string {
  const trimmed = line.trim();
  return JSON.stringify(trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed);
}
