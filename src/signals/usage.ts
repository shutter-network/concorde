import { type AnyColumn, and, eq, gte, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import type { Component } from "../gateway/components.ts";
import type { WorkerHandle } from "./routes.ts";
import type { UsageReport } from "./runtime.ts";
import { signalsTables, usage } from "./schema/index.ts";

export type UsageOptions = {
  readonly db: Db;
};

export type UsageQuery = {
  /** Select one User's records. Use `null` for Runs with no User. Omit to include all records. */
  readonly userId?: string | null;
  /** Include records at or after this time. Omit to start from the first record. */
  readonly since?: Date;
  /** Include records before this time. Omit to leave the end time unrestricted. */
  readonly until?: Date;
};

export type UsageTotals = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
  /** Number of model calls included in the totals. */
  readonly calls: number;
};

/**
 * Reads the Usage records saved by the Signal Worker, one per model call. Records are kept
 * after a restart. Token counts come from the provider. Token counts alone do not tell you
 * the cost: `cost` depends on the model price used by the agent implementation.
 * `createGateway` creates this component for you.
 */
export type Usage = Component & {
  /** Add up matching records in the database, using the User and time filters. */
  total(query?: UsageQuery): Promise<UsageTotals>;
};

export function createUsage(options: UsageOptions): Usage {
  const handle = options.db.handle(signalsTables);

  return {
    async start() {},
    async stop() {},

    async total(query = {}) {
      const bounds: SQL[] = [];
      if (query.userId === null) bounds.push(isNull(usage.userId));
      else if (query.userId !== undefined) bounds.push(eq(usage.userId, query.userId));
      if (query.since !== undefined) bounds.push(gte(usage.recordedAt, query.since));
      if (query.until !== undefined) bounds.push(lt(usage.recordedAt, query.until));

      const [sums] = await handle
        .select({
          input: summed(usage.input),
          output: summed(usage.output),
          cacheRead: summed(usage.cacheRead),
          cacheWrite: summed(usage.cacheWrite),
          totalTokens: summed(usage.totalTokens),
          cost: summed(usage.cost),
          calls: sql<number>`count(*)`.mapWith(Number),
        })
        .from(usage)
        .where(and(...bounds));
      if (sums === undefined) throw new Error("A usage sum returned no row");
      return sums;
    },
  };
}

function summed(column: AnyColumn): SQL<number> {
  return sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
}

export async function recordUsage(
  handle: WorkerHandle,
  runId: string,
  userId: string | null,
  report: UsageReport,
): Promise<void> {
  await handle.insert(usage).values({
    runId,
    userId,
    provider: report.provider,
    model: report.model,
    input: report.input,
    output: report.output,
    cacheRead: report.cacheRead,
    cacheWrite: report.cacheWrite,
    totalTokens: report.totalTokens,
    cost: report.cost,
  });
}
