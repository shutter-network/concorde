# Data model

Terminology is in [CONTEXT.md](../CONTEXT.md); rationale is in [docs/adr/](./adr/).

The model splits along the Gateway's internal boundaries ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md)): the **Signal Worker** owns Signals and Runs, the **User Manager** owns Users and their Tokens, the **HTTP Messenger** owns Messages. The Scheduler keeps its own model, not described here. The Workspace is files, not rows. Signal Handlers are code, not data.

The split is literal: each part owns a PostgreSQL schema and migrates it independently, and no table references another part's ([ADR-0022](./adr/0022-the-store-is-postgresql-through-drizzle.md)), with **exactly one exception**: the HTTP Messenger's `user_id`, which is a foreign key onto the User Manager's `users.id` and is the only enforcement that a Message names a real User ([ADR-0036](./adr/0036-the-http-messengers-user-id-is-a-foreign-key.md)). A second exception is an ADR of its own.

The Signal Worker's schema is **`saf_signals`**, the User Manager's is **`saf_users`** and the HTTP Messenger's is **`saf_http_messages`**. A schema is named for its subject rather than for the part, so that renaming a part is not a schema migration; the HTTP Messenger's carries the part because "HTTP" is the durable half of that name, and what the rule protects against is a rename becoming a migration ([ADR-0034](./adr/0034-the-http-messenger-is-an-opinionated-messenger.md)). Each schema carries its own migration tracking table, which is what stops one part's migrations being silently skipped, and a part registers its migration descriptor with the Db when it is constructed ([ADR-0032](./adr/0032-components-wire-themselves-at-construction.md)). Registration order is construction order, and the foreign key makes it load-bearing: the User Manager must be constructed before the HTTP Messenger or the latter's first migration fails with `schema "saf_users" does not exist`, since each descriptor's schema is created immediately before its own folder is applied and a User Manager not reached yet has no schema either.

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

There is **no `user_id` column**. The Signal Worker authenticates nobody, so attribution is not a fact it holds. The HTTP Messenger's payload contract carries the submitting User's id, which is trustworthy because that part writes it and the client never does ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md), superseding [ADR-0019](./adr/0019-signals-are-attributed-arrival-records.md)).

### Run

One Prompt executed in one Session.

| Field | Notes |
| --- | --- |
| `id` | opaque |
| `signal_id` | the Signal whose handler produced this Prompt |
| `session` | a plain **name**, not a foreign key — Sessions live in the Agent Implementation (ADR-0016). A Handler asking for a fresh Session writes `null`, and the Signal Worker answers it with `run_<id>` before the Run starts, so every Run this version records names the Session it actually used ([ADR-0033](./adr/0033-an-agent-is-a-container-and-one-function.md)). The column stays nullable, and the Agent server still reports `string \| null`, because Runs recorded before that read back as they were written |
| `prompt` | the text delivered to the agent |
| `state` | `pending` \| `running` \| `done` \| `failed` |
| `error` | nullable; the Runtime's failure message |
| `started_at`, `ended_at` | |

There is no `timed_out` state, because there are no timeouts ([ADR-0017](./adr/0017-failed-runs-are-not-retried.md)).

## User Manager (`saf_users`)

### User

| Field | Notes |
| --- | --- |
| `id` | opaque, Gateway-issued. Never an email or any other scheme (ADR-0014) |
| `attributes` | arbitrary JSON, deployment-defined. Where grouping lives, since there is no Party (ADR-0008) — and therefore where authorization lives |
| `password_hash` | **nullable.** scrypt, with its cost parameters stored alongside the digest. Null means this User cannot log in with a password but may still be handed a Token by trusted code, which is the OIDC path (ADR-0030) |
| `created_at` | |

There is **no `deactivated_at`** and no delete: nothing removes a User ([ADR-0029](./adr/0029-users-are-a-part-of-their-own.md)). Revoking their Tokens is the whole of removal.

There is **no read position** here either, and none anywhere else: a client's cursor is the largest `seq` it holds, so there is nothing to store ([ADR-0035](./adr/0035-a-users-messages-are-one-log-read-by-cursor.md)). Earlier versions of this document specified an `outbox_cursor`, first here and then in a table of the messaging part's own.

### Token

| Field | Notes |
| --- | --- |
| `id` | opaque |
| `user_id` | references `User` — **within this part's schema**, which is why the foreign key is allowed (ADR-0022) |
| `token_hash` | unique. Plain single-pass SHA-256 of 32 random bytes; no salt and no KDF, because the input already carries full entropy. Verification is a lookup *by* this column, so the index does the comparison (ADR-0030) |
| `created_at` | |
| `expires_at` | **not nullable.** A Token that never expires is unrepresentable, which removes the "does null mean never?" branch from every read |

Nothing reaps expired rows, so this table grows with every login. That is an operational note in the quickstart rather than a background job.

## HTTP Messenger (`saf_http_messages`)

### Message

One entity, both directions, and **one table**: `messages` is the whole schema ([ADR-0034](./adr/0034-the-http-messenger-is-an-opinionated-messenger.md)).

| Field | Notes |
| --- | --- |
| `id` | opaque; a uuid the Db defaults |
| `user_id` | exactly one User — the recipient when outbound, the sender when inbound. No groups, no broadcast (ADR-0008). **A foreign key** onto `saf_users.users.id`, which is the one exception to the cross-part rule above and the only enforcement that this names a real User: the agent's 404 is PostgreSQL's `23503` caught, with no lookup in front of it (ADR-0036). It never fires a cascade, because nothing removes a User (ADR-0029) |
| `direction` | `outbound` (agent → User) \| `inbound` (User → agent). A `check` constraint over the same list the TypeScript union comes from, as `signals.state` is. Decided by which server the request arrived on, so there is no field for a caller to set and nothing to get wrong |
| `seq` | monotonic **per User**, 1, 2, 3…, across **both** directions, which is what lets one cursored read serve a client's poll and its rendering alike (ADR-0035). Never null. Assigned as `coalesce(max(seq), 0) + 1` for that User inside a savepoint; `unique (user_id, seq)` makes a lost race visible and a bounded retry settles it, because inbound writes arrive concurrently and are no longer the serial worker's alone |
| `text` | the whole content, a plain string, non-empty. No `maxLength`: the server's own `bodyLimit` is the bound and it is the Operator's to raise (ADR-0034) |
| `created_at` | `clock_timestamp()` and not `now()`, for the reason `signals.emitted_at` uses it: two rows written in one transaction should not share a timestamp exactly |

`unique (user_id, seq)` is the only index. It enforces the numbering and it is the index every read uses, since every query is `where user_id = ? [and seq >/< ?] order by seq`.

A Message is **immutable** once written, like a Signal: no column here is ever updated. Nothing removes one either (no delete route, no TTL, no sweeper and nothing to configure), so the table grows forever, exactly as `tokens` does (ADR-0035).

The agent's read ignores `direction` and takes both sides interleaved, which is the reason the log exists: a Session is a lossy cache of it. A User's own read is the same query with the User taken from their Token instead of a query parameter.

There is **no `run_id`**. Populating one would require the HTTP Messenger to ask the Signal Worker which Run is in flight, since the agent never names a Run — a second dependency in the one direction we keep thin. Traceability stays available on the Signal Worker's side instead: the worker is globally serial, so at most one Run exists at any moment and the Signal Worker can attribute an agent's call to it without this part learning that Runs exist.

There is no read position, no unread count and no receipt. A client's cursor is the largest `seq` it holds (ADR-0035).

A **Conversation** entity may be added here if a deployment needs one. It is this part's concept and must not appear in the Signal Worker.

### The HTTP Messenger's Signal contract

The `kind` and payload shape of the Signals this part emits are **its contract, not the framework's** ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md)). The Signal Worker treats the payload as opaque; a Signal Handler is written against this shape.

| | |
| --- | --- |
| `kind` | `message.received`, an exported constant rather than a construction option (ADR-0034) |
| `payload` | the stored inbound Message, flat: `{ id, userId, direction, seq, text, createdAt }` |

The payload **is** the record every other surface returns, not a projection of it: one shape for the POST response, both reads, the trusted-code methods and this. `direction` is always `inbound` here and `seq` is redundant for most Handlers; both are carried so that the part has one shape rather than two kept parallel by hand. `userId` is the id of the User the **User Manager** authenticated, read off the request and never from the body, which is what makes attribution trustworthy. `createdAt` is an ISO 8601 string, because JSON has no date. A Handler wanting more than the one Message reads that User's log through the part's own method rather than re-deriving anything from the payload.

## Invariants

1. **A Message envelope exposes no cross-User provenance.** No originating Signal or Run identifier reaches a client: one Signal may produce Messages to several Users, so exposing it would reveal that another User acted, and a Run identifier discloses how much other activity intervened (ADR-0007).
2. **No identifier or counter visible to a User is influenced by another User's activity.** Hence `Message.seq` is per-User rather than a global sequence. Numbering both directions does not touch this: it changes what is numbered, not whose activity moves the number (ADR-0035).
3. **Every outbound Message belongs to exactly one Run, and every Run to exactly one Signal.** True but unrecorded in the HTTP Messenger — see Message above. An inbound Message belongs to no Run: it precedes one, and the link is the Signal it emitted, which is recorded on the Signal Worker's side.
4. **A Signal with no Prompts is still a Signal.** Handler-level refusal leaves an arrival record, which is what makes authorization auditable.
5. **`state` transitions are one-way.** Nothing returns to `pending`; failed Signals are never re-run (ADR-0017).
6. **Users never read Signals.** The Signal Worker's Signal log is not a user-facing surface at all (ADR-0020).
7. **A stored credential is never readable, only verifiable.** A Token's plaintext exists once, in the response that issued it, and a password's never. Nothing in the framework can answer "what is this User's Token".
8. **A User may read their own Attributes.** They govern that User's authorization, they are not secret, and a Signal Handler's behaviour reveals them anyway.
9. **Only a User can cause an inbound Message.** There is no trusted-code path that writes one, so nothing in the Gateway and nothing the agent can reach puts words in a User's mouth. Trusted code writing history in uses the Operator's own SQL.

## What is deliberately absent

- **Party.** No table, no identifier, no API field (ADR-0008).
- **Session.** Not modelled; the Signal Worker stores only the name it routes to (ADR-0016).
- **Agent configuration.** Opaque to the framework (ADR-0016).
- **Per-Signal permissions.** Authorization lives in Signal Handlers (ADR-0009).
- **Delivery state on Messages.** Cursors replace acks and redelivery bookkeeping (ADR-0015).
- **Read state of any kind.** No stored cursor, no unread count, no receipts, no cross-device sync. The read position a client needs is the largest `seq` it holds (ADR-0035).
- **Any way to remove or edit a Message.** No delete, no update, no retention setting (ADR-0035).
- **Identity in the Signal Worker.** It belongs to the User Manager alone (ADR-0020, ADR-0029).
- **Any way to remove a User.** No delete, no deactivation flag (ADR-0029).
- **Credentials other than a password.** No table of credential kinds, no `kind` column with one value in it. A second first-class kind would be an ADR and a migration; a deployment that wants one today writes its own login route and issues a Token (ADR-0030).
- **Account-recovery state.** No reset tokens, no verification records, no security answers (ADR-0014, ADR-0030).
- **Failed-attempt counters or lockout state.** Deliberately absent; throttling is the deployment edge's (ADR-0030).
