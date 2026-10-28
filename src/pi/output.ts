import type { RunOutcome, UsageReport } from "../signals/runtime.ts";
import type { Framed } from "./framing.ts";

const answeredStopReasons = new Set(["stop", "length"]);

type Answer = {
  readonly stopReason: string;
  readonly errorMessage: string | undefined;
};

export type Watch = {
  /** Ask the agent to stop. The caller keeps reading until `agent_settled`. */
  readonly abort: () => void;
  /** Stop the agent and fail the Run with `limited: true` if token usage goes over this limit. */
  readonly usageLimit?: number;
};

export async function readOutcome(
  records: AsyncIterator<Framed>,
  session: string,
  watch?: Watch,
): Promise<RunOutcome> {
  const usage: UsageReport[] = [];
  let limited: string | undefined;
  const failed = (why: string): RunOutcome => ({
    ok: false,
    error: `Session ${session}: ${why}`,
    usage,
    ...(limited === undefined ? {} : { limited: true }),
  });
  let read = 0;
  let answer: Answer | undefined;
  let named: Pick<UsageReport, "provider" | "model"> = { provider: null, model: null };
  let used = 0;

  // Calls that finish after the abort are still added, since the provider charges for them.
  function add(report: UsageReport): void {
    usage.push(report);
    used += report.totalTokens;
    const limit = watch?.usageLimit;
    if (limited === undefined && limit !== undefined && used > limit) {
      limited = `Usage limit reached: ${used} of ${limit} tokens`;
      watch?.abort();
    }
  }

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
      // Count each call once at message_end; turn_end and agent_end repeat the same message.
      case "message_end": {
        answer = answerIn(record.message) ?? answer;
        const report = usageIn(record.message, named);
        if (report !== undefined) {
          named = { provider: report.provider, model: report.model };
          add(report);
        }
        break;
      }
      case "turn_end":
        answer = answerIn(record.message) ?? answer;
        break;
      // Summarizing the Session uses a separate model call, reported here instead of in a message.
      case "compaction_end": {
        const report = usageIn(fieldsOf(record.result), named, true);
        if (report !== undefined) add(report);
        break;
      }
      case "agent_end":
        if (Array.isArray(record.messages)) {
          const found = record.messages.map(answerIn).findLast((one) => one !== undefined);
          if (found !== undefined) answer = found;
        }
        break;
      // agent_end can precede retries or compaction; only agent_settled completes the run.
      case "agent_settled":
        return limited === undefined ? settlement(failed, answer, read, usage) : failed(limited);
      default:
        break;
    }
  }
}

function settlement(
  failed: (why: string) => RunOutcome,
  answer: Answer | undefined,
  read: number,
  usage: readonly UsageReport[],
): RunOutcome {
  if (answer === undefined) {
    return failed(`Agent settled after ${read} records without an assistant message`);
  }
  if (!answeredStopReasons.has(answer.stopReason)) {
    return failed(
      `Agent settled with stopReason ${JSON.stringify(answer.stopReason)}: ${answer.errorMessage ?? `no error details (${answer.stopReason})`}`,
    );
  }
  return { ok: true, usage };
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

function usageIn(
  message: unknown,
  named: Pick<UsageReport, "provider" | "model">,
  anyRole = false,
): UsageReport | undefined {
  const fields = fieldsOf(message);
  if (fields === undefined || (!anyRole && fields.role !== "assistant")) return undefined;
  const usage = fieldsOf(fields.usage);
  if (usage === undefined) return undefined;
  const input = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  return {
    provider: typeof fields.provider === "string" ? fields.provider : named.provider,
    model: typeof fields.model === "string" ? fields.model : named.model,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: amount(fieldsOf(usage.cost)?.total),
  };
}

function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function excerpt(line: string): string {
  const trimmed = line.trim();
  return JSON.stringify(trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed);
}
