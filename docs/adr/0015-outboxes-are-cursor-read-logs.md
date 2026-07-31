# Outboxes are cursor-read logs

An Outbox is an append-only log. Messages are retained after being read, each User holds a read position, and fetching means "everything after cursor N". Fetching is therefore idempotent and safe to retry, and a client can re-read history without the Gateway tracking delivery attempts.

Each Message carries a **per-user monotonic sequence number** — a User's Messages are numbered 1, 2, 3… within their own Outbox. This satisfies [ADR-0007](./0007-messages-carry-arbitrary-json-payloads.md)'s rule that no identifier may be influenced by other users' activity, which rules out a global sequence, and is exactly what a cursor needs. One mechanism serves both.

We considered a destructive queue, where fetching removes: rejected because a client crashing mid-fetch loses Messages permanently and a UI has no history to render. We also considered explicit acks with redelivery of unacked Messages: rejected as bookkeeping for a problem cursors already solve.

## Consequences

- **Retention is kept by default and configured per deployment**, per [ADR-0013](./0013-the-core-framework-stays-generic.md). Deleting a Message from an Outbox does not remove it from the agent's Session history — the same asymmetry as User deletion in [ADR-0014](./0014-users-are-opaque-ids-and-authentication-is-pluggable.md).
- Outboxes belong to the **Messenger**, not the Core ([ADR-0020](./0020-producers-are-trusted-components-of-the-gateway.md)). Users never see Signals; a client showing what was sent alongside what was received reads both from the Messenger's Message log, which holds inbound Messages as well as outbound ones ([ADR-0007](./0007-messages-carry-arbitrary-json-payloads.md)). An Outbox is a view over that log filtered to the outbound direction, not a separate store.
- Delivery is by polling. Long-polling or SSE can be added later as a transport optimisation without touching the data model.
