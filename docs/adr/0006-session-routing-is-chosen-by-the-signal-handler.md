# Session routing is chosen by the Signal Handler

The framework fixes no session topology. Each Signal Handler declares which agent session its prompt is delivered to: a fresh session, or a named existing one. One shared session for the whole agent, one session per user, one per run, and hybrids of these are therefore all expressible without framework changes.

We considered fixing a single topology — one continuous session per Shared Agent, with per-user threads kept only in the Gateway — and rejected it as over-committing on behalf of deployments whose needs differ.

## Consequences

- Session routing organises **context and continuity**. It is explicitly **not** a confidentiality mechanism: by [ADR-0011](./0011-the-agent-has-full-read-access.md) an agent in a partitioned Session can read around the partition over the agent-facing API.
- **No Prompt ever runs concurrently with another**, so Session contention does not arise. This ADR originally said concurrency was a per-deployment property — that Prompts on separate Sessions could run in parallel while same-Session Prompts serialized. [ADR-0012](./0012-the-gateway-is-a-serial-signal-worker.md) supersedes that: the worker is serial *globally*, regardless of Session. Which is fortunate, because `pi`'s `SessionManager` has no locking whatsoever — it slurps the session file into memory, appends with `appendFileSync`, and rewrites the whole file from in-memory state, so two live writers on one session silently clobber each other. Reopening per-Session parallelism would require solving that first.
- **Context growth is a per-deployment problem.** A long-lived shared session will exhaust its context window, and whatever is compacted away is the agent's memory of some user's history. Retention is a deployment design question.
- Adapters must map "fresh" and "named" onto each runtime. `pi` supports this directly through `--session`, fork and clone; OpenClaw's `sessionKey` is comparable. Only `pi` supports branching.
