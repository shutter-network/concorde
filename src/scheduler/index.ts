/**
 * The Scheduler, from `shared-agent-framework/scheduler`.
 *
 * A subpath of its own, like the other opt-in parts, so that what a deployment depends on is
 * legible from its import statements: a deployment with no time-based behaviour imports nothing
 * from here, and one that does is opting the Scheduler in and wiring it like the HTTP Messenger
 * (ADR-0018).
 *
 * `createScheduler` is the whole of it for an Operator: hand it the Db and the Signal Worker, and
 * it registers its agent-facing routes on the server it was given (ADR-0032). Then put it in the
 * Gateway's record like every other part: it is a Component, and the day its autonomous timer
 * lands its `start` arms one and its `stop` cancels it. It imposes **no** construction-order
 * dependency: a Schedule references nobody.
 *
 * What it answers with is the programmatic interface an Operator always has: `schedule` (an upsert
 * by name), `list`, `cancel`, and the awaitable `tick` due-check. A `schedule` call whose `spec` is
 * a cron with an invalid `expr` or an unknown `tz`, or whose `until` is malformed, throws
 * `ScheduleSpecError` before anything is persisted — the refusal the agent-facing routes a later
 * ticket surface as a 400, exported here so that layer can catch exactly it.
 *
 * `scheduleFiredKind` and `ScheduleFiredRecord` are the two halves of this part's Signal contract,
 * exported so that an Operator's Handler map is neither a string literal that can drift nor a
 * payload shape re-declared by hand: a Handler for a matured Schedule is
 * `SignalHandler<ScheduleFiredRecord>`. Registering no Handler for that `kind` is a stored
 * Schedule that fires into a permanently failed Signal (ADR-0017).
 *
 * It registers **no migration**. The table comes from
 * `shared-agent-framework/scheduler/schema`, which an Operator barrels and applies with their own
 * `drizzle-kit` ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md)).
 *
 * The agent-facing routes register on the Agent server the constructor is given; passing none is the
 * disable switch, so a route plugin is an internal of the part rather than a separate export.
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
