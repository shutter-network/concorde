# Messages carry arbitrary JSON payloads

A Message travels between one User and the agent, in either direction. An **outbound** Message is what the agent addresses to a User, and it lands in that User's Outbox; an **inbound** Message is what a User sends in, and the Messenger emits a Signal from it. Either way the payload is arbitrary JSON — no framework-defined schema, no registry of payload types.

Inbound Messages were nearly called **Submissions**, and the word survives in prose here and there. One entity with a direction won because the reason the Messenger keeps this log at all is so the agent can query a User's history, and a history is inherently both directions — two entities would make that read a `UNION` of two shapes.

We considered a fixed envelope with declared payload types, so that a generic client could render any deployment's messages. Rejected: user-facing clients of a Shared Agent are built for that specific agent and may carry domain knowledge, so there is no generic client to serve. A type registry would cost every deployment something in order to buy a property nobody needs.

Messages are deliberately parallel in shape to Signals — the same idea travelling the other way — but they do **not** correspond one to one. A single Run may emit no Messages, one, or several addressed to different users, and a Message may arise from a timed Signal that no user sent.

## Consequences

- Clients are deployment-specific. The framework ships no generic renderer, and a client cannot be reused across Shared Agents without knowing their payload conventions.
- **The Gateway stamps no provenance onto the envelope** — no originating Run or Signal identifier. We considered it, as the Gateway knows both with certainty and an agent restating them is less reliable. It leaks: one Signal may cause Messages to several users, so a Signal identifier on Alice's Message can reveal that Bob acted, and a Run identifier discloses how much activity happened in between. Framework-generated identifiers that span users are a covert channel across the very boundary that per-user session routing exists to create.
- Correlation is therefore the agent's job, expressed in the payload, where the agent can decide what each recipient is allowed to know. A client cannot otherwise tell a reply from an unprompted Message.
- Generalises to a rule: **the Gateway must expose no identifier or counter whose value is influenced by other users' activity.** Message identifiers and Outbox cursors must be scoped per user, not drawn from a global sequence.
- **The Outbox holds outbound Messages only.** `seq`, the per-User counter that doubles as the Outbox cursor ([ADR-0015](./0015-outboxes-are-cursor-read-logs.md)), is assigned to outbound Messages and is null on inbound ones. So a User polling their Outbox does not receive their own Messages echoed back, and the agent's history query simply ignores direction.
- **The durable record lives here, not in the Session.** A Session is a lossy cache of it: [ADR-0006](./0006-session-routing-is-chosen-by-the-signal-handler.md) notes that compaction discards history, and another User's history was never in the current Session at all ([ADR-0011](./0011-the-agent-has-full-read-access.md)). This log is the only place either is recoverable.
