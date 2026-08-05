/**
 * The Scheduler, from `shared-agent-framework/scheduler`.
 *
 * A subpath of its own, like the other opt-in parts, so that what a deployment depends on is
 * legible from its import statements: a deployment with no time-based behaviour imports nothing
 * from here, and one that does is opting the Scheduler in and wiring it like the HTTP Messenger
 * (ADR-0018).
 *
 * `createScheduler` is the whole of it for an Operator: hand it the Db and the Signal Worker, and
 * it registers `schedulerMigrations` with that Db (ADR-0032). Then put it in the Gateway's record
 * like every other part: it is a Component, and the day its autonomous timer lands its `start`
 * arms one and its `stop` cancels it. It imposes **no** construction-order dependency, unlike the
 * HTTP Messenger: a Schedule references nobody, so its migration folder applies wherever it lands.
 *
 * What it answers with is the programmatic interface an Operator always has: `schedule` (an upsert
 * by name), `list`, `cancel`, and the awaitable `tick` due-check.
 *
 * `scheduleFiredKind` and `ScheduleFiredRecord` are the two halves of this part's Signal contract,
 * exported so that an Operator's Handler map is neither a string literal that can drift nor a
 * payload shape re-declared by hand: a Handler for a matured Schedule is
 * `SignalHandler<ScheduleFiredRecord>`. Registering no Handler for that `kind` is a stored
 * Schedule that fires into a permanently failed Signal (ADR-0017).
 *
 * `schedulerMigrations` is exported because a pre-deploy migration entry point should not have to
 * construct the part that owns the tables — and, for this part, should not have to construct a
 * Signal Worker and a Runtime to get at them.
 *
 * The agent-facing routes are a later ticket, so no route plugin is exported yet.
 */

export { schedulerMigrations } from "./migrations.ts";
export type { Scheduler, SchedulerOptions } from "./scheduler.ts";
export { createScheduler, scheduleFiredKind } from "./scheduler.ts";
export type {
  ScheduleFiredRecord,
  ScheduleInput,
  ScheduleOutcome,
  ScheduleRecord,
  ScheduleSpec,
} from "./schedules.ts";
