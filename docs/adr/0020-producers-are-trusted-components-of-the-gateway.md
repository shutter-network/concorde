# Producers are trusted components of the Gateway

> **Amended by [ADR-0029](./0029-users-are-a-part-of-their-own.md).** Users, and the
> authenticating of them, belong to the **User Directory** — a part of the Gateway that
> is *not* a Producer, since it emits no Signals. So "Users, Messages, and Outboxes
> belong to the Messenger" below reads "Messages and Outboxes", and the Messenger reads
> the already-authenticated User off the request rather than authenticating anyone. The
> decision this ADR records is untouched: every part inside the Gateway is trusted, and a
> Signal's attribution is still the Messenger's to write.

The Gateway is a composite. Its **core** holds the Signal queue, Signal Handler dispatch, Run execution, and the agent-facing HTTP API. Around the core sit **Producers**: trusted components that emit Signals into the queue. Two are shipped.

- **Messenger** — owns everything Users touch. It authenticates Users, accepts their submissions, holds Outboxes, and may carry higher-level messaging concepts such as conversations. It emits Signals whose payloads carry the message and the submitting User's id.
- **Scheduler** — owns recurrence, cancellation, and next-fire computation ([ADR-0018](./0018-scheduling-is-a-separate-component.md)). It emits a Signal when a schedule matures.

Users have no access to Signals at all. They talk to the Messenger and to nothing else.

Producers are **privileged**: whatever a Producer writes into a Signal payload is taken as fact by the core, including claims about who the Signal came from. That is precisely why they are components of the Gateway rather than peers outside it. A Producer as a separate service would have to be authenticated by the core — creating an authentication problem between our own components while removing one from the core.

We considered peer services with their own stores and HTTP APIs. Rejected for now: the entire conceptual gain lies in the boundary, which a module boundary already supplies, whereas peers would add three agent-facing interfaces to describe to the agent plus the producer-authentication problem. Nothing here forecloses that split later.

## Consequences

- **Messaging leaves the core.** An agent driven only by schedules and webhooks needs no Messenger at all. This is [ADR-0013](./0013-the-core-framework-stays-generic.md) applied: messaging is not intrinsic to mediating a Shared Agent, so it does not belong in the middle of one.
- **Supersedes [ADR-0019](./0019-signals-are-attributed-arrival-records.md).** Signal has no `user_id` column. The core authenticates nobody, so attribution is not a fact it holds — it is a term in the Messenger's payload contract. The impersonation objection that forced a column disappears, because the Messenger writes the identity and the client never does.
- **Users, Messages, and Outboxes belong to the Messenger.** The core represents no identity whatsoever.
- **Conversations get a legitimate home.** Rejected as a core concept, they are available inside the Messenger to deployments that want them.
- A further Producer — webhook receiver, mail bridge, chat integration — is a new trusted component, not a new framework concept.
