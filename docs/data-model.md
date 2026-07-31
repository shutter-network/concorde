# Data model

Terminology is in [CONTEXT.md](../CONTEXT.md); rationale is in [docs/adr/](./adr/).

The model splits along the Gateway's internal boundary ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md)): the **Core** owns Signals and Runs, the **Messenger** owns Users, Messages, and Outboxes. The Scheduler keeps its own model, not described here. The Workspace is files, not rows. Signal Handlers are code, not data.

The split is literal: each part owns a PostgreSQL schema and migrates it independently, and no table references another part's ([ADR-0022](./adr/0022-the-store-is-postgresql-through-drizzle.md)).

## Core

### Signal

An arrival record, emitted by a Producer. Immutable except for `state` and `error`.

| Field | Notes |
| --- | --- |
| `id` | opaque |
| `kind` | selects exactly one Signal Handler |
| `payload` | arbitrary JSON, written by the Producer and taken as fact |
| `emitted_at` | |
| `state` | `pending` \| `processing` \| `done` \| `failed` |
| `error` | nullable |

There is **no `user_id` column**. The core authenticates nobody, so attribution is not a fact it holds. The Messenger's payload contract carries the submitting User's id, which is trustworthy because the Messenger writes it and the client never does ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md), superseding [ADR-0019](./adr/0019-signals-are-attributed-arrival-records.md)).

### Run

One Prompt executed in one Session.

| Field | Notes |
| --- | --- |
| `id` | opaque |
| `signal_id` | the Signal whose handler produced this Prompt |
| `session` | a plain **name**, not a foreign key — Sessions live in the Agent Runtime (ADR-0016) |
| `prompt` | the text delivered to the agent |
| `state` | `pending` \| `running` \| `done` \| `failed` |
| `error` | nullable; the Runtime Adapter's failure message |
| `started_at`, `ended_at` | |

There is no `timed_out` state, because there are no timeouts ([ADR-0017](./adr/0017-failed-runs-are-not-retried.md)).

## Messenger

### User

| Field | Notes |
| --- | --- |
| `id` | opaque, Messenger-issued. Never an email or any other scheme (ADR-0014) |
| `attributes` | arbitrary JSON, deployment-defined. Where grouping lives, since there is no Party (ADR-0008) |
| `created_at` | |
| `deactivated_at` | nullable. Removal is deactivation, never erasure (ADR-0014) |
| `outbox_cursor` | this User's read position in their own Outbox |

Credentials are **not** here. The Authenticator owns them — the default bearer-token implementation keeps its own token hashes, a delegating one keeps nothing.

### Message

One entity, both directions ([ADR-0007](./adr/0007-messages-carry-arbitrary-json-payloads.md)).

| Field | Notes |
| --- | --- |
| `id` | opaque |
| `user_id` | exactly one User — the recipient when outbound, the sender when inbound. No groups, no broadcast (ADR-0008) |
| `direction` | `outbound` (agent → User) \| `inbound` (User → agent) |
| `seq` | monotonic **per User**, 1, 2, 3… within that User's Outbox. Serves as the cursor (ADR-0015). **Outbound only**; null when inbound, so a User polling never receives their own Messages back |
| `payload` | arbitrary JSON. All semantic references — conversations, subjects, threads — live here (ADR-0007) |
| `created_at` | |

The **Outbox** is a view over this table: `direction = 'outbound' AND user_id = ? AND seq > cursor`. The agent's history query ignores `direction` and reads both sides interleaved, which is the reason the log exists — a Session is a lossy cache of it.

There is **no `run_id`**. Populating one would require the Messenger to ask the Core which Run is in flight, since the agent never names a Run — a second dependency in the one direction we keep thin. Traceability stays available on the Core's side instead: the worker is globally serial, so at most one Run exists at any moment and the Core can attribute an agent's call to it without the Messenger learning that Runs exist.

A **Conversation** entity may be added here if a deployment needs one. It is a Messenger concept and must not appear in the Core.

### The Messenger's Signal contract

The `kind` and payload shape of the Signals the Messenger emits are **the Messenger's contract, not the framework's** ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md)). The Core treats the payload as opaque; a Signal Handler is written against this shape.

| | |
| --- | --- |
| `kind` | `message.received` |
| `payload` | `{ userId, messageId, body }` |

`userId` and `messageId` are written by the Messenger and never by the client, which is what makes attribution trustworthy. `body` is whatever the client sent, verbatim — arbitrary JSON, exactly as for an outbound Message. `messageId` lets a handler reach the stored inbound Message and its neighbours without re-deriving anything from the payload.

## Invariants

1. **A Message envelope exposes no cross-User provenance.** No originating Signal or Run identifier reaches a client: one Signal may produce Messages to several Users, so exposing it would reveal that another User acted, and a Run identifier discloses how much other activity intervened (ADR-0007).
2. **No identifier or counter visible to a User is influenced by another User's activity.** Hence `Message.seq` is per-User rather than a global sequence.
3. **Every Message belongs to exactly one Run, and every Run to exactly one Signal.** True but unrecorded in the Messenger — see Message above.
4. **A Signal with no Prompts is still a Signal.** Handler-level refusal leaves an arrival record, which is what makes authorization auditable.
5. **`state` transitions are one-way.** Nothing returns to `pending`; failed Signals are never re-run (ADR-0017).
6. **Users never read Signals.** The core's Signal log is not a user-facing surface at all (ADR-0020).

## What is deliberately absent

- **Party.** No table, no identifier, no API field (ADR-0008).
- **Session.** Not modelled; the core stores only the name it routes to (ADR-0016).
- **Agent configuration.** Opaque to the framework (ADR-0016).
- **Per-Signal permissions.** Authorization lives in Signal Handlers (ADR-0009).
- **Delivery state on Messages.** Cursors replace acks and redelivery bookkeeping (ADR-0015).
- **Identity in the core.** It belongs to the Messenger alone (ADR-0020).
