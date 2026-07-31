# The agent has full read access to Gateway state

The agent-facing HTTP API is not scoped by Session or by user. During any Run the agent may read every User and every prior Signal, whatever Session that Run is executing in.

We considered scoping or disabling those endpoints, so that per-user Session routing would yield structural confidentiality between users. Rejected. Confidentiality between users is exercised by the agent deciding which Messages to send to whom, and by nothing else. Session routing ([ADR-0006](./0006-session-routing-is-chosen-by-the-signal-handler.md)) organises context; it does not isolate.

## Consequences

- Confirms [ADR-0002](./0002-information-flow-between-users-is-the-agents-decision.md) in its strongest form. A Shared Agent is a shared confidant with no structural isolation anywhere in it. A deployment needing real isolation runs two Shared Agents.
- Every endpoint added to the agent-facing API is readable by the agent in every Run. No endpoint may be designed on the assumption that it is Session-scoped.
- Combined with [ADR-0003](./0003-prompt-injection-is-an-accepted-risk.md), a user who successfully steers the agent can reach everything the API exposes. The read-side blast radius of injection is the whole Gateway store, and Signal Handlers are the only thing standing in front of it.
