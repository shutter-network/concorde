import type { UsageReport } from "../signals/runtime.ts";

/**
 * Subscriptions include records from other runs; only `__openclaw.runId` identifies ours.
 * Keep zero-usage records: the daemon also emits them for failed or interrupted calls.
 */
export function usageOf(payload: unknown, runId: string): UsageReport | undefined {
  const message = fieldsOf(fieldsOf(payload)?.message);
  if (message === undefined || message.role !== "assistant") return undefined;
  if (fieldsOf(message.__openclaw)?.runId !== runId) return undefined;
  const usage = fieldsOf(message.usage);
  if (usage === undefined) return undefined;

  const input = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  return {
    provider: typeof message.provider === "string" ? message.provider : null,
    model: typeof message.model === "string" ? message.model : null,
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
