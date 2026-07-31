# Failed Runs are not retried

A Run that fails, or a worker that dies mid-Run, marks its Signal failed. The framework never re-runs it.

Runs are not idempotent. Before failing, one may already have sent Messages into Outboxes, written Workspace files, created Users over the agent-facing API, and made external calls through `bash` — and its Prompt is already appended to the Session on disk. Replaying it duplicates all of that and shows the agent the same Prompt twice.

The Signal Handler's post phase runs regardless, with a flag telling it the Run failed. That is the entirety of the framework's failure handling.

We considered emitting a failure Signal, so that retry and user notification could be written as ordinary Signal Handlers. Rejected as unnecessary indirection: the post phase is already arbitrary code with store access, so a deployment that wants to notify someone or re-insert the Signal does it there — and no framework-level retry loop can be created by accident.

## Consequences

- Delivery is **at-most-once**. A Signal can be dropped after partial effect, and nothing in the framework detects or compensates for the partial state. Handlers that care must make their Runs safe to abandon halfway.
- **There is no timeout of any kind**, on a Run or on a Signal Handler. We considered making a Run timeout mandatory, on the grounds that the worker is globally serial ([ADR-0012](./0012-the-gateway-is-a-serial-signal-worker.md)) so one hung `bash` command halts the agent for every party. Rejected: because failed Runs are never retried, a timeout that fires early destroys work that has already sent Messages and written the Workspace, and the framework cannot know the right number for a deployment it knows nothing about. A wrong mandatory timeout is worse than none. Signal Handlers get no timeout either, for a different reason — they are the Operator's own code and the Operator is trusted by every Party, so the framework does not defend against them.
- **The consequence is an availability hole, and it is accepted.** Combined with [ADR-0003](./0003-prompt-injection-is-an-accepted-risk.md), a User who steers the agent into an unbounded tool loop halts the Shared Agent for every Party until an Operator intervenes. Restarting the process is the remedy, and it is a deployment responsibility ([ADR-0004](./0004-runtime-confinement-is-the-deployments-responsibility.md)).
- On worker restart, Signals left in `processing` are marked failed and never re-run, since they may have partially executed.
