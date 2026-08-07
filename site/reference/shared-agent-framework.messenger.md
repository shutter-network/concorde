# shared-agent-framework/messenger

The Messenger component owns the Message log. A Message is a `text` string travelling one way
between the Shared Agent and one User, numbered from 1 inside that User's log across both
directions, kept forever.

[createMessenger](#createmessenger) makes one. [Messenger](#messenger) is what comes back, and its programmatic API
registers a Channel, sends to one User inside a transaction the caller opened, and reads any
User's whole log. [MessageRecord](#messagerecord) is the record every surface answers with, and an inbound
one is also the payload of the Signal that announces it. That Signal's `kind` is
[messageReceivedKind](#messagereceivedkind), so a Handler map keys off an exported constant and types its payload
as `MessageRecord`, declaring neither for itself.

The Messenger reaches nobody. A [Channel](#channel) carries a Message to a person over one medium,
and `shared-agent-framework/http-channel` and `shared-agent-framework/nostr-channel` are the two
implementations that ship. Construct one with this Messenger and it registers itself, so an entry
point wires nothing further.

A Messenger accepts at most one Channel, and registering a second throws. A deployment therefore
runs one medium. Until a Channel registers, `send` throws rather than recording a Message nothing
will deliver.

Construct Users and the Signal Worker before this, which takes both.

The subpath exports the one table beside the constructor. Put `shared-agent-framework/users` into
the same schema, because `messages.user_id` references the Users component's table, and a schema
without it generates a foreign key onto a table nothing creates.

## Example

A Gateway whose agent answers a submitted Message over HTTP, and a send from the Operator's own
trusted code.
```ts
import { createGateway, templateHandler } from "shared-agent-framework";
import { createHttpChannel } from "shared-agent-framework/http-channel";
import type { MessageRecord } from "shared-agent-framework/messenger";
import { createMessenger, messageReceivedKind } from "shared-agent-framework/messenger";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createUsers } from "shared-agent-framework/users";

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
      // The Channel takes the Messenger and registers itself with it.
      http: createHttpChannel({ db, messenger, users, publicServer }),
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

// A send that commits with whatever else the Operator's transaction writes.
const { db, messenger } = gateway.components;
async function tell(userId: string, text: string): Promise<void> {
  await db.tx((tx) => messenger.send(tx, userId, text));
}
```

## Type Aliases

### Channel

```ts
type Channel = Component & {
  name: string;
  send: <TSchema>(tx, message) => Promise<void>;
};
```

What reaches one person over one medium.

A name, a send, and a lifecycle. A Channel is an ordinary Component an Operator constructs and
keys in the Gateway's record, and it is switched off by not constructing it.

A Channel registers itself, at the end of its own constructor, the same act as a component
registering its routes on the servers it was handed. It has to be that way round: a Channel is
constructed with the Messenger, so the reference cannot run both ways at construction time.

#### Type Declaration

##### name

```ts
readonly name: string;
```

Which Channel this is, as a constant of its type rather than a construction option.

Nothing looks it up. There is no routing on it, one Channel being all there is, and no column
storing it. It is what a log line and a refused second registration name.

##### send()

```ts
send<TSchema>(tx, message): Promise<void>;
```

Takes an outbound Message, inside the transaction that is writing it.

The promise is only that the Message is the Channel's now. Arrival is not something every
medium can promise, and a queue is not something every medium has: HTTP delivery is the User
asking.

It must not perform the network act. A publish cannot be rolled back and a transaction can. So
an implementation does everything knowable synchronously and throws for anything wrong, which
rolls the caller's transaction back and leaves nothing half-done, and whatever has to travel
travels after the commit.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### message

[`MessageRecord`](#messagerecord)

###### Returns

`Promise`\<`void`\>

***

### MessageDirection

```ts
type MessageDirection = typeof messageDirections[number];
```

***

### MessageRecord

```ts
type MessageRecord = {
  createdAt: string;
  direction: MessageDirection;
  id: string;
  seq: number;
  text: string;
  userId: string;
};
```

A Message, as every surface answers with it.

The POST response, both reads, the Messenger's programmatic API and the Signal payload are one
shape rather than a projection each, so `direction` is on a Signal payload too, where it is
always `inbound`.

`seq` numbers this Message inside one User's log across both directions, from 1, and it is the
cursor a read pages by. It is not global, and no other User's activity moves it.

`createdAt` is an ISO 8601 string, because JSON has no date.

#### Properties

##### createdAt

```ts
readonly createdAt: string;
```

##### direction

```ts
readonly direction: MessageDirection;
```

##### id

```ts
readonly id: string;
```

##### seq

```ts
readonly seq: number;
```

##### text

```ts
readonly text: string;
```

##### userId

```ts
readonly userId: string;
```

***

### Messenger

```ts
type Messenger = Component & {
  history: (userId, options?) => Promise<MessageRecord[]>;
  register: (channel) => MessengerHandle;
  send: <TSchema>(tx, userId, text) => Promise<MessageRecord>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
```

The Message log as a Component: one table holding every Message in both directions, numbered per
User.

Its programmatic API is three methods: a registration that hands a Channel the only way to write
an inbound Message, a send that joins a transaction of the caller's own, and a read of any User's
whole log. Every other capability is a route this component registered itself, and no route
plugin is exported.

It reaches nobody. Every outbound Message goes out through the one registered [Channel](#channel),
and there is none until one is constructed.

Nothing removes a Message and no column is ever updated, so the log is the durable record of what
was said and the table grows forever.

`start` and `stop` do nothing. This component holds no connection and runs no loop, and a Channel
that needs one opens it in its own `start`. A Message that arrives during a shutdown is stored,
and its Signal commits with it and stays pending for the next boot.

#### Type Declaration

##### history()

```ts
history(userId, options?): Promise<MessageRecord[]>;
```

Reads one User's Messages, both directions, ascending by `seq`, so a Handler can build a Prompt
from more than the one Message that woke it.

Any User's log is readable, and not only the log a Run is serving. A read, so it takes no
transaction and cannot see the caller's own uncommitted write.

`options` is the cursor window, and the same one both routes take. No cursor answers the newest
`limit`, `before` the newest `limit` below it, and `after` everything above it. Both cursors
together answer the stretch between them here, where a route refuses them. `limit` takes the
routes' default when omitted and is not capped, a cap being there to bound a response body.

###### Parameters

###### userId

`string`

###### options?

`Partial`\<[`CursorWindow`](shared-agent-framework.md#cursorwindow)\>

###### Returns

`Promise`\<[`MessageRecord`](#messagerecord)[]\>

##### register()

```ts
register(channel): MessengerHandle;
```

Registers the Channel that will reach people, and answers with the handle it writes inbound
Messages through.

Called by the Channel's own constructor and by nothing else, so an entry point performs no
wiring here: constructing a Channel with this Messenger is the whole act.

###### Parameters

###### channel

[`Channel`](#channel)

###### Returns

[`MessengerHandle`](#messengerhandle)

###### Throws

`ChannelAlreadyRegisteredError` on a second Channel. One per Messenger.

##### send()

```ts
send<TSchema>(
   tx, 
   userId, 
text): Promise<MessageRecord>;
```

Sends a Message to one User from inside the caller's transaction, and answers with the record.

Taking the transaction is what keeps answering somebody and recording why in the Operator's own
tables from coming apart: a rollback loses both, and loses whatever the Channel wrote in the
same transaction to get the Message out. The record comes back from here because the caller
cannot read its own uncommitted write through `history`.

Always outbound. There is no parameter for the direction and none for the Channel. An unknown
User is a thrown `UnknownUserError` rather than a status, there being no reply to write one
into, and the insert runs in a savepoint so that refusal does not abort the caller's
transaction.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### userId

`string`

###### text

`string`

###### Returns

`Promise`\<[`MessageRecord`](#messagerecord)\>

###### Throws

`NoChannelError` if no Channel has registered, before anything is written.

##### start()

```ts
start(): Promise<void>;
```

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

###### Returns

`Promise`\<`void`\>

***

### MessengerHandle

```ts
type MessengerHandle = {
  receive: <TSchema>(tx, userId, text) => Promise<MessageRecord>;
};
```

What a Channel gets back from [Messenger](#messenger)'s `register`, and the only way an inbound Message
can be written.

There is no public `receive` on the Messenger. A Channel keeps this handle and writes through it,
so a Channel cannot claim to be a different one: it never names itself in the call.

#### Methods

##### receive()

```ts
receive<TSchema>(
   tx, 
   userId, 
text): Promise<MessageRecord>;
```

Records one inbound Message and the Signal that wakes the agent for it, and answers with the
record as it was stored, `seq` and all.

Both statements run in the caller's transaction, so a Channel's own bookkeeping commits with
the Message or not at all, and a Message that was stored always has its Signal. The record
comes back from here because the caller cannot read its own uncommitted write back through
`history`.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### userId

`string`

###### text

`string`

###### Returns

`Promise`\<[`MessageRecord`](#messagerecord)\>

###### Throws

`UnknownUserError` if no User has that id. The insert runs in a savepoint, so the
  refusal does not abort the caller's transaction.

***

### MessengerOptions

```ts
type MessengerOptions = {
  agentServer: {
     fastify: FastifyInstance;
  };
  db: Db;
  users: Users;
  worker: SignalWorker;
};
```

#### Properties

##### agentServer

```ts
readonly agentServer: {
  fastify: FastifyInstance;
};
```

Where the agent sends a Message and reads a User's log, at `/messages`.

There is no Public server option. What a User reaches is a Channel's, and a Channel that is not
HTTP has no route anywhere.

Structural: anything carrying a Fastify instance satisfies it, including what
`serverComponent` returns.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### db

```ts
readonly db: Db;
```

##### users

```ts
readonly users: Users;
```

The Users component whose Users these Messages belong to. Build it first.

Nothing is called on it. `messages.user_id` is a foreign key onto `saf_users.users.id`, so the
dependency is at the schema level, and authentication belongs to the Channel, which serves the
routes a User reaches.

##### worker

```ts
readonly worker: SignalWorker;
```

The Signal Worker an inbound Message wakes, in the same transaction that stores the Message.

No Messenger can be built without one. A Message that woke nobody would leave the agent with
nothing to answer.

## Variables

### messageDirections

```ts
const messageDirections: readonly ["inbound", "outbound"];
```

Which way a Message travelled: `inbound` from the User to the agent, `outbound` from the agent to
the User.

Decided by which of the Messenger's two writes wrote it, a Channel's inbound `receive` or trusted
code's outbound `send`, so there is no field anywhere for a caller to set and only a User can
cause an inbound one.

***

### messageReceivedKind

```ts
const messageReceivedKind: "message.received" = "message.received";
```

The `kind` of the Signal an inbound Message emits.

Half of this component's Signal contract. The other half is that the payload is the
[MessageRecord](#messagerecord), flat, so a Handler is written `SignalHandler<MessageRecord>` and its data
function type-checks against that record.

The payload names no Channel, one Channel per Messenger making that field constant in every
Signal, so a Handler cannot tell which medium a Message arrived over and has nothing to branch
on.

A `kind` with no Handler registered stores the Message anyway and fails its Signal permanently.

***

### messages

```ts
const messages: PgTableWithColumns<{
}>;
```

One Message, in one direction, belonging to exactly one User: the durable record of what was
said.

One table for both directions, which is what makes a User's log a single numbered sequence, and
no column saying which Channel it travelled by. Nothing removes a row and no column is ever
updated, so it grows forever.

`user_id` is a foreign key onto the `users` table of Users. A barrel carrying this
component without `shared-agent-framework/users` generates a reference to a table nothing
creates, and dies on `schema "saf_users" does not exist`.

***

### messengerSchema

```ts
const messengerSchema: PgSchema<"saf_messenger">;
```

The PostgreSQL schema the table below lives in, `saf_messenger`.

Prefixed because the framework is installed into a database it does not own, and not an
Operator's to change: the table is compiled against this object, and the same object is what a
generation reads.

It was `saf_http_messages` while one component held the log and the only way of reaching a
person, so a deployment upgrading across that split renames the schema.

***

### messengerTables

```ts
const messengerTables: {
  messages: PgTableWithColumns<{
  }>;
};
```

#### Type Declaration

##### messages

```ts
messages: PgTableWithColumns<{
}>;
```

One Message, in one direction, belonging to exactly one User: the durable record of what was
said.

One table for both directions, which is what makes a User's log a single numbered sequence, and
no column saying which Channel it travelled by. Nothing removes a row and no column is ever
updated, so it grows forever.

`user_id` is a foreign key onto the `users` table of Users. A barrel carrying this
component without `shared-agent-framework/users` generates a reference to a table nothing
creates, and dies on `schema "saf_users" does not exist`.

## Functions

### createMessenger()

```ts
function createMessenger(options): Messenger;
```

Builds the Messenger and registers the agent's route group at `/messages` on the Agent server.

Nothing here connects, listens or applies DDL, and no Channel is built: the Messenger reaches
nobody until one registers with it.

#### Parameters

##### options

[`MessengerOptions`](#messengeroptions)

#### Returns

[`Messenger`](#messenger)
