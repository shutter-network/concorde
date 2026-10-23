import type { RunOutcome } from "../signals/runtime.ts";
import type { Framed } from "./framing.ts";

const answeredStopReasons = new Set(["stop", "length"]);

type Answer = {
  readonly stopReason: string;
  readonly errorMessage: string | undefined;
};

export async function readOutcome(
  records: AsyncIterator<Framed>,
  session: string,
): Promise<RunOutcome> {
  const failed = (why: string): RunOutcome => ({ ok: false, error: `Session ${session}: ${why}` });
  let read = 0;
  let answer: Answer | undefined;

  for (;;) {
    const step = await records.next();
    if (step.done === true) {
      return read === 0
        ? failed("No records received after the prompt was accepted; completion is unknown")
        : failed(
            `Stream ended after ${read} records without agent_settled; the run did not finish`,
          );
    }
    const framed = step.value;
    if (framed.kind === "unreadable") {
      return failed(`Invalid RPC record (${framed.why}): ${excerpt(framed.line)}`);
    }
    if (framed.kind === "truncated") {
      return failed(`Stream ended mid-record after ${read} records: ${excerpt(framed.line)}`);
    }

    read += 1;
    const record = framed.record;
    switch (record.type) {
      case "message_end":
      case "turn_end":
        answer = answerIn(record.message) ?? answer;
        break;
      case "agent_end":
        if (Array.isArray(record.messages)) {
          const found = record.messages.map(answerIn).findLast((one) => one !== undefined);
          if (found !== undefined) answer = found;
        }
        break;
      // agent_end can precede retries or compaction; only agent_settled completes the run.
      case "agent_settled":
        return settlement(failed, answer, read);
      default:
        break;
    }
  }
}

function settlement(
  failed: (why: string) => RunOutcome,
  answer: Answer | undefined,
  read: number,
): RunOutcome {
  if (answer === undefined) {
    return failed(`Agent settled after ${read} records without an assistant message`);
  }
  if (!answeredStopReasons.has(answer.stopReason)) {
    return failed(
      `Agent settled with stopReason ${JSON.stringify(answer.stopReason)}: ${answer.errorMessage ?? `no error details (${answer.stopReason})`}`,
    );
  }
  return { ok: true };
}

function answerIn(message: unknown): Answer | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const fields = message as Record<string, unknown>;
  if (fields.role !== "assistant" || typeof fields.stopReason !== "string") return undefined;
  return {
    stopReason: fields.stopReason,
    errorMessage: typeof fields.errorMessage === "string" ? fields.errorMessage : undefined,
  };
}

function excerpt(line: string): string {
  const trimmed = line.trim();
  return JSON.stringify(trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed);
}
