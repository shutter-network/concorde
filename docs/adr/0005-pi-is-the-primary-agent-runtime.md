# pi is the primary Agent Implementation

> **Renamed.** This decision was recorded as "pi is the primary Agent Runtime", and the
> filename still says so. What it calls the Agent Runtime is now the **Agent
> Implementation**, and what it calls the runtime adapter is now the **Runtime**: the word
> "runtime" had come to mean three things at once, and
> [ADR-0033](./0033-an-agent-is-a-container-and-one-function.md) settles which one keeps
> it. The filename is left alone because it is what twenty other documents link to.

`pi` is the Agent Implementation the framework targets first. Others, `openclaw` in particular, must remain swappable behind a Runtime.

This is a deliberate trade against the more obvious alternative. `pi` is a coding-agent harness, drivable as a JSONL subprocess, over an RPC protocol, or as an in-process TypeScript SDK. `openclaw` is close to the opposite — a long-running daemon that already ships messaging channels, per-peer session scoping, bearer auth with scopes, cron, and webhooks, which is a large fraction of what our Gateway is specified to do. Building on OpenClaw would mean writing considerably less code; building on `pi` means the Gateway must own user management, mailboxes, scheduling, and session lifecycle itself.

> **Rationale incomplete.** The trade-off above is recorded; the reason for choosing `pi` in spite of it has not yet been stated and should be filled in.

> **Corrections to an earlier description of `pi`.** This ADR previously called `pi` "a minimal harness with four built-in tools, no MCP, no auth, no tenant model, no scheduling." Verified against 0.83.0, three of those claims are wrong. There are **seven** built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), of which four are enabled by default. It **does** have a credential layer — `~/.pi/agent/auth.json`, OAuth and API keys, `ModelRuntime.checkAuth()`. And it is not minimal: it ships an extensions API, skills, prompt templates, compaction, session trees, and HTML export. What it genuinely lacks is MCP, sub-agents, permission prompts, scheduling, and any tenant model.
>
> This makes the gap to OpenClaw smaller than stated, so choosing `pi` costs less than this ADR claims — but it does **not** close the rationale gap, because everything `pi` turns out to have is agent-side. None of it is user management, mailboxes, or scheduling, so the consequences below stand unchanged.

## Consequences

- The Gateway implements user management, authentication, mailboxes, and time-based Signals itself, because `pi` provides none of these. None of it may be delegated to an Agent Implementation's own features.
- The Runtime contract is shaped by the weaker Agent Implementation. Capabilities OpenClaw has and `pi` lacks (tool allow/deny, per-peer isolation, hot config reload) cannot be assumed by the framework.
