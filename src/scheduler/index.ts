/**
 * The Scheduler, from `shared-agent-framework/scheduler`.
 *
 * `createScheduler` is the whole of it for an Operator. Hand it the Db and the Signal Worker, and
 * it registers its Agent routes on the server it is given. Then key it in the Gateway's record like
 * every other Component: `start` arms its firing timer and `stop` cancels it.
 *
 * It answers with the programmatic interface an Operator always has. That is `schedule`, an upsert
 * by name, plus `list`, `cancel` and the awaitable `tick`. A `schedule` call the Scheduler will not
 * accept throws `ScheduleSpecError` before anything is persisted. The Agent route catches exactly
 * that and answers 400.
 *
 * `scheduleFiredKind` and `ScheduleFiredRecord` are the two halves of the Signal contract, so a
 * Handler for a matured Schedule is `SignalHandler<ScheduleFiredRecord>`. Registering no Handler
 * for that `kind` leaves a stored Schedule firing into a permanently failed Signal. This subpath
 * also carries the one table. A Schedule references nobody, so a barrel carrying it alone generates
 * cleanly.
 *
 * @example
 * A Gateway that wakes itself every morning, and the Handler the fire reaches.
 * ```ts
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import type { ScheduleFiredRecord } from "shared-agent-framework/scheduler";
 * import { createScheduler, scheduleFiredKind } from "shared-agent-framework/scheduler";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   agentListen: { host: "127.0.0.1", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, worker, agentServer }) => ({
 *     scheduler: createScheduler({ db, worker, agentServer }),
 *   }),
 *   handlers: () => ({
 *     [scheduleFiredKind]: templateHandler<ScheduleFiredRecord>({
 *       template: new URL("./prompts/digest.hbs", import.meta.url),
 *       session: (signal) => signal.payload.scheduleName,
 *       data: (signal) => signal.payload,
 *     }),
 *   }),
 * });
 *
 * await gateway.start();
 *
 * // The Operator's own Schedule, declared at boot. Re-running this converges to one row.
 * await gateway.components.scheduler.schedule({
 *   name: "morning-digest",
 *   spec: { kind: "cron", expr: "0 7 * * *", tz: "Europe/Berlin" },
 *   data: { audience: "everybody" },
 * });
 * ```
 *
 * @module
 */

export type { Scheduler, SchedulerOptions } from "./scheduler.ts";
export { createScheduler, scheduleFiredKind } from "./scheduler.ts";
export type {
  ScheduleFiredRecord,
  ScheduleInput,
  ScheduleOutcome,
  ScheduleRecord,
  ScheduleSpec,
} from "./schedules.ts";
export { ScheduleSpecError } from "./schedules.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit` can
// see. It never looks inside a wrapper object. `schedulerSchema` keeps its prefix, because
// `export *` drops a name that resolves to two bindings.
export * from "./schema.ts";
