/**
 * The Scheduler component owns Schedules and wakes the deployment when one matures. A Schedule is a
 * named, stored instruction to emit one Signal at future times: a cron expression in a named IANA
 * time zone, or a single absolute instant. Its name is its whole identity, in one flat namespace
 * the agent and the Operator share, so creating a name that exists updates it.
 *
 * {@link createScheduler} makes one. {@link Scheduler} is what comes back, and `schedule` is the
 * upsert both creators go through. {@link scheduleFiredKind} and {@link ScheduleFiredRecord} are
 * the two halves of the Signal contract, so a Handler for a matured Schedule is written
 * `SignalHandler<ScheduleFiredRecord>` with no string literal of its own.
 *
 * Construct the Signal Worker first, which every fire emits into. Then register a Handler under
 * that one `kind`: with none, a stored Schedule fires into a Signal that fails on every attempt.
 * Passing no Agent server registers no route, which keeps the agent away from Schedules and leaves
 * the programmatic API to the Operator.
 *
 * A missed fire is never replayed. Every next fire is derived forward from now, at each boot and
 * after each fire, so a daily digest arranged before a week of downtime fires once afterwards
 * rather than seven times.
 *
 * The table is on `shared-agent-framework/scheduler/schema` and nowhere else. It references no
 * other component's table, so that subpath can be listed on its own.
 *
 * @example
 * A Gateway that wakes itself every morning, and the Handler each fire reaches.
 * ```ts
 * import { readFileSync } from "node:fs";
 * import { createGateway } from "shared-agent-framework/gateway";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import type { ScheduleFiredRecord } from "shared-agent-framework/scheduler";
 * import { createScheduler, scheduleFiredKind } from "shared-agent-framework/scheduler";
 * import { templateHandler } from "shared-agent-framework/signals";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   // Drop `agentServer` here and the routes vanish, leaving the programmatic API below.
 *   extend: ({ db, worker, agentServer }) => ({
 *     scheduler: createScheduler({ db, worker, agentServer }),
 *   }),
 *   handlers: () => ({
 *     [scheduleFiredKind]: templateHandler<ScheduleFiredRecord>({
 *       template: readFileSync(new URL("./prompts/digest.hbs", import.meta.url), "utf8"),
 *       session: (signal) => signal.payload.scheduleName,
 *       data: (signal) => signal.payload,
 *     }),
 *   }),
 * });
 *
 * await gateway.start();
 *
 * // The Operator's own Schedule, arranged at boot. Running this again converges to one row.
 * const { schedule } = await gateway.components.scheduler.schedule({
 *   name: "morning-digest",
 *   spec: { kind: "cron", expr: "0 7 * * *", tz: "Europe/Berlin" },
 *   data: { audience: "everybody" },
 * });
 * console.log(schedule.nextFireAt);
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
// The one union this subpath still takes from `schema.ts`, and the array it is derived from. Both
// are on `/schema` too, which is the one overlap the split leaves: the array is what the column's
// check constraint is compiled from, and `ScheduleRecord.kind` is declared with the union and is
// on the wire (ADR-0055).
export type { ScheduleKind } from "./schema/index.ts";
export { scheduleKinds } from "./schema/index.ts";
