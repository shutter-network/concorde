# Data model

Terminology is in [CONTEXT.md](../CONTEXT.md); rationale is in [docs/adr/](./adr/).

The model splits along the Gateway's internal boundaries ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md)): the **Signal Worker** owns Signals and Runs, the **User Directory** owns Users and their Tokens, the **Messenger** owns Messages and Outboxes. The Scheduler keeps its own model, not described here. The Workspace is files, not rows. Signal Handlers are code, not data.

The split is literal: each part owns a PostgreSQL schema and migrates it independently, and no table references another part's ([ADR-0022](./adr/0022-the-store-is-postgresql-through-drizzle.md)). The Signal Worker's is **`saf_signals`** and the User Directory's is **`saf_users`** — each named for its subject rather than for the part, so that renaming a part is not a schema migration. Each carries its own migration tracking table, which is what stops one part's migrations being silently skipped, and a part registers its migration descriptor with the Db when it is constructed ([ADR-0032](./adr/0032-components-wire-themselves-at-construction.md)).

## Signal Worker (`saf_signals`)

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

There is **no `user_id` column**. The Signal Worker authenticates nobody, so attribution is not a fact it holds. The Messenger's payload contract carries the submitting User's id, which is trustworthy because the Messenger writes it and the client never does ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md), superseding [ADR-0019](./adr/0019-signals-are-attributed-arrival-records.md)).

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

## User Directory (`saf_users`)

### User

| Field | Notes |
| --- | --- |
| `id` | opaque, Gateway-issued. Never an email or any other scheme (ADR-0014) |
| `attributes` | arbitrary JSON, deployment-defined. Where grouping lives, since there is no Party (ADR-0008) — and therefore where authorization lives |
| `password_hash` | **nullable.** scrypt, with its cost parameters stored alongside the digest. Null means this User cannot log in with a password but may still be handed a Token by trusted code, which is the OIDC path (ADR-0030) |
| `created_at` | |

There is **no `deactivated_at`** and no delete: nothing removes a User ([ADR-0029](./adr/0029-users-are-a-part-of-their-own.md)). Revoking their Tokens is the whole of removal.

There is **no `outbox_cursor`** here either. It is Outbox state rather than identity, and Outboxes are the Messenger's, so it lives in a Messenger-owned table.

### Token

| Field | Notes |
| --- | --- |
| `id` | opaque |
| `user_id` | references `User` — **within this part's schema**, which is why the foreign key is allowed (ADR-0022) |
| `token_hash` | unique. Plain single-pass SHA-256 of 32 random bytes; no salt and no KDF, because the input already carries full entropy. Verification is a lookup *by* this column, so the index does the comparison (ADR-0030) |
| `created_at` | |
| `expires_at` | **not nullable.** A Token that never expires is unrepresentable, which removes the "does null mean never?" branch from every read |

Nothing reaps expired rows, so this table grows with every login. That is an operational note in the quickstart rather than a background job.

## Messenger

### Message

One entity, both directions ([ADR-0007](./adr/0007-messages-carry-arbitrary-json-payloads.md)).

| Field | Notes |
| --- | --- |
| `id` | opaque |
| `user_id` | exactly one User — the recipient when outbound, the sender when inbound. No groups, no broadcast (ADR-0008). **Not a foreign key**: Users are the User Directory's, and no part references another's tables (ADR-0022). Nothing therefore enforces that this names a real User, which is safe only because nothing removes one (ADR-0029) |
| `direction` | `outbound` (agent → User) \| `inbound` (User → agent) |
| `seq` | monotonic **per User**, 1, 2, 3… within that User's Outbox. Serves as the cursor (ADR-0015). **Outbound only**; null when inbound, so a User polling never receives their own Messages back |
| `payload` | arbitrary JSON. All semantic references — conversations, subjects, threads — live here (ADR-0007) |
| `created_at` | |

### Outbox cursor

| Field | Notes |
| --- | --- |
| `user_id` | primary key. One row per User who has read anything |
| `seq` | that User's read position in their own Outbox |

Here rather than on the User row, because a read position is Outbox state and the Outbox is the Messenger's. A consequence worth knowing: were removal of a User ever added, it would not delete this row, since it is not the User Directory's to delete.

The **Outbox** is a view over the Message table: `direction = 'outbound' AND user_id = ? AND seq > cursor`. The agent's history query ignores `direction` and reads both sides interleaved, which is the reason the log exists — a Session is a lossy cache of it.

There is **no `run_id`**. Populating one would require the Messenger to ask the Signal Worker which Run is in flight, since the agent never names a Run — a second dependency in the one direction we keep thin. Traceability stays available on the Signal Worker's side instead: the worker is globally serial, so at most one Run exists at any moment and the Signal Worker can attribute an agent's call to it without the Messenger learning that Runs exist.

A **Conversation** entity may be added here if a deployment needs one. It is a Messenger concept and must not appear in the Signal Worker.

### The Messenger's Signal contract

The `kind` and payload shape of the Signals the Messenger emits are **the Messenger's contract, not the framework's** ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md)). The Signal Worker treats the payload as opaque; a Signal Handler is written against this shape.

| | |
| --- | --- |
| `kind` | `message.received` |
| `payload` | `{ userId, messageId, body }` |

`userId` is the id of the User the **User Directory** authenticated, read off the request rather than from the body. `userId` and `messageId` are written by the Messenger and never by the client, which is what makes attribution trustworthy. `body` is whatever the client sent, verbatim — arbitrary JSON, exactly as for an outbound Message. `messageId` lets a handler reach the stored inbound Message and its neighbours without re-deriving anything from the payload.

## Invariants

1. **A Message envelope exposes no cross-User provenance.** No originating Signal or Run identifier reaches a client: one Signal may produce Messages to several Users, so exposing it would reveal that another User acted, and a Run identifier discloses how much other activity intervened (ADR-0007).
2. **No identifier or counter visible to a User is influenced by another User's activity.** Hence `Message.seq` is per-User rather than a global sequence.
3. **Every Message belongs to exactly one Run, and every Run to exactly one Signal.** True but unrecorded in the Messenger — see Message above.
4. **A Signal with no Prompts is still a Signal.** Handler-level refusal leaves an arrival record, which is what makes authorization auditable.
5. **`state` transitions are one-way.** Nothing returns to `pending`; failed Signals are never re-run (ADR-0017).
6. **Users never read Signals.** The Signal Worker's Signal log is not a user-facing surface at all (ADR-0020).
7. **A stored credential is never readable, only verifiable.** A Token's plaintext exists once, in the response that issued it, and a password's never. Nothing in the framework can answer "what is this User's Token".
8. **A User may read their own Attributes.** They govern that User's authorization, they are not secret, and a Signal Handler's behaviour reveals them anyway.

## What is deliberately absent

- **Party.** No table, no identifier, no API field (ADR-0008).
- **Session.** Not modelled; the Signal Worker stores only the name it routes to (ADR-0016).
- **Agent configuration.** Opaque to the framework (ADR-0016).
- **Per-Signal permissions.** Authorization lives in Signal Handlers (ADR-0009).
- **Delivery state on Messages.** Cursors replace acks and redelivery bookkeeping (ADR-0015).
- **Identity in the Signal Worker.** It belongs to the User Directory alone (ADR-0020, ADR-0029).
- **Any way to remove a User.** No delete, no deactivation flag (ADR-0029).
- **Credentials other than a password.** No table of credential kinds, no `kind` column with one value in it. A second first-class kind would be an ADR and a migration; a deployment that wants one today writes its own login route and issues a Token (ADR-0030).
- **Account-recovery state.** No reset tokens, no verification records, no security answers (ADR-0014, ADR-0030).
- **Failed-attempt counters or lockout state.** Deliberately absent; throttling is the deployment edge's (ADR-0030).
