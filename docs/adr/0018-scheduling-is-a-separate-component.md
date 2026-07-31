# Scheduling is a separate component, not a field on Signal

> **Accepted but deferred: the Scheduler is not in v1.** Nothing structural depends on it — this ADR's own consequence is that a Producer needs no new framework concepts — so it can be added later without touching the framework. It is deferred because it owns the only calendar arithmetic in the system (recurrence, next-fire, time zones), and because the self-wakeup risk noted below got sharper: [ADR-0017](./0017-failed-runs-are-not-retried.md) now specifies **no Run timeout at all**, so an agent that can schedule its own wakeups can deny service to every Party with no automatic recovery. Everything below stands as the design for when it is built.

Time-based Signals come from a **Scheduler**: a Producer inside the Gateway with its own data model, which the agent may call through the agent-facing API to arrange future work. It emits a Signal when the time comes. Signals are always processed as soon as the worker reaches them and carry no scheduling information.

We considered a nullable `due_at` on Signal, so that one table and one code path would serve immediate submissions, recurring schedules, and agent-scheduled follow-ups. Rejected on three grounds:

- It gives Signal two meanings — something that arrived, and something intended for later. The Signal log would stop being an immutable record of what happened, and the log would start holding things that have not occurred.
- `due_at` expresses one-shot delays only. Recurrence needs its own representation regardless, so a Scheduler would come into existence anyway and `due_at` would then be redundant.
- [ADR-0012](./0012-the-gateway-is-a-serial-signal-worker.md) already separates producers from the consumer: producers insert Signals and execute nothing. A Scheduler is simply another Producer alongside the Messenger. Holding schedules in the Signal table would blur that separation rather than use it.

## Consequences

- The Scheduler owns recurrence, cancellation, next-fire computation, and time zones. None of it touches the Gateway's core, per [ADR-0013](./0013-the-core-framework-stays-generic.md).
- The Scheduler contributes its own agent-facing routes to the Gateway application, since it is a component rather than a peer. Its scheduling endpoint is disableable like user management, since an agent that can wake itself can be steered into doing so in a loop, and the worker has only one lane.
- Because the Scheduler is an ordinary Signal producer, further producers — webhooks, mail, chat bridges — need no new framework concepts.
- The framework ships the Scheduler as one of its two Producers, alongside the Messenger.
