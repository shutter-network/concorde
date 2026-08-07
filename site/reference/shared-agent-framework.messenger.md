# shared-agent-framework/messenger

The Messenger, from `shared-agent-framework/messenger`.

`createMessenger` is the whole of it for an Operator. Hand it the Db, the User Manager, the
Signal Worker and the Agent server. It registers the agent's route group at `/messages` on that
server. Then key it in the Gateway's record before the Signal Worker, so that it stops after the
drain.

**It owns the Message log and reaches nobody.** Getting a Message to a person is a Channel's
job: build one — `shared-agent-framework/http-channel` is the one that serves a browser — hand
it this Messenger, and it registers itself. One Channel per Messenger, refused at registration
rather than documented.

It answers with three things no request can express. `register` takes the Channel and answers
with the only way to write an inbound Message. `send` writes a Message to one User from inside
the caller's transaction. `history` reads any User's log.

`messageReceivedKind` and `MessageRecord` are the two halves of this component's Signal
contract, and neither changed when the log was taken out of the HTTP Messenger, so a Handler
written against that part needs no edit. An Operator's Handler map needs no string literal and
no re-declared payload. This subpath also carries the one table. Barrel
`shared-agent-framework/users` beside it, because `messages.user_id` references the User
Manager's table.

## Example

A Gateway that answers a submitted Message, and a Handler written against the record.
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
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
    const messenger = createMessenger({ db, users, worker, agentServer });
    return {
      users,
      messenger,
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
```

## Type Aliases

### Channel

```ts
type Channel = Component & {
  name: string;
  send: <TSchema>(tx, message) => Promise<void>;
};
```

What reaches one person over one medium: a name, a send, and a lifecycle.

Two members over a `Component`, which is the same order of narrowness as `Component` itself. A
Channel is an ordinary Component an Operator constructs and keys, and it is switched off by not
constructing it.

A Channel registers **itself**, at the end of its own constructor: the same act as a component
registering its routes on the servers it was handed. It has to be that way round, because a
Channel is constructed with the Messenger and the reference cannot run both ways at construction
time.

#### Type Declaration

##### name

```ts
readonly name: string;
```

Which Channel this is, as a constant of its type rather than a construction option.

`"http"` for the HTTP Channel. It is not an identifier anything looks up: nothing routes on
it, because there is one Channel, and nothing stores it, because a column constant in every
row answers no question. It is what a log line and a refusal name.

##### send()

```ts
send<TSchema>(tx, message): Promise<void>;
```

Takes an outbound Message, inside the transaction that is writing it.

The promise is only "this Message is yours now", which is why the member is not called
`deliver`: arrival is not something every medium can promise. It is not called `enqueue`
either, because the HTTP Channel has no queue — HTTP delivery is the User asking — and a
member named for one would be false for it.

**It must not perform the network act.** A publish cannot be rolled back and a transaction
can. So an implementation does everything knowable synchronously and throws for anything
wrong, which rolls the caller's transaction back and leaves nothing half-done, and whatever
has to travel travels after the commit.

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

Which way one Message travelled. One of `messageDirections`.

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

The POST response, both reads, the trusted-code methods and the Signal payload are one shape
rather than a projection each. So `direction` is on a Signal payload, where it is always
`inbound`. `createdAt` is an ISO 8601 string, because JSON has no date.

A Handler for a submitted Message is written `SignalHandler<MessageRecord>`.

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

The Messenger as a Component: the three things trusted code needs and no request can express.

A registration that hands a Channel the only way to write an inbound Message, a send that joins
a transaction of the caller's own, and a read of any User's whole log. Every other capability
is a route this component registered itself, and no route plugin is exported.

`send` and `history` together are what make the post phase useful for messaging. A Handler told
that a Run failed can tell the person who asked, whichever medium reaches them.

#### Type Declaration

##### history()

```ts
history(userId, options?): Promise<MessageRecord[]>;
```

One User's Messages, both directions, ascending by `seq`.

So a Handler can build a Prompt from more than the one Message that woke it. Any User's log is
readable here, and not only the log a Run is serving. A read, so it takes no transaction and
cannot see the caller's own uncommitted write.

The same query both surfaces answer from, with the same cursor options. No cursor is the
newest `limit`, `before` the newest `limit` below it, and `after` everything above it. Both
cursors together answer the stretch between them here, where a route refuses them. `limit`
defaults to the routes' default and is not capped.

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

Takes the Channel that will reach people, and answers with the handle it writes inbound
Messages through.

Called by the Channel's own constructor and by nothing else. An Operator's entry point
performs no wiring here: constructing a Channel with this Messenger is the whole act.

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

Takes the caller's transaction, so answering somebody and recording why in the Operator's own
tables cannot come apart. A rollback loses both, and loses whatever the Channel wrote in the
same transaction to get the Message out. The caller cannot read this write back through
`history`, which is why the record comes back here.

Always outbound, and there is no parameter for the direction and none for the Channel. An
unknown User is a thrown `UnknownUserError` rather than a 404, because there is no reply to
write one into. The insert runs in a savepoint, so that refusal does not abort the caller's
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

Does nothing. There is nothing here to start.

The Messenger holds no connection and runs no loop. A Channel that needs one opens it in its
own `start`, and this component does not know that one exists.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Does nothing.

A Message submitted during a shutdown is stored, and its Signal commits with it and stays
`pending`.

###### Returns

`Promise`\<`void`\>

***

### MessengerHandle

```ts
type MessengerHandle = {
  receive: <TSchema>(tx, userId, text) => Promise<MessageRecord>;
};
```

What a Channel gets back from `register`, and the only way an inbound Message can be written.

There is no public `receive` on the Messenger. A Channel keeps this handle and writes through
it, so **only a registered Channel can write an inbound Message**, and a Channel cannot claim
to be a different one because it never names itself in the call. There is no
`messenger.receive(tx, userId, channelName, text)` to reach for instead.

#### Methods

##### receive()

```ts
receive<TSchema>(
   tx, 
   userId, 
text): Promise<MessageRecord>;
```

Records one inbound Message and the Signal that wakes the agent for it, in one transaction.

The caller's transaction, so a Channel's own bookkeeping — a processed-event row, a queue row
— commits with the Message or not at all. A Message that was stored always has its Signal.

Answers with the record as it was stored, `seq` and all. That is what the HTTP Channel's 201
carries, and the caller cannot read its own uncommitted write back through `history`.

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

Everything `createMessenger` needs: the Db, two Components, and the Agent server.

#### Properties

##### agentServer

```ts
readonly agentServer: {
  fastify: FastifyInstance;
};
```

The Agent server, where the agent sends a Message and reads a User's log, at `/messages`.

Required. A Messenger the agent cannot answer through is broken rather than smaller.
Structural, so what `serverComponent` returns satisfies it.

There is no Public server option here. What a User reaches is a Channel's, and a Channel that
is not HTTP has no route on it at all.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### db

```ts
readonly db: Db;
```

The Db this component queries through. It takes a handle to its own one table.

##### users

```ts
readonly users: Users;
```

The User Manager whose Users these Messages belong to. Build it before this.

Named nominally, and required, because `messages.user_id` is a foreign key onto
`saf_users.users.id`. This component needs our Manager at the schema level, and nothing is
called on it: authentication belongs to the Channels, which serve the routes a User reaches.

##### worker

```ts
readonly worker: SignalWorker;
```

The Signal Worker an inbound Message wakes.

Named nominally for the reason `users` is. Required, because a Message that woke nobody would
be a Producer that produces nothing.

## Variables

### messageDirections

```ts
const messageDirections: readonly ["inbound", "outbound"];
```

Which way a Message travelled: `inbound` or `outbound`.

Decided by which of the Messenger's two writes wrote it — a Channel's inbound `receive` or
trusted code's outbound `send` — so there is no field anywhere for a caller to set.

***

### messageReceivedKind

```ts
const messageReceivedKind: "message.received" = "message.received";
```

The `kind` of the Signal an inbound Message emits.

Half of this component's Signal contract. The other half is that the payload is the
`MessageRecord`, flat. So a Handler is written `SignalHandler<MessageRecord>`, or
`templateHandler<MessageRecord>`, and its data function type-checks against that record.

**Unchanged by the split**, and unchanged by which Channel a Message arrived over: the payload
names no Channel, because one Channel per Messenger makes that field constant in every Signal.
A Handler written against the HTTP Messenger needs no edit.

A `kind` with no Handler registered fails the Signal permanently and stores the Message anyway.

***

### messages

```ts
const messages: PgTableWithColumns<{
}>;
```

One Message, in one direction, belonging to exactly one User.

One table for both directions, which is what makes a User's log a single numbered sequence.

***

### messengerSchema

```ts
const messengerSchema: PgSchema<"saf_messenger">;
```

The Messenger's schema, named for the component that owns the log.

Prefixed because the framework is installed into a database it does not own. The name is not an
Operator's to change. The table below is compiled against it, and their generation reads that
same object.

It was `saf_http_messages` while one component held the log *and* the only way of reaching a
person, so a deployment upgrading from that version renames the schema. A Channel is what
reaches a person now, and it has no share of this one.

***

### messengerTables

```ts
const messengerTables: {
  messages: PgTableWithColumns<{
  }>;
};
```

Everything the Messenger keeps, as `db.handle` wants it.

One object, so every module of this component asks for the same handle by the same name.

#### Type Declaration

##### messages

```ts
messages: PgTableWithColumns<{
}>;
```

One Message, in one direction, belonging to exactly one User.

One table for both directions, which is what makes a User's log a single numbered sequence.

## Functions

### createMessenger()

```ts
function createMessenger(options): Messenger;
```

Builds the Messenger and registers the agent's routes at `/messages` on the Agent server.

Nothing here connects, listens or applies DDL. Key the result before the Signal Worker, so that
it stops after the drain. That is when a Signal Handler's post phase reaches it. Key every
Channel there too, for the same reason: that post phase runs `send` into `channel.send`.

#### Parameters

##### options

[`MessengerOptions`](#messengeroptions)

#### Returns

[`Messenger`](#messenger)

#### Example

Built in `extend` with the one Channel that reaches people, and then used from the Operator's
own trusted code.
```ts
import { createGateway } from "shared-agent-framework";
import { createHttpChannel } from "shared-agent-framework/http-channel";
import { createMessenger } from "shared-agent-framework/messenger";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createUsers } from "shared-agent-framework/users";

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
      http: createHttpChannel({ db, messenger, users, publicServer }),
    };
  },
  handlers: () => ({}),
});

await gateway.start();

// A send that commits with whatever else the Operator's transaction writes.
const { db, messenger } = gateway.components;
async function tell(userId: string, text: string): Promise<void> {
  await db.tx((tx) => messenger.send(tx, userId, text));
}
```
