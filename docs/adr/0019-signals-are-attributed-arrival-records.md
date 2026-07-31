---
status: superseded by ADR-0020
---

# Signals are attributed arrival records

> **Superseded by [ADR-0020](./0020-producers-are-trusted-components-of-the-gateway.md).** The `user_id` column is gone. The argument below was sound but rested on a premise that no longer holds: that the framework's own API authenticates the submitter. Once the Messenger owns authentication, the core holds no such fact, and identity belongs in the payload after all. `kind` dispatch and immutability survive unchanged.

A Signal records that something happened. Its shape:

- **`kind`** selects exactly one Signal Handler. We rejected allowing several handlers per kind, because fan-out already has a home — one handler produces many Prompts ([ADR-0009](./0009-signal-handlers-are-arbitrary-code.md)) — and a second fan-out mechanism would be redundant. `kind` is also the natural unit for enabling and disabling parts of a deployment, and it is what a client posts to.
- **`user_id`** is a nullable column, not a payload field. Scheduler and webhook Signals have no submitter; user submissions have one, stamped by the user-facing API rather than supplied by the client.
- **Everything but `state` and `error` is immutable**, written once by the producer.

We considered keeping identity in the payload instead. Rejected on three counts. The Gateway could no longer answer "which Signals did this User submit?", since payload shape is deployment-defined, which makes the read-own-Signals endpoint of [ADR-0015](./0015-outboxes-are-cursor-read-logs.md) unimplementable. [ADR-0013](./0013-the-core-framework-stays-generic.md) lists "every Signal is attributed to an authenticated User" as core shape, so payload-only attribution would demote a stated guarantee to a per-deployment convention. And if identity sat in a client-supplied payload, a client could write someone else's id, forcing the API to stamp into the payload anyway — a column in disguise, without an index.

The distinction that settles it: attribution is not a policy the framework imposes, it is a fact the framework already holds, because its own API authenticated the submitter moments earlier.

## Consequences

- Handlers must cope with `user_id` being absent, and cannot assume a Signal came from anyone.
- There is no synthetic "system user" for producer-originated Signals. One would appear in the roster the agent reads and look like a party.
- A rejected Signal still exists. A handler that produces no Prompts leaves an arrival record behind, which is what makes handler-level authorization auditable.
