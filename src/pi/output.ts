/**
 * Reading the Agent Implementation's JSONL output into a Run outcome.
 *
 * This is the highest-risk logic in the `pi` adapter. That is why it is a module of its own, with
 * no process in it. Three properties of `pi --mode json` each produce a plausible wrong answer
 * rather than an error. Getting a Run to work once would catch none of them:
 *
 * 1. **The exit code says nothing.** `--mode json` exits 0 on model and API errors. Only
 *     `mode: "text"` sets a non-zero exit, and it does that by reading the last assistant message's
 *     `stopReason` itself. So that is what is read here, and this function is not handed an exit code
 *     at all.
 * 2. **The terminal record is `agent_settled`, not `agent_end`.** `agent_end` fires per low-level
 * agent run. A retry or a compaction can
 *     follow it, and each continues the same Run. Treating the first `agent_end` as the end
 *     truncates the Run. It also reports a retryable error as the outcome, where the retry then
 *     succeeded. `agent_settled` is missing from `pi`'s own
 *     `docs/json.md`, which is stale.
 * 3. **Framing is LF-only.** `node:readline` also splits on U+2028 and U+2029. Both are legal
 *     inside JSON strings, and `JSON.stringify` emits them literally. So a record containing either
 *     arrives as two malformed halves. Nothing here uses `readline`: lines are cut on `\n` alone.
 *
 * A fourth property is not `pi`'s fault and matters as much. Output can stop early, because a
 * container was killed or a pipe was closed. An unreadable or unfinished stream is a failed Run
 * with a reason. It is never a hang, and never a success inferred from the records that happened to
 * parse.
 */

import type { RunOutcome } from "../signals/runtime.ts";

/**
 * The stop reasons that mean the agent finished answering. Anything else fails.
 *
 * An allow-list rather than a list of failures, which is the difference between "never a false
 * success" and nearly that. `pi`'s own `mode: "text"` exit-code rule is the other way round. It
 * fails on `error` and `aborted`, and prints anything else. Copying it here would report a Run as
 * successful on `pending`, which a streaming assistant message carries. It would do the same on
 * `toolUse`, where the agent stopped to call a tool and never continued. Neither is an answer. Both
 * are reachable if the stream is cut in the wrong place, and both look like success.
 *
 * `length` is here and is a success. The model ran out of output tokens, so the answer is truncated
 * rather than absent. `pi` treats it the same way.
 */
const answeredStopReasons = new Set(["stop", "length"]);

/** What is known about the agent's answer, which is all the outcome depends on. */
type Answer = {
  readonly stopReason: string;
  readonly errorMessage: string | undefined;
};

/** Everything carried across the stream. Mutable, and local to one interpretation. */
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
 * Takes the raw bytes rather than decoded text. A chunk boundary falls wherever the operating
 * system puts it, including inside a multi-byte character. U+2028 is one. A subprocess's `stdout`
 * is exactly this, and taking text instead would move the decoding to the caller.
 *
 * It also takes the Session, and names it in every failure. The Run's `error` column is the only
 * thing an Operator has to go on. `Session user_42 produced no output at all` says where to look.
 *
 * The whole source is consumed even once the outcome is known. A subprocess whose stdout stops
 * being read blocks as soon as the pipe fills. That would turn a finished Run into a hang. There
 * are no timeouts anywhere.
 *
 * @param source The container's stdout, as raw chunks.
 * @param session The Session this Run used. It is named in every failure message.
 * @returns Whether the Run answered, and the reason if it did not. It never throws on bad output.
 *
 * @example
 * ```ts
 * import { interpretPiOutput } from "shared-agent-framework/pi";
 *
 * const lines = [
 *   { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
 *   { type: "agent_settled" },
 * ];
 * const stdout = (async function* () {
 *   yield new TextEncoder().encode(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
 * })();
 *
 * console.log(await interpretPiOutput(stdout, "user_42")); // { ok: true }
 * ```
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

/** Cuts `text` into lines on LF, and on nothing else (trap 3). */
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

/** Reads one framed line as a record, or notes that it could not be read. */
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
      // Run (trap 2).
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

/** The answer in a message, if that message is one of the agent's. */
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
 * The outcome, in the order the reasons take precedence.
 *
 * A stream that could not be read completely is reported as such. That holds even when the records
 * that did parse settled successfully. The missing half might have been the one that mattered, and
 * "some of it parsed" is not evidence.
 */
function outcomeOf(reading: Reading, session: string): RunOutcome {
  // Every failure below is this Session's, so it says so once here rather than six times. The Run's
  // `error` column is the only thing an Operator has to go on.
  const failed = (why: string): RunOutcome => ({ ok: false, error: `Session ${session} ${why}` });

  if (reading.unreadable !== undefined) {
    const { line, why } = reading.unreadable;
    return failed(
      `wrote a line that could not be read as a record — ${why} — so its output cannot be trusted: ${excerpt(line)}`,
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
    // gets (trap 1).
    return failed(
      `settled with stopReason ${JSON.stringify(answer.stopReason)} and exited successfully anyway: ${answer.errorMessage ?? `the agent's last message was not an answer (${answer.stopReason})`}`,
    );
  }
  return { ok: true };
}

/** Enough of a line to recognise it, without putting a whole Session in a log. */
function excerpt(line: string): string {
  const trimmed = line.trim();
  return JSON.stringify(trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed);
}
