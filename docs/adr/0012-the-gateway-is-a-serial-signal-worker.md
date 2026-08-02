# The Gateway is a serial Signal worker

Signals are rows in the Gateway store. Producers emit them and execute nothing themselves: the Messenger emits one when a User submits, the Scheduler emits time-based ones, and any future Producer does the same ([ADR-0020](./0020-producers-are-trusted-components-of-the-gateway.md)).

The Gateway runs a **single worker** that takes Signals in arrival order and, for each one:

1. runs the Signal Handler, obtaining zero or more Prompts;
2. runs the Agent Implementation once per Prompt — for `pi`, one fresh process per Run ([ADR-0006](./0006-session-routing-is-chosen-by-the-signal-handler.md));
3. runs the handler's post phase.

Signals are processed one at a time. There is no parallelism across Sessions.

We considered per-Session serialization with parallelism across Sessions. Rejected on two grounds. Concurrent Runs would edit the same Workspace files with no way to reconcile them, and where a shared token rate is the binding constraint, running Prompts in parallel does not raise aggregate throughput. The Workspace is therefore **global to the Shared Agent**, not Session-scoped, which is only safe because execution is serial.

The counter-argument, for whoever revisits this: Runs spend substantial wall-clock in tool execution rather than generation — `pi`'s toolset is read/write/edit/`bash`, so Runs are tool-heavy by design — and the token budget is idle throughout. What parallelism would really buy is not throughput but relief from head-of-line blocking, where a short question waits behind a long research task. If that becomes the felt problem, this is the decision to reopen, and it requires scoping the Workspace per Session first.

## Consequences

- **A Signal is a durable entity with processing state**, not an ephemeral event. Submitting one only inserts and acknowledges; the answer never comes back inline. This is why users poll an Outbox.
- **Signal sources are decoupled from execution.** Adding one means writing rows, not touching the worker.
- **Throughput is one Run at a time.** A Run that takes two minutes blocks every user and every scheduled Signal behind it.
- Restart is safe, since unprocessed Signals are still in the table. A Signal whose Run crashed mid-flight is **marked failed and never re-run** — [ADR-0017](./0017-failed-runs-are-not-retried.md) settles what this ADR left open.
- The `pi` adapter invokes the runtime inside a container. Per [ADR-0004](./0004-runtime-confinement-is-the-deployments-responsibility.md) that confinement is the deployment's choice rather than a framework guarantee.
