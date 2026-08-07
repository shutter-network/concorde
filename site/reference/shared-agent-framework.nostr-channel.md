# shared-agent-framework/nostr-channel

The Nostr Channel, from `shared-agent-framework/nostr-channel`.

`createNostrChannel` is the whole of it for an Operator. Hand it the Db, the Messenger, the
User Manager, the Shared Agent's Nostr secret key as 32 raw bytes, and the address of the one
Relay the Operator runs. It registers itself with that Messenger, and what it gets back is the
only way to write an inbound Message (ADR-0048). Then key it in the Gateway's record before the
Signal Worker, so that it stops after the drain.

**It registers no route on either server.** What a User reaches over this medium is the Relay,
so a deployment running this and nothing else has a Public server with only the User Manager's
login on it. Users message the agent from the Nostr client they already use, in NIP-17 private
direct messages, and a message from a recorded key becomes an inbound Message and a Signal in
one transaction — so every Signal Handler and Prompt template written against the Messenger
keeps working unchanged.

**One Channel per Messenger**, refused at registration, so a deployment runs Nostr or HTTP and
not both. That is why `example/` keeps HTTP and there is no Nostr section in the quickstart.

**A reply travels in two steps, and the split is the design.** `messenger.send` runs the
Channel's own `send` inside the Operator's transaction, where the recipient's key is resolved,
the reply is sealed into one gift wrap, its size is compared against what the Relay advertises,
and the wrap is queued. Anything wrong there throws and takes the Message with it, so nothing
claims to have been sent. The publish itself waits for that transaction to commit and happens in
`drain`. A reply the Relay refuses keeps its queue row with the Relay's own reason on it and is
never attempted again, so `select * from saf_nostr.outbox where reason is not null` answers "why
did she not get it" with no API and no log trawl.

`recordPublicKey` is the one method trusted code calls, and it proves nothing: the Operator
establishes out of band that a key is a person's, and no route anywhere records one, so an
injected prompt cannot claim a User's key (ADR-0049). This subpath also carries the three tables.
Barrel `shared-agent-framework/users` beside it, because `pubkeys.user_id` and `outbox.user_id`
reference the User Manager's table.

The Nostr identity is a **second** keypair, secp256k1 where the signing identity is Ed25519, and
it cannot be that key or become it (ADR-0050). The framework parses no key material: the
constructor takes bytes an Operator decoded themselves, and no `nsec` decoder is shipped.

## Example

A Gateway a User reaches over Nostr, with the key recorded out of band.
```ts
import { readFileSync } from "node:fs";
import { createGateway, templateHandler } from "shared-agent-framework";
import type { MessageRecord } from "shared-agent-framework/messenger";
import { createMessenger, messageReceivedKind } from "shared-agent-framework/messenger";
import { createNostrChannel } from "shared-agent-framework/nostr-channel";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createUsers } from "shared-agent-framework/users";

const secretKey = Uint8Array.from(
  Buffer.from(readFileSync(process.env.NOSTR_KEY_FILE ?? "", "utf8").trim(), "hex"),
);

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
    const messenger = createMessenger({ db, users, worker, agentServer });
    return {
      users,
      messenger,
      nostr: createNostrChannel({
        db,
        messenger,
        users,
        secretKey,
        relayUrl: process.env.RELAY_URL ?? "",
      }),
    };
  },
  handlers: ({ messenger }) => ({
    [messageReceivedKind]: templateHandler<MessageRecord>({
      template: new URL("./prompts/message.hbs", import.meta.url),
      session: (signal) => `user_${signal.payload.userId}`,
      data: async (signal) => ({ log: await messenger.history(signal.payload.userId) }),
    }),
  }),
});

await gateway.start();
```

## Classes

### MalformedPublicKeyError

The public key offered was not a Nostr public key.

Refused at the call site rather than stored, because the alternative is silent and permanent: a
key recorded as an `npub1…`, in upper case, or with a `0x` in front of it is compared byte for
byte against the author of every decrypted message and matches none of them, so the User simply
never hears from the agent and nothing anywhere says why.

This decodes nothing. An Operator holding an `npub` calls `nip19.decode` themselves, which is
ADR-0050's parse-nothing rule read from the other side.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new MalformedPublicKeyError(publicKey): MalformedPublicKeyError;
```

###### Parameters

###### publicKey

`string`

###### Returns

[`MalformedPublicKeyError`](#malformedpublickeyerror)

###### Overrides

```ts
Error.constructor
```

***

### MessageTooLargeError

The finished wrap is larger than the Relay said it accepts.

Thrown inside the caller's transaction and before the Message row survives, so an over-long
reply is a refusal at the call site rather than a queue row that fails once and stops. What is
measured is the whole client message and not the reply, because sealing it more than doubles its
length. The maximum is read from the Relay's own NIP-11 document, so a Relay that advertises
none is a Relay this is never thrown for, and an over-long reply is then whatever that Relay
does with it.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new MessageTooLargeError(
   userId, 
   bytes, 
   limit): MessageTooLargeError;
```

###### Parameters

###### userId

`string`

###### bytes

`number`

###### limit

`number`

###### Returns

[`MessageTooLargeError`](#messagetoolargeerror)

###### Overrides

```ts
Error.constructor
```

***

### NoSuchUserError

No User has that id: PostgreSQL's `23503`, which is the foreign key catching a wrong id.

An error class and not a status, because there is no route here to answer one with. Recording a
key is trusted code's alone.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new NoSuchUserError(userId): NoSuchUserError;
```

###### Parameters

###### userId

`string`

###### Returns

[`NoSuchUserError`](#nosuchusererror)

###### Overrides

```ts
Error.constructor
```

***

### PublicKeyConflictError

The key, or the User, is already spoken for: PostgreSQL's `23505`.

Both directions are refused and this is deliberate. A key already recorded cannot be claimed by
a second User, or one person's messages would land in another's log. And a User already holding
a key cannot be given a second, because there would then be no answer to which one the agent
writes back to.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new PublicKeyConflictError(userId, publicKey): PublicKeyConflictError;
```

###### Parameters

###### userId

`string`

###### publicKey

`string`

###### Returns

[`PublicKeyConflictError`](#publickeyconflicterror)

###### Overrides

```ts
Error.constructor
```

***

### UnrecordedPublicKeyError

The User has no Nostr public key recorded, so there is no address to answer them at.

Thrown inside the caller's transaction and **before the Message row survives**, which is the
point: a Message recorded as sent that nothing can deliver is a durable claim that somebody was
told something. The Operator records a key from their own trusted code, out of band, so this is
an admission that never happened rather than a transient failure to retry.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new UnrecordedPublicKeyError(userId): UnrecordedPublicKeyError;
```

###### Parameters

###### userId

`string`

###### Returns

[`UnrecordedPublicKeyError`](#unrecordedpublickeyerror)

###### Overrides

```ts
Error.constructor
```

## Type Aliases

### NostrChannel

```ts
type NostrChannel = Channel & {
  publicKey: string;
  drain: () => Promise<void>;
  recordPublicKey: <TSchema>(tx, userId, publicKey) => Promise<void>;
  send: <TSchema>(tx, message) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
```

The Nostr Channel as a Component: a Channel, its own public key, and the one act of admission.

`recordPublicKey` is the only method trusted code calls. Everything else this component does,
it does for the Relay it is connected to or for the Messenger that registered it.

A deployment holds it to key it in the Gateway's record, ahead of the Signal Worker like the
Messenger itself: a Signal Handler's post phase runs `messenger.send` into this component's
`send`, so it has to outlive the drain.

#### Type Declaration

##### publicKey

```ts
readonly publicKey: string;
```

The Shared Agent's own Nostr public key, in lowercase hex, derived from the secret key it was
built with.

What a User's client shows as the agent's identity, and what an Operator tells a User to
message. It is an address as well as an identity, which is what makes it unrotatable in
practice: every recorded key is a row written from the other side, and every User's client
holds the old one (ADR-0050).

Hex and not an `npub`, for the reason there is no `nsec` decoder either. An Operator who
wants the human-facing form calls `nip19.npubEncode` themselves.

##### drain()

```ts
drain(): Promise<void>;
```

Publishes every queued reply the Relay has not answered for yet, and resolves when none is
left.

The half of a send that happens after the commit, exposed rather than hidden so that a test
can drive it without waiting on a database notification. `start` wires the notification to
this same method, so nothing in a running deployment calls it.

A reply the Relay accepts leaves no trace. A reply it refuses keeps its row, carrying the
Relay's own reason, and is **never attempted again** — not by a later notification, and not by
a later process. Nothing here throws for a refusal; a refusal is a row and a log line.

A reply the Relay took but never answered for, because the process stopped or died between the
two, still has its row and goes out again on the next start. Both the Relay and the
recipient's client key on the event's own id, so what a User sees is still one message.

It publishes nothing while the Channel is stopped. Whatever is queued then waits for the next
`start`.

###### Returns

`Promise`\<`void`\>

##### recordPublicKey()

```ts
recordPublicKey<TSchema>(
   tx, 
   userId, 
publicKey): Promise<void>;
```

Records that one Nostr public key belongs to one User, and **proves nothing**.

An Operator records a key from their own code, having established out of band that it is
theirs. That is the whole of admission over this medium, and it is deliberately the whole:
**no route on either server records a key**, because doing so is authorization-shaped — it
grants access to a Message log — so it joins `users.setAttributes` in the class an injected
prompt cannot reach (ADR-0049). The recorded cost is that the agent cannot admit a stranger,
and a message from a key nobody recorded is dropped with nothing stored.

A write, so it takes the caller's transaction first: recording a key and whatever the
Operator writes about the admission commit together or not at all. It replaces nothing —
there is no rotation here, in the same sense that there is none for either identity.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### userId

`string`

###### publicKey

`string`

64 lowercase hex characters. An `npub` is refused rather than stored,
  because a stored one would match no message and nothing would say why.

###### Returns

`Promise`\<`void`\>

###### Throws

`MalformedPublicKeyError` if that is not what it got.

###### Throws

`NoSuchUserError` if no User has that id.

###### Throws

`PublicKeyConflictError` if that key belongs to another User, or that User already
  has one. The insert runs in a savepoint, so no refusal aborts the caller's transaction.

##### send()

```ts
send<TSchema>(tx, message): Promise<void>;
```

Takes an outbound Message inside the transaction writing it, and **publishes nothing**.

The Messenger calls this; trusted code reaches `messenger.send` instead, and gets this for
free. What happens here is everything that can be known before a commit: the recipient's key
is looked up on the caller's own transaction, the reply is sealed into one gift wrap, its size
on the wire is compared against what the Relay advertises, and the finished wrap is queued. A
failure at any of those steps is a throw that rolls the Message back with it, so a Message
recorded as sent was always one that could go out.

What it does **not** do is reach the Relay. The publish waits for the commit and happens in
[NostrChannel.drain](#nostrchannel), so a rollback after this returns leaves nobody holding words the
log denies.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### message

[`MessageRecord`](shared-agent-framework.messenger.md#messagerecord)

###### Returns

`Promise`\<`void`\>

###### Throws

`UnrecordedPublicKeyError` if no Nostr public key is recorded for that User.

###### Throws

`MessageTooLargeError` if the wrap is larger than the Relay's advertised maximum
  message length. The Relay is asked for that maximum once per connection, so a Channel that
  has not started has not asked and bounds nothing: an over-long reply sent to a stopped
  Channel is queued, and fails once at the next start rather than here.

##### start()

```ts
start(): Promise<void>;
```

Opens the connection to the Relay, subscribes to the agent's own gift wraps, and publishes
whatever a previous process left queued.

Nothing connects before this. It does not wait for the connection: a Relay that is down is an
outage rather than a boot failure, and the client reconnects with a backoff of its own. A
second `start` finds a client already built and does nothing.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Closes the connection and stops handling what arrives on it or what is queued for it.

It returns once nothing is in flight, so a Message half-written when shutdown began is either
committed or rolled back before the Db is closed under it. A publish interrupted here leaves
its row untouched rather than marking it refused, so the next `start` attempts it. The client
is discarded rather than reused, because the library's `close` is terminal; a later `start`
builds a fresh one.

###### Returns

`Promise`\<`void`\>

***

### NostrChannelOptions

```ts
type NostrChannelOptions = {
  db: Db;
  logger?: Logger;
  messenger: Messenger;
  relayUrl: string;
  secretKey: Uint8Array;
  users: Users;
};
```

Everything `createNostrChannel` needs: the Db, two Components, an identity and a Relay.

#### Properties

##### db

```ts
readonly db: Db;
```

The Db this component queries through. It takes a handle to its own two tables.

Also where the inbound transaction is opened: the Message, its Signal and this component's
own record that the envelope was processed are one act, and the Messenger's inbound write
takes a transaction rather than opening one so that they can be.

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to a `pino` instance on stdout.

##### messenger

```ts
readonly messenger: Messenger;
```

The Messenger that owns the log. Build it before this.

The constructor calls `register` on it, which is what makes this Channel the one that reaches
people and hands back the only way to write an inbound Message. A second Channel on the same
Messenger is refused there, which is why a deployment runs Nostr or HTTP and not both.

##### relayUrl

```ts
readonly relayUrl: string;
```

The Relay to connect to, as a `ws://` or `wss://` address.

One Relay, and the Operator's own, so that Users' conversations do not traverse a stranger's
server. It is used exactly as given, with no normalisation: Relays treat trailing variants as
distinct addresses, and NIP-42's `relay` tag is compared by whatever rule the Relay chose.

##### secretKey

```ts
readonly secretKey: Uint8Array;
```

The Shared Agent's Nostr secret key: **32 raw bytes**, and the second keypair a deployment
running this holds (ADR-0050).

Raw bytes because that is both Nostr libraries' own convention, and because the framework
parses no key material and generates none: an Operator reads their own key and states it
here, exactly as they hand `createSignatures` a `KeyObject` they built themselves (ADR-0041).
No `nsec` decoder is shipped — shipping one would be the framework parsing key material behind
a friendlier name — so an Operator holding an `nsec` calls `nip19.decode` themselves.

It cannot be the signing identity and could not become one: that key is Ed25519 and this
curve is secp256k1. Copying this one impersonates the agent to its Users; copying that one
forges its commitments.

##### users

```ts
readonly users: Users;
```

The User Manager whose Users these public keys belong to.

Named nominally, and required, because `pubkeys.user_id` is a foreign key onto
`saf_users.users.id`. This component needs our Manager at the schema level, and nothing is
called on it: there is no route here for it to authenticate, and a Nostr public key is not a
credential the Gateway issued.

## Variables

### nostrChannelSchema

```ts
const nostrChannelSchema: PgSchema<"saf_nostr">;
```

The Nostr Channel's schema, named for the protocol rather than for the component.

Prefixed because the framework is installed into a database it does not own. The name is not
an Operator's to change: the tables below are compiled against it, and their generation reads
that same object.

***

### nostrChannelTables

```ts
const nostrChannelTables: {
  outbox: PgTableWithColumns<{
  }>;
  pubkeys: PgTableWithColumns<{
  }>;
  received: PgTableWithColumns<{
  }>;
};
```

Everything the Nostr Channel keeps, as `db.handle` wants it.

One object, so every module of this component asks for the same handle by the same name.

#### Type Declaration

##### outbox

```ts
outbox: PgTableWithColumns<{
}>;
```

Every gift wrap that is owed to the Relay, or that the Relay refused.

**This table is the seam between the two halves of a send.** A publish cannot be rolled back and
a transaction can, so the whole wrap is built and stored inside the caller's transaction, and
the network act happens after that transaction commits. A row is therefore a durable claim that
a Message was accepted for delivery, written in the same transaction as the Message itself: a
rollback loses both, and no recipient holds words the log denies.

The row is deleted when the Relay accepts the wrap, so a healthy deployment keeps this table
empty. A row carrying a `reason` is one the Relay refused, and it is **never attempted again**.
Recovering it is an Operator replaying the row by hand, and this table is where retries, backoff
and an attempt cap would land if they were ever wanted.

So `select * from saf_nostr.outbox where reason is not null` is the whole answer to "why did she
not get it", and it needs no API.

##### pubkeys

```ts
pubkeys: PgTableWithColumns<{
}>;
```

Which Nostr public key belongs to which User, and the whole of admission over this medium.

**Written from trusted code only.** There is no route on either server that records one, so an
injected prompt cannot claim a User's key and take over their conversation
(ADR-0049). The recorded cost is that the agent cannot admit a stranger: a key nobody put here
is a key whose messages are dropped.

Uniqueness runs both ways, and the two constraints refuse different mistakes. `user_id` is the
primary key, so one User holds at most one Nostr key. `pubkey` is unique, so a key already
recorded cannot be claimed by a second User — which is what stops one person's key becoming a
second person's inbox.

##### received

```ts
received: PgTableWithColumns<{
}>;
```

Every envelope that has already become a Message, keyed by the gift wrap's event id.

**This is the correctness mechanism for inbound, and the subscription's `since`-lessness is
why** (ADR-0049). NIP-59 randomises a wrap's timestamp up to two days into the past, so a
timestamp watermark is not a valid cursor and the Channel re-reads what the Relay holds on
every connect instead. A primary key is what turns that repetition into nothing: the insert
shares the transaction that writes the Message, so a conflict means "already processed" and a
rollback un-processes it.

Three other problems collapse into this one constraint: reconnect overlap, the `created_at`
tie when the paged read of stored events walks backwards, and the Relay delivering an event
twice.

**Only admitted events get a row.** An envelope from a public key no `pubkeys` row names is
dropped and nothing whatever is stored for it, so a stranger who learns the agent's public
identity cannot grow this table. That also means such an envelope is harmlessly re-dropped on
every connect. The table is therefore the same order of magnitude as the Message log, and
nothing prunes it.

***

### outbox

```ts
const outbox: PgTableWithColumns<{
}>;
```

Every gift wrap that is owed to the Relay, or that the Relay refused.

**This table is the seam between the two halves of a send.** A publish cannot be rolled back and
a transaction can, so the whole wrap is built and stored inside the caller's transaction, and
the network act happens after that transaction commits. A row is therefore a durable claim that
a Message was accepted for delivery, written in the same transaction as the Message itself: a
rollback loses both, and no recipient holds words the log denies.

The row is deleted when the Relay accepts the wrap, so a healthy deployment keeps this table
empty. A row carrying a `reason` is one the Relay refused, and it is **never attempted again**.
Recovering it is an Operator replaying the row by hand, and this table is where retries, backoff
and an attempt cap would land if they were ever wanted.

So `select * from saf_nostr.outbox where reason is not null` is the whole answer to "why did she
not get it", and it needs no API.

***

### pubkeys

```ts
const pubkeys: PgTableWithColumns<{
}>;
```

Which Nostr public key belongs to which User, and the whole of admission over this medium.

**Written from trusted code only.** There is no route on either server that records one, so an
injected prompt cannot claim a User's key and take over their conversation
(ADR-0049). The recorded cost is that the agent cannot admit a stranger: a key nobody put here
is a key whose messages are dropped.

Uniqueness runs both ways, and the two constraints refuse different mistakes. `user_id` is the
primary key, so one User holds at most one Nostr key. `pubkey` is unique, so a key already
recorded cannot be claimed by a second User — which is what stops one person's key becoming a
second person's inbox.

***

### received

```ts
const received: PgTableWithColumns<{
}>;
```

Every envelope that has already become a Message, keyed by the gift wrap's event id.

**This is the correctness mechanism for inbound, and the subscription's `since`-lessness is
why** (ADR-0049). NIP-59 randomises a wrap's timestamp up to two days into the past, so a
timestamp watermark is not a valid cursor and the Channel re-reads what the Relay holds on
every connect instead. A primary key is what turns that repetition into nothing: the insert
shares the transaction that writes the Message, so a conflict means "already processed" and a
rollback un-processes it.

Three other problems collapse into this one constraint: reconnect overlap, the `created_at`
tie when the paged read of stored events walks backwards, and the Relay delivering an event
twice.

**Only admitted events get a row.** An envelope from a public key no `pubkeys` row names is
dropped and nothing whatever is stored for it, so a stranger who learns the agent's public
identity cannot grow this table. That also means such an envelope is harmlessly re-dropped on
every connect. The table is therefore the same order of magnitude as the Message log, and
nothing prunes it.

## Functions

### createNostrChannel()

```ts
function createNostrChannel(options): NostrChannel;
```

Builds the Nostr Channel and registers it with the Messenger.

Nothing here connects, listens or applies DDL — the connection is `start`'s. Key the result
before the Signal Worker, so that it stops after the drain.

#### Parameters

##### options

[`NostrChannelOptions`](#nostrchanneloptions)

#### Returns

[`NostrChannel`](#nostrchannel)

#### Throws

`ChannelAlreadyRegisteredError` if a Channel is already registered with that Messenger.

#### Example

Built in `extend`, after the Messenger it registers with, and given an identity the Operator
read for themselves.
```ts
import { readFileSync } from "node:fs";
import { createGateway } from "shared-agent-framework";
import { createMessenger } from "shared-agent-framework/messenger";
import { createNostrChannel } from "shared-agent-framework/nostr-channel";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createUsers } from "shared-agent-framework/users";

// The framework parses no key material: 32 raw bytes, decoded by the deployment.
const secretKey = Uint8Array.from(
  Buffer.from(readFileSync(process.env.NOSTR_KEY_FILE ?? "", "utf8").trim(), "hex"),
);

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
    const messenger = createMessenger({ db, users, worker, agentServer });
    return {
      users,
      messenger,
      nostr: createNostrChannel({
        db,
        messenger,
        users,
        secretKey,
        relayUrl: process.env.RELAY_URL ?? "",
      }),
    };
  },
  handlers: () => ({}),
});

await gateway.start();

// Admission, out of band and from trusted code, in a transaction of the Operator's own.
const { db, nostr } = gateway.components;
await db.tx((tx) => nostr.recordPublicKey(tx, "a-user-id", "ab".repeat(32)));
```
