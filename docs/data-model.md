# Data model

Terminology is in [CONTEXT.md](../CONTEXT.md); rationale is in [docs/adr/](./adr/).

The model splits along the Gateway's internal boundaries ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md)): the **Signal Worker** owns Signals and Runs, the **Users** component owns Users and nothing a person presents, **Password Auth** and **Nostr Auth** own one credential each ([ADR-0052](./adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)), the **Messenger** owns Messages, the **Nostr Channel** owns what only it can know about that medium, and **Decisions** owns Decisions. The Scheduler keeps its own model, not described here. **Two components appear nowhere below**, both because they store nothing at all: Signatures, which holds a key and answers three routes ([ADR-0042](./adr/0042-a-signature-is-a-compact-jws.md)), and the **HTTP Channel**, which lost the log to the Messenger and has no queue either, HTTP delivery being the User asking ([ADR-0048](./adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). An Auth is not that kind of part: what an Auth owns is a secret, and a secret is a row, so both of them have tables. The Workspace is files, not rows. Signal Handlers are code, not data.

The split is literal: each part owns a PostgreSQL schema, and no table references another part's ([ADR-0022](./adr/0022-the-store-is-postgresql-through-drizzle.md)), with **exactly six exceptions, all onto the same column**. `saf_messenger.messages.user_id` is a foreign key onto the Users component's `users.id` and is the only enforcement that a Message names a real User ([ADR-0036](./adr/0036-the-http-messengers-user-id-is-a-foreign-key.md)); `saf_nostr_channel.pubkeys.user_id` and `saf_nostr_channel.outbox.user_id` are the same reference for the same reason on the Nostr Channel's side ([ADR-0049](./adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)); and `saf_password_auth.passwords.user_id`, `saf_password_auth.tokens.user_id` and `saf_nostr_auth.grants.user_id` are the same reference again, an Auth naming the identity its credential belongs to (ADR-0052, [ADR-0053](./adr/0053-nostr-auth-verifies-nip-98-per-request.md)). One direction, one target table, and the Users component references nobody back. Half of them are an Auth's, which is what "the seam is who owns the secret" costs in the schema: identity is one part, and the six columns pointing at it sit in six tables across four other parts.

The Signal Worker's schema is **`saf_signals`**, the Users component's is **`saf_users`**, Password Auth's is **`saf_password_auth`**, Nostr Auth's is **`saf_nostr_auth`**, the Messenger's is **`saf_messenger`**, the Nostr Channel's is **`saf_nostr_channel`**, the Scheduler's is **`saf_scheduler`** and Decisions' is **`saf_decisions`**. A schema is named for its subject rather than for the part, so that renaming a part is not a schema migration, and twice now the subject has turned out to be narrower than the first name for it. The Messenger's was **`saf_http_messages`** until the medium stopped being anything it owned (ADR-0048), and the Nostr Channel's was **`saf_nostr`**, named for the protocol, until Nostr Auth became the second component to speak it ([ADR-0053](./adr/0053-nostr-auth-verifies-nip-98-per-request.md)). A deployment upgrading across either split renames the schema. **None of these tables are created by the framework**, which ships schema definitions and applies nothing ([ADR-0046](./adr/0046-the-operator-owns-migrations.md)). Each component exports its tables on a `/schema` subpath of its own, `shared-agent-framework/<component>/schema`, one below the subpath carrying its constructor ([ADR-0055](./adr/0055-a-components-tables-are-a-subpath-of-their-own.md)); a deployment `export *`s the components it runs into one barrel, points its own `drizzle.config.ts` at it, and generates or pushes with its own `drizzle-kit`. The barrel is what the two names every schema module declares carry a component prefix for: `usersSchema` and `usersTables` rather than `schema` and `tables`, because `export *` drops a name that resolves to more than one binding, and eight exports called `schema` leave one PostgreSQL schema with a `CREATE` behind it and seven without. So there is no migration tracking table here, one per part or otherwise, and no registration order: `drizzle-kit` sees a single schema graph and orders the statements within it. What the barrel can still get wrong is its **contents**. The foreign keys above mean a barrel carrying the Messenger, the Nostr Channel, Password Auth or Nostr Auth without Users generates a reference to a table it never creates and dies on `schema "saf_users" does not exist`; and a part constructed in `extend` but omitted from the barrel simply has no tables, felt as a PostgreSQL `relation does not exist` on the first query that needs them, because `db.start()` verifies nothing (ADR-0046, costs 1 and 2). The HTTP Channel is the case that fails neither way: it has nothing to barrel, so leaving it out is correct. Each example under `examples/` shows a worked barrel: a `schema.ts`, a `drizzle.config.ts` that points at it, and a one-shot `migrate` service the Gateway waits on.

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

There is **no `user_id` column**. The Signal Worker authenticates nobody, so attribution is not a fact it holds. The Messenger's payload contract carries the submitting User's id, which is trustworthy because that part writes it and the client never does ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md), superseding [ADR-0019](./adr/0019-signals-are-attributed-arrival-records.md)).

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

## Users (`saf_users`)

**One table, and nothing a person presents.** The password digest and the Token table left for Password Auth (ADR-0052). What is here is identity: who exists, and what the deployment says about them.

### User

| Field | Notes |
| --- | --- |
| `id` | opaque, Gateway-issued. Never an email or any other scheme (ADR-0014) |
| `attributes` | arbitrary JSON, deployment-defined. Where grouping lives, since there is no Party (ADR-0008) — and therefore where authorization lives. No route writes this column, on either server: the agent cannot create a User at all, and `setAttributes` is trusted code's |
| `created_at` | `clock_timestamp()` and not `now()`, so two Users created in one transaction do not share a timestamp exactly and the list route's ordering is not decided by the uuid tiebreak |

There is **no `deactivated_at`** and no delete: nothing removes a User ([ADR-0029](./adr/0029-users-are-a-part-of-their-own.md)). Revoking their credentials is the whole of removal, and it is an Auth's act now rather than this component's: Password Auth's `revoke` drops every Token of one User, and a deployment running Nostr Auth deletes the grant row itself, that component offering no method for it. Because nothing removes a row here, a reference to a User from another part's table cannot come to dangle, which is what lets six of them exist.

There is **no `password_hash`**, and its absence is a decision rather than a move. The column was nullable so that a User authenticated some other way need never have one; such a User now simply has no row in Password Auth, so "cannot log in with a password" has one spelling instead of two (ADR-0052).

There is **no read position** here either, and none anywhere else: a client's cursor is the largest `seq` it holds, so there is nothing to store ([ADR-0035](./adr/0035-a-users-messages-are-one-log-read-by-cursor.md)). Earlier versions of this document specified an `outbox_cursor`, first here and then in a table of the messaging part's own.

## Password Auth (`saf_password_auth`)

Two tables, and both of them were the Users component's until an Auth became a part of its own (ADR-0052). Nothing about how either secret is stored changed in the move, and ADR-0030 is still where the argument for each is. Neither Auth emits a Signal, so neither has a Signal contract: an Auth is not a Producer, and turning a request into a User wakes nobody.

### Password (`passwords`)

One row per User who can log in with a password, and no row for a User who cannot.

| Field | Notes |
| --- | --- |
| `user_id` | the **primary key**, so a User holds one password. A foreign key onto `saf_users.users.id`, and no cascade, because nothing removes a User |
| `password_hash` | **not nullable.** scrypt from `node:crypto`, with its cost parameters beside the digest in a PHC-style string. Stored rather than fixed in code, because with no account-recovery flow fixed parameters could never be raised: every existing hash would stop verifying and the only remedy is the reset this framework does not build. There is deliberately no rehash on login (ADR-0030) |
| `updated_at` | `clock_timestamp()`. The only history a password has, and it records nothing about who wrote it: an Operator replacing a forgotten one and a User rotating their own write the same row |

### Token (`tokens`)

One row per login, and the credential every request of this scheme carries.

| Field | Notes |
| --- | --- |
| `id` | opaque |
| `user_id` | a foreign key onto `saf_users.users.id`, **cross-schema now** where it used to be within one part, which is the second half of what the split cost (ADR-0052). It carries `on delete cascade` for a delete that cannot happen, so that the day a User can be removed the credentials go with them |
| `token_hash` | unique. Plain single-pass SHA-256 of 32 random bytes; no salt and no KDF, because the input already carries full entropy. Verification is a lookup *by* this column, so the index does the comparison (ADR-0030) |
| `created_at` | |
| `expires_at` | **not nullable.** A Token that never expires is unrepresentable, which removes the "does null mean never?" branch from every read. Written from the component's construction-time lifetime, against the database's clock, which is the clock the comparison reads too |

Nothing reaps expired rows, so this table grows with every login. That is an operational note rather than a background job, and ADR-0053 records why the Nostr Auth table two sections down decides the opposite: this one grows at login rate, that one at request rate.

## Nostr Auth (`saf_nostr_auth`)

Two tables, and **no Token among them**: this Auth issues nothing at all. It verifies a NIP-98 event on every request instead, so what it keeps is who may sign and what has already been signed ([ADR-0053](./adr/0053-nostr-auth-verifies-nip-98-per-request.md)). It registers no route on either server, and no example builds it: the one deployment under `examples/` that speaks Nostr serves nothing over HTTP for a NIP-98 credential to authenticate.

### Grant (`grants`)

Which Nostr public key may act as which User over HTTP, and the whole of admission to this scheme.

| Field | Notes |
| --- | --- |
| `pubkey` | the **primary key**, so one User holds as many keys as they have signers and a phone and a laptop do not need two Users. 32 bytes as **64 lowercase hex characters**, which is what the wire format uses. Not an `npub`: NIP-19's display encodings must not appear in an event, none is decoded here, and a stored one would be compared byte for byte against a verified event's author and match nothing |
| `user_id` | an **ordinary column**, indexed, and nothing here is unique per User. A foreign key onto `saf_users.users.id`, with no cascade, because nothing removes a User |
| `granted_at` | `clock_timestamp()`, for the reason `users.created_at` uses it |

**There is no route anywhere that writes this table**, on either server, which is the same guard the Nostr Channel's `pubkeys` carries: recording a key is authorization-shaped, so an injected prompt cannot grant itself a User's identity. Trusted code calls `recordPublicKey` in a transaction of its own, and it proves nothing, in exactly the sense `setPassword` proves nothing. The cost is that nobody enrols themselves: a key nobody recorded authenticates nothing, whatever it signs.

**This is not `saf_nostr_channel.pubkeys` and must not be kept in step with it.** The two hold the same kind of value with opposite cardinalities and for opposite purposes. The Channel picks exactly one key to *send* to, so its primary key is the User; this admits any number of signers to *act as* one User, so its primary key is the key. A reader who fixes the duplication has turned a person reachable over Nostr into a person who may drive the HTTP API. ADR-0048 rejected a shared identity table and predicted a private copy; it turned out not to be a copy, which makes that rejection stronger than the argument made for it. The recorded cost is paid here for the first time: two calls write the two tables and nothing checks that they agree, so a key granted for messaging and not for authentication is a person who can direct-message the agent and gets a 401 on `GET /decisions`, with no single place to look.

### Admitted event (`admitted`)

| Field | Notes |
| --- | --- |
| `event_id` | the NIP-98 event's own id, 64 lowercase hex characters, and the **primary key**. This is the whole replay defence: nothing in NIP-98 stops a captured `Authorization` header being sent again inside its freshness window, and on the HTTP Channel's submission route that means the same Message twice and the agent woken twice. Because the id is a hash of the event's fields and `created_at` counts whole seconds, a client that signs the same call twice inside one second signs one event and is refused the second time |
| `admitted_at` | when this Gateway admitted it, which is **not** the timestamp the event carried. `clock_timestamp()`, and the prune below compares it against the same clock, so an offset between the two machines cancels out of a duration |

Only an admitted event gets a row. Every mechanical check and the grant lookup happen first, so a stranger who can sign cannot grow this table, and that ordering is the thing to refuse reordering.

**This table prunes itself, in the transaction that writes the row**, which is a deliberate departure from the `tokens` table above. It grows at authenticated-request rate where that one grows at login rate, and the useful contents are the last minute, so handing an Operator a table that gains a million rows a day to hold sixty seconds of facts is a different promise. The cutoff is derived rather than chosen: the freshness window is two-sided, so an event may be admitted a whole window before its own `created_at` and stays presentable a window after it, which makes the cutoff `2 * windowMs` and nothing shorter. What this buys is worth stating plainly: **the table's size is a function of traffic in the last window, not of traffic ever.** What it costs is one extra `DELETE` per authenticated request, and concurrent requests racing on the same dead rows, which PostgreSQL absorbs at the price of dead tuples and autovacuum.

**Authentication over Nostr is a write.** A `GET` under this Auth inserts a row and deletes some, where the same request under Password Auth is one indexed select.

## Messenger (`saf_messenger`)

### Message

One entity, both directions, and **one table**: `messages` is the whole schema ([ADR-0034](./adr/0034-the-http-messenger-is-an-opinionated-messenger.md), [ADR-0048](./adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). It is one log per User whichever medium a Message travelled by, and there is **no `channel` column**: one Channel per Messenger makes it constant in every row, and the day a second one is constructable the column, an argument to `send` and the name in the Signal payload arrive together.

| Field | Notes |
| --- | --- |
| `id` | opaque; a uuid the Db defaults |
| `user_id` | exactly one User — the recipient when outbound, the sender when inbound. No groups, no broadcast (ADR-0008). **A foreign key** onto `saf_users.users.id`, which is the one exception to the cross-part rule above and the only enforcement that this names a real User: the agent's 404 is PostgreSQL's `23503` caught, with no lookup in front of it (ADR-0036). It never fires a cascade, because nothing removes a User (ADR-0029) |
| `direction` | `outbound` (agent → User) \| `inbound` (User → agent). A `check` constraint over the same list the TypeScript union comes from, as `signals.state` is. Decided by which of the Messenger's two writes wrote it — a Channel's `receive` or trusted code's `send` — so there is no field for a caller to set and nothing to get wrong |
| `seq` | monotonic **per User**, 1, 2, 3…, across **both** directions, which is what lets one cursored read serve a client's poll and its rendering alike (ADR-0035). Never null. Assigned as `coalesce(max(seq), 0) + 1` for that User inside a savepoint; `unique (user_id, seq)` makes a lost race visible and a bounded retry settles it, because inbound writes arrive concurrently and are no longer the serial worker's alone |
| `text` | the whole content, a plain string, non-empty. No `maxLength`: the server's own `bodyLimit` is the bound and it is the Operator's to raise (ADR-0034) |
| `created_at` | `clock_timestamp()` and not `now()`, for the reason `signals.emitted_at` uses it: two rows written in one transaction should not share a timestamp exactly |

`unique (user_id, seq)` is the only index. It enforces the numbering and it is the index every read uses, since every query is `where user_id = ? [and seq >/< ?] order by seq`.

A Message is **immutable** once written, like a Signal: no column here is ever updated. Nothing removes one either (no delete route, no TTL, no sweeper and nothing to configure), so the table grows forever, exactly as `tokens` does (ADR-0035).

The agent's read ignores `direction` and takes both sides interleaved, which is the reason the log exists: a Session is a lossy cache of it. A User's own read is the same query with the User taken from their Token instead of a query parameter.

There is **no `run_id`**. Populating one would require the Messenger to ask the Signal Worker which Run is in flight, since the agent never names a Run — a second dependency in the one direction we keep thin. Traceability stays available on the Signal Worker's side instead: the worker is globally serial, so at most one Run exists at any moment and the Signal Worker can attribute an agent's call to it without this part learning that Runs exist.

There is no read position, no unread count and no receipt. A client's cursor is the largest `seq` it holds (ADR-0035).

A **Conversation** entity may be added here if a deployment needs one. It is this part's concept and must not appear in the Signal Worker.

### The Messenger's Signal contract

The `kind` and payload shape of the Signals this part emits are **its contract, not the framework's** ([ADR-0020](./adr/0020-producers-are-trusted-components-of-the-gateway.md)). The Signal Worker treats the payload as opaque; a Signal Handler is written against this shape.

| | |
| --- | --- |
| `kind` | `message.received`, an exported constant rather than a construction option (ADR-0034) |
| `payload` | the stored inbound Message, flat: `{ id, userId, direction, seq, text, createdAt }` |

The payload **is** the record every other surface returns, not a projection of it: one shape for the POST response, both reads, the trusted-code methods and this. `direction` is always `inbound` here and `seq` is redundant for most Handlers; both are carried so that the part has one shape rather than two kept parallel by hand. `userId` is the id of the User the Channel resolved: over HTTP the one the **Public server** named, whichever registered Auth answered for the request, read off the request and never from the body (ADR-0052); over Nostr the one whose recorded public key sealed the message. Either way the Channel writes it and no client ever does, which is what makes attribution trustworthy. `createdAt` is an ISO 8601 string, because JSON has no date. A Handler wanting more than the one Message reads that User's log through the part's own method rather than re-deriving anything from the payload. **The payload does not name the Channel**, and did not change when the split happened, so a Handler written against the HTTP Messenger needs no edit ([ADR-0048](./adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)).

## Nostr Channel (`saf_nostr_channel`)

Three tables, and **no Message among them**: the log is the Messenger's whichever medium a Message travelled by. What this part keeps is the three things only it can know ([ADR-0049](./adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)). One Channel per Messenger, so a deployment holding these three tables holds them **instead of** running HTTP and never beside it: `examples/03_nostr` is the worked case.

### Public key (`pubkeys`)

Which Nostr public key belongs to which User, and the whole of admission over this medium.

| Field | Notes |
| --- | --- |
| `user_id` | the **primary key**, so one User holds at most one Nostr key — otherwise there would be no answer to which one the agent writes back to. A foreign key onto `saf_users.users.id`, and the only enforcement that this names a real User: the refusal is PostgreSQL's `23503` caught, with no lookup in front of the write. No cascade, because nothing removes a User |
| `pubkey` | 32 bytes as **64 lowercase hex characters**, which is what the wire format and both Nostr libraries use. Not an `npub`: NIP-19's display encodings are refused rather than decoded, because a stored one would be compared byte for byte against a decrypted message's author and match nothing, silently. **Unique**, so a key already recorded cannot be claimed by a second User — which is what stops one person's messages landing in another's log |
| `recorded_at` | `clock_timestamp()`, for the reason `messages.created_at` uses it |

**There is no route anywhere that writes this table**, on either server, which is the point: recording a key is authorization-shaped, so it joins `setAttributes` in the class an injected prompt cannot reach. Trusted code calls `recordPublicKey` in a transaction of its own, having established out of band that the key is that person's — it proves nothing, in exactly the sense `setPassword` proves nothing. **The cost is that the agent cannot admit a stranger**, and a message from a key nobody recorded is dropped with nothing whatever stored, not even a processed-event row.

This is deliberately *not* shared with authentication, and the Auth that would have shared it now exists: `saf_nostr_auth.grants` is the other mapping, and neither table reads the other. A unique constraint buys uniqueness and not authenticity, so a table both messaging and login read would be a trust root shared between them; full separation was cheaper, and the duplication is the recorded cost (ADR-0048, ADR-0053, **Alias** under Rejected in CONTEXT.md). The two are not one fact stored twice: this one is keyed by the User because the Channel must pick one address to send to, and that one is keyed by the key because a person signs from as many devices as they hold.

### Processed envelope (`received`)

| Field | Notes |
| --- | --- |
| `event_id` | the gift wrap's own id, 64 lowercase hex characters, and the **primary key**. That constraint is the correctness mechanism for inbound: NIP-59 randomises a wrap's timestamp up to two days into the past, so a timestamp watermark is not a valid cursor and the subscription carries no `since` at all. The whole store is re-read on every connect, and this key turns the repetition into nothing. Reconnect overlap, the `created_at` tie when a paged read walks backwards, and a Relay delivering an event twice all collapse into it |
| `received_at` | when this Gateway admitted it, which is **not** the timestamp the wrap carried |

The insert shares the transaction that writes the Message, so a conflict means "already processed" and a rollback un-processes it. Only admitted events get a row, so a stranger cannot grow this table, and it stays the same order of magnitude as the Message log. Nothing prunes it.

### Outbound queue (`outbox`)

Every gift wrap owed to the Relay, or refused by it. **This table is the seam between the two halves of a send**: a publish cannot be rolled back and a transaction can, so the whole wrap is built and stored inside the caller's transaction and the network act happens after the commit.

| Field | Notes |
| --- | --- |
| `event_id` | the wrap's own id, and the **primary key**, so the same wrap cannot be queued twice. It is also what the Relay acknowledges by, which makes a publish and the delete that follows it name one thing |
| `user_id` | who the wrap is addressed to, and the column an Operator filters by. A foreign key onto `saf_users.users.id`, like `pubkeys.user_id`. **Not** the recipient's Nostr public key: that is inside the wrap, where the Relay cannot read it either |
| `message_id` | the Message in the log this wrap carries, so an Operator can read what was not delivered. Deliberately **not** a foreign key onto `saf_messenger.messages.id`: the wrap is opaque, so this is the only route from a stuck row back to the words, and a plain column answers it with one join |
| `wrap` | the finished gift wrap as the JSON that goes on the wire, stored whole. That is what keeps key material out of the publishing half — the wrap was sealed and signed inside the transaction — and what turns the Relay's advertised maximum message size into a synchronous throw rather than a queue row that fails once and stops. Encrypted to the recipient, so it tells the Operator nothing about what it says |
| `reason` | why the Relay refused it, in the Relay's own words, or `null`. NIP-01 prefixes an `OK` reason with a machine-readable word — `blocked:`, `rate-limited:`, `invalid:`, `auth-required:` — so "the Relay was down" and "the Relay refused this" are distinguishable without parsing prose. **`null` is what the drain selects on**, which is what makes "attempted once" hold across a notification, a restart, and a stop and start alike |
| `queued_at` | `clock_timestamp()`, and the publishing order |
| `failed_at` | when the Relay refused it, and `null` for as long as `reason` is |

A row is deleted when the Relay accepts the wrap, so a healthy deployment keeps this table empty. A row carrying a `reason` is **never attempted again**: there is no retry, no backoff and no attempt cap, which is ADR-0017 applied to publishing, and this table is where all three would land. So `select * from saf_nostr_channel.outbox where reason is not null` is the whole answer to "why did she not get it", and it needs no API. The recorded cost is that a Relay restart mid-send loses that Message and the Operator replays the row by hand.

### The Nostr Channel's Signal contract

It has none, and that is the design: an inbound direct message becomes an inbound Message through the Messenger's own `receive`, so the Signal is the Messenger's, with the same `kind` and the same payload as an HTTP submission (ADR-0048). A Channel is not a Producer.

## Decisions (`saf_decisions`)

### Decision

One Signed Statement, numbered and kept. **No `user_id`**: the log is global, and a Decision is addressed to nobody ([ADR-0043](./adr/0043-decisions-are-one-global-log.md)).

| | |
| --- | --- |
| `seq` | the primary key, `GENERATED BY DEFAULT AS IDENTITY`. Global rather than per-User, which is the whole difference from `messages.seq` and the reason there is no `id` beside it: a global sequence is already unique, so a uuid would be neither a better cursor nor a better handle. `BY DEFAULT` and not `ALWAYS` because the value is always supplied by hand — `publish` draws it with `nextval` **before** signing, since the JWS binds it |
| `statement` | the whole content, a plain string, non-empty. No `maxLength`, for the reason `messages.text` has none: `bodyLimit` is the bound and it is the Operator's |
| `jws` | the compact JWS over `{ seq, createdAt, statement }`, base64url, **not null**. `text` and not `bytea`, because it crosses the API in that form regardless and storing the encoded form is what keeps the stored bytes and the served bytes from disagreeing. Named `jws` and not `signature` because it holds a whole JWS, of which the signature is one of three segments |
| `created_at` | generated **in JS**, not by `clock_timestamp()`. The signed timestamp and the stored one must be the same value, and the only way to guarantee that is for one value to reach both. `messages.created_at`'s reason for `clock_timestamp()` is satisfied anyway, each `publish` calling `new Date()` itself |

Four columns and no index beyond the primary key, since every query this part will ever make is `[where seq >/< ?] order by seq`.

A Decision is **immutable** once written — no column is ever updated, and unlike the alternative write path considered in ADR-0043 that claim is literal rather than "not after publish". Nothing removes one: no delete, no TTL, no sweeper, no supersession field. A reversal is a new Decision whose statement says so, and the table grows forever as `messages` and `tokens` do.

There is **no `run_id`**, for the Messenger's reason and two of its own: it would be a second cross-schema foreign key, tying this part's schema to the Signal Worker's as ADR-0036's ties the Messenger's to the Users component's, and it would be null for a Decision published by a Signal Handler and so mean two things at once. Correlating a Decision to its Run is a manual timestamp join, ambiguous if two Runs publish inside one clock tick.

There is **no `key_id`**, so changing the signing key leaves the log holding artifacts under two keys with nothing saying which; a verifier needs the old public key out of band ([ADR-0041](./adr/0041-the-shared-agent-has-a-signing-identity.md)).

**A gap in `seq` is meaningless and expected.** A rolled-back transaction burns a number. Gaplessness would prove nothing anyway: the Operator is trusted and owns the database, so withholding is undetectable under any numbering, and detecting it needs the hash chain ADR-0001 rejected.

`nextval` is what removes the race `messages.seq` needs a bounded retry for — and there is nothing to race in the first place, since every writer is serial: the publish route is on the Agent server only, so the agent can only publish during a Run, and trusted code publishes from inside the same serial worker. There is no public publish route.

**Decisions emits no Signal**, so it has no Signal contract. Publishing writes a row and nothing wakes (ADR-0043).

## Invariants

1. **A Message envelope exposes no cross-User provenance.** No originating Signal or Run identifier reaches a client: one Signal may produce Messages to several Users, so exposing it would reveal that another User acted, and a Run identifier discloses how much other activity intervened (ADR-0007).
2. **No identifier or counter visible to a User is influenced by another User's activity — on a per-User surface.** Hence `Message.seq` is per-User rather than a global sequence. Numbering both directions does not touch this: it changes what is numbered, not whose activity moves the number (ADR-0035). **`Decision.seq` is the deliberate exception**, and the scoping clause is there for it: every User sees the same global sequence and it is moved by every other User's activity, so a reader can infer from a jump and a timestamp that somebody else acted. On a surface whose content is published to everyone on purpose that is the function rather than a leak (ADR-0043). Invariant 1's bar on Signal and Run provenance loses its stated reason on that surface for the same reason, and is honoured there anyway.
3. **Every outbound Message belongs to exactly one Run, and every Run to exactly one Signal.** True but unrecorded in the Messenger — see Message above. An inbound Message belongs to no Run: it precedes one, and the link is the Signal it emitted, which is recorded on the Signal Worker's side.
4. **A Signal with no Prompts is still a Signal.** Handler-level refusal leaves an arrival record, which is what makes authorization auditable.
5. **`state` transitions are one-way.** Nothing returns to `pending`; failed Signals are never re-run (ADR-0017).
6. **Users never read Signals.** The Signal Worker's Signal log is not a user-facing surface at all (ADR-0020).
7. **A stored credential is never readable, only verifiable.** A Token's plaintext exists once, in the response that issued it, and a password's never. Nothing in the framework can answer "what is this User's Token". Under Nostr Auth the question does not arise: the secret is the User's signing key and it never reaches the Gateway, so what is stored is a public key and a spent event id (ADR-0053).
8. **A User may read their own Attributes.** They govern that User's authorization, they are not secret, and a Signal Handler's behaviour reveals them anyway.
9. **Only a User can cause an inbound Message.** There is no public `receive` on the Messenger: a Channel gets one back from `register`, so only a registered Channel can write an inbound Message and nothing else in the Gateway, and nothing the agent can reach, puts words in a User's mouth (ADR-0048). Over Nostr the same claim holds against a forged envelope, because the seal's author and the rumor's author must agree before anything is written (ADR-0049). Trusted code writing history in uses the Operator's own SQL.
10. **A signature proves custody, not conduct.** It says the Operator committed to this Statement on the Shared Agent's behalf. It says nothing about how the Statement came to be, and an injected agent can obtain one (ADR-0041).
11. **The Decision log is the one shared surface, and the only one.** Every authenticated User reads the same rows in the same order; nothing scopes it, and no other read in the model works that way.
12. **A Decision exists as an artifact, not as a row.** The JWS is the Decision, so a valid one does not imply a row and a verifier needs none (ADR-0042, ADR-0043).

## What is deliberately absent

- **Party.** No table, no identifier, no API field (ADR-0008).
- **Session.** Not modelled; the Signal Worker stores only the name it routes to (ADR-0016).
- **Agent configuration.** Opaque to the framework (ADR-0016).
- **Per-Signal permissions.** Authorization lives in Signal Handlers (ADR-0009).
- **Delivery state on Messages.** Cursors replace acks and redelivery bookkeeping (ADR-0015). What a Nostr Channel's `outbox` row records is that a wrap is owed to the Relay, not that a Message was delivered to a person; nothing anywhere records the second thing.
- **Which Channel a Message travelled by.** No column on `messages`, no argument to `send`, and no name in the Signal payload. One Channel per Messenger makes all three constant, and the day a second one is constructable they arrive together (ADR-0048).
- **Read state of any kind.** No stored cursor, no unread count, no receipts, no cross-device sync. The read position a client needs is the largest `seq` it holds (ADR-0035).
- **Any way to remove or edit a Message.** No delete, no update, no retention setting (ADR-0035).
- **Identity in the Signal Worker.** It belongs to the Users component alone (ADR-0020, ADR-0029).
- **Any way to remove a User.** No delete, no deactivation flag (ADR-0029).
- **A credential kind column, and any table holding two schemes' secrets.** There is no `kind` column anywhere and no shared credential table. A second scheme is a second **Auth** with a schema of its own, which is what Nostr Auth is, and the two have nothing in common in the database: one stores a digest per User and a row per login, the other stores a grant per key and a row per request (ADR-0052, ADR-0053). A deployment that wants a third and does not want to write one constructs Password Auth and calls `issueToken` from its own code.
- **Account-recovery state.** No reset tokens, no verification records, no security answers (ADR-0014, ADR-0030).
- **Failed-attempt counters or lockout state.** Deliberately absent; throttling is the deployment edge's (ADR-0030).
- **Any record of a signature.** Signatures stores nothing, so an injected agent's Signed Statements exist only in a log line carrying the `typ` and a SHA-256 digest of the statement (ADR-0042).
- **A `typ` allowlist or reserved prefix.** Nothing is reserved and `saf-decision+jws` is not special-cased; `typ` is the agent's own signed claim (ADR-0042).
- **Key rotation, key identifiers and any stored key.** Two keypairs — the Signing identity and the Nostr identity — each supplied by the Operator, never generated and never persisted (ADR-0041, ADR-0050). The Nostr Channel and Nostr Auth both store *other people's* public keys, in tables of their own, and neither stores the agent's.
- **Any addressee on a Decision.** No `user_id`, no group, no Party (ADR-0043).
- **Notification that a Decision was published.** No Signal and no push; Users poll (ADR-0043).
