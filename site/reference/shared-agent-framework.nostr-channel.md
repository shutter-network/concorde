# shared-agent-framework/nostr-channel

The Nostr Channel is a Channel implementation for the Messenger, reaching a User in the Nostr
client they already use and letting them reach the Shared Agent from it. The Messenger owns the
log and reaches nobody; a Channel is what reaches a person over one medium. This one exchanges
NIP-17 private direct messages over a single connection to one **Relay** the Operator runs, and a
message from a public key the Operator recorded becomes an inbound Message and its Signal in one
transaction, so a Signal Handler or a Prompt template written against the Messenger needs no
change.

[createNostrChannel](#createnostrchannel) makes one. [NostrChannel](#nostrchannel) is what comes back. Its programmatic
API is `recordPublicKey`, which admits one User to this medium, and `publicKey`, which is the
address an Operator tells that User to write to; everything else on it the Messenger and the
Relay drive. [NostrChannelOptions](#nostrchanneloptions) takes the Shared Agent's Nostr secret key as 32 raw
bytes, a second keypair that the signing identity neither is nor can become.

It registers no route on either server, a Relay being what a User reaches over this medium, so a
deployment running this and nothing else has a Public server carrying only the login. It
publishes one thing about itself and no profile, a relay list naming that Relay, so the agent
appears in a client as a bare public key.

Construct the Messenger and Users first: the constructor registers with the Messenger, and these
public keys belong to Users. A Messenger accepts at most one Channel and refuses a second at
registration, so a deployment runs Nostr or HTTP and not both.

The subpath exports the three tables, `pubkeys`, `received` and `outbox`, beside the constructor,
for the schema an Operator generates their migrations from. Put `shared-agent-framework/users`
into that same schema, because two of those tables reference the Users component's table, and a
schema without it generates a foreign key onto a table nothing creates.

## Example

A Gateway a User reaches over Nostr, with their public key recorded out of band.
```ts
import { readFileSync } from "node:fs";
import { createGateway } from "shared-agent-framework/gateway";
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
  // Not loopback: the agent reaches this server from a container of its own.
  agentListen: { host: "0.0.0.0", port: 8081 },
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

// What an Operator tells that User to message.
console.log(nostr.publicKey);
```

## Classes

### MalformedPublicKeyError

The public key offered was not a Nostr public key: 64 lowercase hex characters are what one is.

Refused at the call site rather than stored, because a stored one fails silently and permanently.
A key written as an `npub1…`, in upper case, or with a `0x` in front of it is compared byte for
byte against the author of every decrypted message and matches none of them, so the User never
hears from the agent and nothing anywhere says why.

Nothing here decodes anything. An Operator holding an `npub` calls `nip19.decode` on it
themselves, the way they decode the secret key the constructor takes.

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

The finished gift wrap is larger than the Relay said it accepts.

Thrown inside the caller's transaction and before the Message row survives, so an over-long reply
is a refusal at the call site rather than something that fails after the fact. What is measured is
the whole message that goes on the wire and not the reply, because sealing more than doubles its
length: reckon on a 1.4 KB floor plus 2.1 times the reply, the payload being base64 of base64, so
a 32 KB reply is roughly a 66 KB wrap against a common Relay default of 65536.

The maximum comes from the Relay's own NIP-11 document. A Relay that advertises none is a Relay
this is never thrown for, and an over-long reply is then whatever that Relay does with it.

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

No User has that id, so no key was recorded for them.

The write itself is what establishes that the User exists, so a User created earlier in the
caller's own transaction counts and needs no commit first.

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

The key, or the User, is already spoken for.

Both directions are refused. A key already recorded cannot be claimed by a second User, or one
person's messages would land in another's log; and a User already holding a key cannot be given a
second, because there would then be no answer to which one the agent writes back to.

Neither is replaced. Whichever mapping exists is the one that stays, and getting rid of it is a
`delete` an Operator writes against the table.

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

Thrown inside the transaction the Message is being written in and before that Message row
survives, which is the point: a Message recorded as sent that nothing can deliver is a durable
claim that somebody was told something. Nothing was written, and the fix is recording a key rather
than sending again.

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> NostrChannel</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.messenger.html#channel" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Channel</span></a><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> &#x26;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  publicKey</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  drain</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  recordPublicKey</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> &#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">tx</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">userId</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">publicKey</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  send</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> &#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">tx</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">message</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  start</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  stop</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

The Nostr Channel as a Component: an identity, one Relay connection, and the one act of admission.

Three tables are what it keeps, and no Message is among them: which public key belongs to which
User, which envelopes it has already turned into Messages, and which replies the Relay has not
taken yet. The Messages themselves are the Messenger's, whichever medium they travelled by.

It admits nobody by itself. A message from a public key nobody recorded through
[NostrChannel.recordPublicKey](#nostrchannel) is dropped with nothing stored for it, so a stranger who
learns the agent's public key can neither reach the log nor grow the tables.

The Relay connection is real work at both ends: nothing connects at construction, `start` opens
it and `stop` closes it. What survives a stop is what PostgreSQL holds. A reply that was queued
and not published keeps its row and goes out at the next start, and a Message already written
stays written.

#### Type Declaration

##### publicKey

```ts
readonly publicKey: string;
```

The Shared Agent's own Nostr public key, in lowercase hex, derived from the secret key it was
built with.

What a User's client shows as the agent, and what an Operator tells a User to message. It is an
address as well as an identity, which is what makes it unrotatable in practice: every recorded
key was written from the other side, and every User's client holds this one.

Hex and not an `npub`, for the reason the constructor takes bytes. An Operator who wants the
human-facing form calls `nip19.npubEncode` on it themselves.

##### drain()

```ts
drain(): Promise<void>;
```

Publishes every queued reply the Relay has not answered for yet, and resolves when none is left.

The half of a send that happens after the commit, exposed so that a caller can wait for it
rather than for a database notification. A running deployment needs no call: `start` wires the
notification a queued reply raises to this same method.

A reply the Relay accepts leaves no trace. A reply it refuses keeps its row, carrying the
Relay's own reason, and is never attempted again, not by a later notification and not by a later
process. A refusal is a row and a log line rather than a throw.

A reply the Relay took but never answered for, because the process stopped between the two,
still has its row and goes out again at the next start. Both the Relay and the recipient's
client key on the event's own id, so what a User sees is still one message.

It publishes nothing while the Channel is stopped, and whatever is queued then waits for the
next `start`.

###### Returns

`Promise`\<`void`\>

##### recordPublicKey()

```ts
recordPublicKey<TSchema>(
   tx, 
   userId, 
publicKey): Promise<void>;
```

Records that one Nostr public key belongs to one User, and proves nothing.

The Operator establishes out of band that the key is that person's, and this stores what they
decided. It is the whole of admission over this medium, and deliberately the whole: no route on
either server records a key, because recording one grants access to a Message log, so it sits
with the other writes an injected prompt cannot reach. The cost is that the agent cannot admit a
stranger.

A write, so it takes the caller's transaction first: the key and whatever the Operator records
about the admission commit together or not at all. `publicKey` is 64 lowercase hex characters,
which is what a Nostr public key is on the wire.

It replaces nothing. There is no rotation here, in the same sense that there is none for either
identity.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.db.md#handle)\<`TSchema`\>

###### userId

`string`

###### publicKey

`string`

###### Returns

`Promise`\<`void`\>

###### Throws

`MalformedPublicKeyError` if that is not what `publicKey` is.

###### Throws

`NoSuchUserError` if no User has that id.

###### Throws

`PublicKeyConflictError` if that key belongs to another User, or that User already has
  one. Every refusal here runs in a savepoint, so none of them aborts the caller's transaction.

##### send()

```ts
send<TSchema>(tx, message): Promise<void>;
```

Takes an outbound Message inside the transaction writing it, and publishes nothing.

The Messenger calls this, and trusted code reaches its `send` instead and gets this for free.
What happens here is everything knowable before a commit: the recipient's key is read on the
caller's own transaction, the reply is sealed into one gift wrap, its size on the wire is
compared against what the Relay advertises, and the finished wrap is queued. A failure at any of
those steps throws and rolls the Message back with it, so a Message recorded as sent was always
one that could go out.

It never touches the Relay. The publish waits for the commit and happens in
[NostrChannel.drain](#nostrchannel), so a rollback after this returns leaves nobody holding words the
log denies.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.db.md#handle)\<`TSchema`\>

###### message

[`MessageRecord`](shared-agent-framework.messenger.md#messagerecord)

###### Returns

`Promise`\<`void`\>

###### Throws

`UnrecordedPublicKeyError` if no Nostr public key is recorded for that User.

###### Throws

`MessageTooLargeError` if the wrap exceeds the Relay's advertised maximum message
  length. The Relay is asked for that maximum once per connection, so a Channel that has not
  started has not asked and bounds nothing: an over-long reply sent to a stopped Channel is
  queued, and fails once at the next start rather than here.

##### start()

```ts
start(): Promise<void>;
```

Opens the connection to the Relay, subscribes to the agent's own gift wraps, publishes the
agent's relay list, and publishes whatever a previous process left queued.

Nothing connects before this, and this waits for none of it: a Relay that is down is an outage
rather than a boot failure, and the client reconnects with a backoff of its own. A second
`start` finds a client already built and does nothing.

The relay list is one event naming the Relay this Channel was built with, and it is the only
thing the agent publishes about itself. It buys two narrow things and not discoverability: a
client that refuses to message a public key with no such list will message this one, and a
client that reads one is steered to the right Relay. Only a client already on that Relay can
read it. A Relay that refuses it is a warning on the log and a Channel that started anyway, and
a restart says it again at no cost, the kind being replaceable.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Closes the connection, and stops both admitting what arrives on it and publishing what is
queued for it.

It returns once nothing is in flight, so a Message half-written when shutdown began is either
committed or rolled back before the Db is closed under it. A publish interrupted here leaves its
row untouched rather than marking it refused, so the next `start` attempts it.

###### Returns

`Promise`\<`void`\>

***

### NostrChannelOptions

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> NostrChannelOptions</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  db</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.db.html#db" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Db</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  logger</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.logging.html#logger" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Logger</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  messenger</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.messenger.html#messenger" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Messenger</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  relayUrl</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  secretKey</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Uint8Array</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  users</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.users.html#users" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Users</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

#### Properties

##### db

```ts
readonly db: Db;
```

The Db this component queries through, and where the inbound transaction is opened.

Writing the Message, emitting its Signal and recording that this envelope was read are one act,
so they share one transaction of this component's own.

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to a `pino` instance on stdout.

A dropped envelope is a debug line and the only trace of it anywhere, nothing being stored for
one. A reply the Relay refused is an error line beside the queue row that keeps the reason, and
a relay list the Relay refused is a warning and nothing else.

##### messenger

```ts
readonly messenger: Messenger;
```

The Messenger that owns the log. Construct it before this.

The constructor registers with it, which is what makes this the Channel that reaches people and
hands back the only way to write an inbound Message. A second Channel on the same Messenger is
refused there, so a deployment runs one medium.

##### relayUrl

```ts
readonly relayUrl: string;
```

The Relay to connect to, as a `ws://` or `wss://` address.

One Relay, and the Operator's own, so that Users' conversations do not traverse a stranger's
server. It is used exactly as given, with no normalisation: Relays treat trailing variants as
distinct addresses, and the address this agent authenticates with and the address it publishes
in its relay list are compared by whatever rule the Relay chose.

##### secretKey

```ts
readonly secretKey: Uint8Array;
```

The Shared Agent's Nostr secret key: 32 raw bytes, and the second keypair a deployment running
this holds.

Raw bytes because that is both Nostr libraries' own convention, and because the framework parses
no key material and generates none. An Operator reads their own key and states it here, exactly
as they hand a `KeyObject` they built themselves to the signing identity. No `nsec` decoder is
shipped, so an Operator holding one calls `nip19.decode` themselves.

It cannot be the signing identity and could not become one, that key being Ed25519 and this
curve secp256k1. Copying this one impersonates the agent to its Users; copying that one forges
its commitments.

##### users

```ts
readonly users: Users;
```

The Users component whose Users these public keys belong to.

Nothing is called on it. It is named because `pubkeys.user_id` is a foreign key onto that
table of Users, so this component needs the real one rather than something shaped like it:
there is no route here to authenticate, and a Nostr public key is not a credential the Gateway
issued.

## Variables

### nostrChannelSchema

```ts
const nostrChannelSchema: PgSchema<"saf_nostr">;
```

The PostgreSQL schema every table below lives in, `saf_nostr`, named for the protocol rather than
for the component.

Prefixed because the framework is installed into a database it does not own, and not
configurable: the tables are compiled against this object, and the same object is what a
generation reads.

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

#### Type Declaration

##### outbox

```ts
outbox: PgTableWithColumns<{
}>;
```

Every gift wrap that is owed to the Relay, or that the Relay refused.

A row is a durable claim that a Message was accepted for delivery, written in the same transaction
as the Message itself: a rollback loses both, so no recipient holds words the log denies. The wrap
is built and stored before that commit and published after it, which is what makes the table the
seam between the two halves of a send.

A wrap the Relay accepts leaves no row, so a healthy deployment keeps this table empty. A row
carrying a `reason` is one the Relay refused, and it is never attempted again; recovering it is an
Operator replaying the row by hand.

So `select * from saf_nostr.outbox where reason is not null` is the whole answer to "why did she
not get it", and it needs no API.

##### pubkeys

```ts
pubkeys: PgTableWithColumns<{
}>;
```

Which Nostr public key belongs to which User, and the whole of admission over this medium.

Written from trusted code only. No route on either server records a row here, so an injected
prompt cannot claim a User's key and take over their conversation. The cost is that the agent
cannot admit a stranger: a key nobody put here is a key whose messages are dropped.

Uniqueness runs both ways, and the two constraints refuse different mistakes. `user_id` is the
primary key, so one User holds at most one Nostr key. `pubkey` is unique, so a key already
recorded cannot be claimed by a second User, which is what stops one person's key becoming a
second person's inbox.

##### received

```ts
received: PgTableWithColumns<{
}>;
```

Every envelope that has already become a Message, keyed by the gift wrap's event id.

This is the correctness mechanism for inbound. NIP-59 randomises a wrap's timestamp up to two days
into the past, so a timestamp watermark is not a valid cursor, and the Channel therefore asks the
Relay for everything it holds on every connect. A primary key is what turns that repetition into
nothing: the insert shares the transaction that writes the Message, so a conflict means "already
processed" and a rollback un-processes it. Reconnect overlap and a Relay that serves one event
twice collapse into the same constraint.

Only admitted envelopes get a row. One from a public key no `pubkeys` row names is dropped with
nothing stored for it, so a stranger who learns the agent's public key cannot grow this table, and
that envelope is harmlessly re-dropped on every connect. The table is therefore the same order of
magnitude as the Message log, and nothing prunes it.

***

### outbox

```ts
const outbox: PgTableWithColumns<{
}>;
```

Every gift wrap that is owed to the Relay, or that the Relay refused.

A row is a durable claim that a Message was accepted for delivery, written in the same transaction
as the Message itself: a rollback loses both, so no recipient holds words the log denies. The wrap
is built and stored before that commit and published after it, which is what makes the table the
seam between the two halves of a send.

A wrap the Relay accepts leaves no row, so a healthy deployment keeps this table empty. A row
carrying a `reason` is one the Relay refused, and it is never attempted again; recovering it is an
Operator replaying the row by hand.

So `select * from saf_nostr.outbox where reason is not null` is the whole answer to "why did she
not get it", and it needs no API.

***

### pubkeys

```ts
const pubkeys: PgTableWithColumns<{
}>;
```

Which Nostr public key belongs to which User, and the whole of admission over this medium.

Written from trusted code only. No route on either server records a row here, so an injected
prompt cannot claim a User's key and take over their conversation. The cost is that the agent
cannot admit a stranger: a key nobody put here is a key whose messages are dropped.

Uniqueness runs both ways, and the two constraints refuse different mistakes. `user_id` is the
primary key, so one User holds at most one Nostr key. `pubkey` is unique, so a key already
recorded cannot be claimed by a second User, which is what stops one person's key becoming a
second person's inbox.

***

### received

```ts
const received: PgTableWithColumns<{
}>;
```

Every envelope that has already become a Message, keyed by the gift wrap's event id.

This is the correctness mechanism for inbound. NIP-59 randomises a wrap's timestamp up to two days
into the past, so a timestamp watermark is not a valid cursor, and the Channel therefore asks the
Relay for everything it holds on every connect. A primary key is what turns that repetition into
nothing: the insert shares the transaction that writes the Message, so a conflict means "already
processed" and a rollback un-processes it. Reconnect overlap and a Relay that serves one event
twice collapse into the same constraint.

Only admitted envelopes get a row. One from a public key no `pubkeys` row names is dropped with
nothing stored for it, so a stranger who learns the agent's public key cannot grow this table, and
that envelope is harmlessly re-dropped on every connect. The table is therefore the same order of
magnitude as the Message log, and nothing prunes it.

## Functions

### createNostrChannel()

```ts
function createNostrChannel(options): NostrChannel;
```

Builds the Nostr Channel and registers it with the Messenger.

Nothing here connects, listens or applies DDL.

#### Parameters

##### options

[`NostrChannelOptions`](#nostrchanneloptions)

#### Returns

[`NostrChannel`](#nostrchannel)

#### Throws

`ChannelAlreadyRegisteredError` if a Channel is already registered with that Messenger.
