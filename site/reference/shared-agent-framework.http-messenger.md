# shared-agent-framework/http-messenger

The HTTP Messenger, from `shared-agent-framework/http-messenger`.

`createHttpMessenger` is the whole of it for an Operator. Hand it the Db, the User Manager, the
Signal Worker and both servers. It registers its two route groups at `/messages` on both. Then
key it in the Gateway's record before the Signal Worker, so that it stops after the drain.

It answers with two methods no request can express. `send` writes a Message to one User from
inside the caller's transaction. `history` reads any User's log. There is no method that writes
an inbound Message.

`messageReceivedKind` and `MessageRecord` are the two halves of this component's Signal
contract. An Operator's Handler map needs no string literal and no re-declared payload. This
subpath also carries the one table. Barrel `shared-agent-framework/users` beside it, because
`messages.user_id` references the User Manager's table.

## Example

A Gateway that answers a submitted Message, and a Handler written against the record.
```ts
import { createGateway, templateHandler } from "shared-agent-framework";
import type { MessageRecord } from "shared-agent-framework/http-messenger";
import { createHttpMessenger, messageReceivedKind } from "shared-agent-framework/http-messenger";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createUsers } from "shared-agent-framework/users";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
    return {
      users,
      messages: createHttpMessenger({ db, users, worker, agentServer, publicServer }),
    };
  },
  handlers: ({ messages }) => ({
    [messageReceivedKind]: templateHandler<MessageRecord>({
      template: new URL("./prompts/message.hbs", import.meta.url),
      session: (signal) => `user_${signal.payload.userId}`,
      data: async (signal) => ({ log: await messages.history(signal.payload.userId) }),
    }),
  }),
});

await gateway.start();
```

## Type Aliases

### HttpMessenger

```ts
type HttpMessenger = Component & {
  history: (userId, options?) => Promise<MessageRecord[]>;
  send: <TSchema>(tx, userId, text) => Promise<MessageRecord>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
```

The HTTP Messenger as a Component: the two things trusted code needs and no request can express.

A send that joins a transaction of the caller's own, and a read of any User's whole log. Every
other capability is a route this component registered itself, and no route plugin is exported.

The two together are what make the post phase useful for messaging. A Handler told that a Run
failed can tell the person who asked. There is no method that writes an inbound Message, because
`direction` is decided by the server a request arrived on.

#### Type Declaration

##### history()

```ts
history(userId, options?): Promise<MessageRecord[]>;
```

One User's Messages, both directions, ascending by `seq`.

So a Handler can build a Prompt from more than the one Message that woke it. Any User's log is
readable here, and not only the log a Run is serving. A read, so it takes no transaction and
cannot see the caller's own uncommitted write.

The same query both routes answer from, with the same cursor options. No cursor is the newest
`limit`, `before` the newest `limit` below it, and `after` everything above it. Both cursors
together answer the stretch between them here, where a route refuses them. `limit` defaults to
the routes' default and is not capped.

###### Parameters

###### userId

`string`

###### options?

`Partial`\<[`CursorWindow`](shared-agent-framework.md#cursorwindow)\>

###### Returns

`Promise`\<[`MessageRecord`](#messagerecord)[]\>

##### send()

```ts
send<TSchema>(
   tx, 
   userId, 
text): Promise<MessageRecord>;
```

Sends a Message to one User from inside the caller's transaction, and answers with the record.

Takes the caller's transaction, so answering somebody and recording why in the Operator's own
tables cannot come apart. A rollback loses both. The caller cannot read this write back
through `history`, which is why the record comes back here.

Always outbound, and there is no parameter for the direction. An unknown User is a thrown
`UnknownUserError` rather than a 404, because there is no reply to write one into. The insert
runs in a savepoint, so that refusal does not abort the caller's transaction.

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

##### start()

```ts
start(): Promise<void>;
```

Does nothing. There is nothing here to start.

Delivery is polling, so there is no connection to open and no ticker to set going. A client
resumes with `?after=<seq>`, and this component holds nothing between requests.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Does nothing, and is the first of the two that will stop being a no-op.

Push delivery is what would give it open responses to close. A Message submitted during a
shutdown is stored, and its Signal commits with it and stays `pending`.

###### Returns

`Promise`\<`void`\>

***

### HttpMessengerOptions

```ts
type HttpMessengerOptions = {
  agentServer: {
     fastify: FastifyInstance;
  };
  db: Db;
  publicServer: {
     fastify: FastifyInstance;
  };
  users: Users;
  worker: SignalWorker;
};
```

Everything `createHttpMessenger` needs: the Db, two Components, and both servers.

#### Properties

##### agentServer

```ts
readonly agentServer: {
  fastify: FastifyInstance;
};
```

The Agent server, where the agent sends a Message and reads a User's log, at `/messages`.

Required for the reason the Public server is. An HTTP Messenger the agent cannot answer
through is broken rather than smaller.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### db

```ts
readonly db: Db;
```

The Db this component queries through. It takes a handle to its own one table.

##### publicServer

```ts
readonly publicServer: {
  fastify: FastifyInstance;
};
```

The Public server, where Users reach their own Messages, at `/messages`.

Required, unlike the User Manager's servers. A Messenger nobody can reach is broken rather
than smaller. Structural, so what `serverComponent` returns satisfies it.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### users

```ts
readonly users: Users;
```

The User Manager whose Users these Messages belong to. Build it before this.

Named nominally, and required, because `messages.user_id` is a foreign key onto
`saf_users.users.id`. This component needs our Manager at the schema level.

It is also where the Public routes' authentication comes from. `requireUser` is taken off this
object and put on the route as one option. Every refusal is therefore the Manager's single 401.

##### worker

```ts
readonly worker: SignalWorker;
```

The Signal Worker a submitted Message wakes.

Named nominally for the reason `users` is. Required, because a Message that woke nobody would
be a Producer that produces nothing.

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

## Variables

### httpMessagesSchema

```ts
const httpMessagesSchema: PgSchema<"saf_http_messages">;
```

The HTTP Messenger's schema, named for the component and not only for its subject.

Prefixed because the framework is installed into a database it does not own. The name is not an
Operator's to change. The table below is compiled against it, and their generation reads that
same object.

"HTTP" is the durable half of this component's name. A second messaging Producer is a peer with
a schema of its own rather than a rename of this one.

***

### httpMessagesTables

```ts
const httpMessagesTables: {
  messages: PgTableWithColumns<{
  }>;
};
```

Everything the HTTP Messenger keeps, as `db.handle` wants it.

One object, so every module of this component asks for the same handle by the same name.

#### Type Declaration

##### messages

```ts
messages: PgTableWithColumns<{
}>;
```

One Message, in one direction, belonging to exactly one User.

One table for both directions, which is what makes a User's log a single numbered sequence.

***

### messageDirections

```ts
const messageDirections: readonly ["inbound", "outbound"];
```

Which way a Message travelled: `inbound` or `outbound`.

Decided by the server the request arrived on, so there is no field anywhere for a caller to set.

***

### messageReceivedKind

```ts
const messageReceivedKind: "message.received" = "message.received";
```

The `kind` of the Signal a submitted Message emits.

Half of this component's Signal contract. The other half is that the payload is the
`MessageRecord`, flat. So a Handler is written `SignalHandler<MessageRecord>`, or
`templateHandler<MessageRecord>`, and its data function type-checks against that record.

A `kind` with no Handler registered fails the Signal permanently and stores the Message anyway.

***

### messages

```ts
const messages: PgTableWithColumns<{
}>;
```

One Message, in one direction, belonging to exactly one User.

One table for both directions, which is what makes a User's log a single numbered sequence.

## Functions

### createHttpMessenger()

```ts
function createHttpMessenger(options): HttpMessenger;
```

Builds the HTTP Messenger and registers its routes at `/messages` on both servers.

Nothing here connects, listens or applies DDL. Key the result before the Signal Worker, so that
it stops after the drain. That is when a Signal Handler's post phase reaches it.

#### Parameters

##### options

[`HttpMessengerOptions`](#httpmessengeroptions)

#### Returns

[`HttpMessenger`](#httpmessenger)

#### Example

Built in `extend`, and then used from the Operator's own trusted code.
```ts
import { createGateway } from "shared-agent-framework";
import { createHttpMessenger } from "shared-agent-framework/http-messenger";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createUsers } from "shared-agent-framework/users";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
    return {
      users,
      messages: createHttpMessenger({ db, users, worker, agentServer, publicServer }),
    };
  },
  handlers: () => ({}),
});

await gateway.start();

// A send that commits with whatever else the Operator's transaction writes.
const { db, messages } = gateway.components;
async function tell(userId: string, text: string): Promise<void> {
  await db.tx((tx) => messages.send(tx, userId, text));
}
```
