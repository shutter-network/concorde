# The core framework stays generic

> **Amended by [ADR-0029](./0029-users-are-a-part-of-their-own.md) and
> [ADR-0030](./0030-passwords-are-traded-for-bearer-tokens.md).** Users belong to the
> **User Manager**, not the Messenger, and there is no **Authenticator** — the seam is
> token issuance. Both substitutions leave this ADR's argument intact: authentication is
> still outside the core, and it is still an extension point. Only the name and the
> owner changed.

Where a concern is not intrinsic to mediating a Shared Agent, the framework declines to decide it and pushes it to an extension point. Confidentiality policy, injection defence, Agent Implementation confinement, Message payload shapes, authorization, and authentication are all outside the core for this one reason.

This is the shared rationale behind [ADR-0002](./0002-information-flow-between-users-is-the-agents-decision.md), [0003](./0003-prompt-injection-is-an-accepted-risk.md), [0004](./0004-runtime-confinement-is-the-deployments-responsibility.md), [0007](./0007-messages-carry-arbitrary-json-payloads.md), [0009](./0009-signal-handlers-are-arbitrary-code.md) and [0011](./0011-the-agent-has-full-read-access.md), and it should be read as the reason behind any future "the deployment decides that."

What the core does own: Signals and their durable queue, Signal Handler dispatch, Session routing, Run execution against an Agent Implementation, and the agent-facing HTTP API. Users, Messages, and Outboxes belong to the Messenger, which is a Producer rather than part of the core ([ADR-0020](./0020-producers-are-trusted-components-of-the-gateway.md)).

## Consequences

- **The framework guarantees little; what it provides is shape.** A Shared Agent is reachable only through the Gateway, every Signal comes from a trusted Producer, every Message has exactly one named recipient. Departing from that shape takes deliberate configuration, and that is the entire sense in which a Shared Agent is Shielded.
- Deployments live in the extension points: Signal Handlers, the Authenticator, the Runtime. Each is arbitrary code.
- Any proposed addition to the core should first face the question "is this intrinsic to mediation?"
