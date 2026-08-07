# shared-agent-framework/http-channel

The HTTP Channel, the component that reaches a User over HTTP and lets them reach back. A
Channel is what carries a Message to one person over one medium; the Messenger owns the log and
reaches nobody. This one is a submission and a poll on the Public server, which is what a browser
can talk to with no client library.

[createHttpChannel](#createhttpchannel) makes one, and [HttpChannelOptions](#httpchanneloptions) is what it takes.
[HttpChannel](#httpchannel) is what comes back, and there is no method on it that trusted code calls.
Answering a User is `messenger.send` and reading their log is `messenger.history`, and both are
the same call whichever Channel a deployment built.

Build the Messenger first, since the constructor registers with it, and build the User Manager
first too, for the `requireUser` hook both routes run. A Messenger takes one Channel and refuses
the second, so this is where a deployment settles on one medium and gives up the other. Key this
in the Gateway's record ahead of the Signal Worker, beside the Messenger: the Worker is keyed
last so it drains first, and a Signal Handler's post phase may still be answering somebody.

Nothing is stored here and there are no tables, so this subpath has nothing for an Operator's
migration barrel. Barrel `shared-agent-framework/messenger` for the log, and
`shared-agent-framework/users` beside it. There is no queue either, because HTTP delivery is the
User asking: an outbound Message is already in the log, and the next poll carries it.

## Example

A Gateway a browser can talk to: the Messenger, this Channel registered with it, and a Handler
for the Signal a submission emits.
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

// The Public server now answers `POST /messages` and `GET /messages?after=<seq>`. Nothing in
// the Operator's own code calls this Channel: what the agent says back goes through the
// Messenger and arrives on the same log the poll reads.
```

## Type Aliases

### HttpChannel

```ts
type HttpChannel = Channel;
```

The HTTP Channel as a Component, and every member of it does nothing.

`send` is the Messenger's to call and is a no-op: HTTP delivery is the User asking, so an
outbound Message needs nothing from here, being in the log already for the next poll to carry.
`start` and `stop` are no-ops too, because polling opens no connection and sets no ticker going.
`name` is `"http"`, which nothing routes on and nothing stores.

Nothing is kept: no tables, no queue and no read position, so a restart loses nothing this
component was holding and there is nothing here to migrate. The log and every Message in it are
the Messenger's.

So there is no method on this that trusted code calls. What a deployment holds the object for is
its place in the Gateway's record, and everything it does it does for a request on the Public
server or for the Messenger that registered it.

***

### HttpChannelOptions

```ts
type HttpChannelOptions = {
  db: Db;
  messenger: Messenger;
  publicServer: {
     fastify: FastifyInstance;
  };
  users: Users;
};
```

#### Properties

##### db

```ts
readonly db: Db;
```

The Db one transaction is opened on, and queried through not at all.

This component owns no tables. What it needs a Db for is the submission: the Message and the
Signal that wakes the agent for it are one act, and the Messenger's inbound write joins that
transaction rather than opening one of its own.

##### messenger

```ts
readonly messenger: Messenger;
```

The Messenger that owns the log. Build it before this.

The constructor registers with it, and what comes back is the only way to write an inbound
Message. A Messenger that already has a Channel refuses the second, so this is where a
deployment settles on one medium.

##### publicServer

```ts
readonly publicServer: {
  fastify: FastifyInstance;
};
```

Where Users submit and poll, at `/messages`.

A Channel nobody can reach is broken rather than smaller, so there is no assembly of this
component that omits it. Structural: anything carrying a Fastify instance satisfies it,
including what `serverComponent` returns.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### users

```ts
readonly users: Users;
```

Supplies the `requireUser` hook both routes take as one option, and nothing else is read off
it.

Taken and neither wrapped nor re-implemented, so this component authenticates nobody and an
unauthenticated submission or read is refused with the same 401 the routes under `/auth`
answer.

## Functions

### createHttpChannel()

```ts
function createHttpChannel(options): Channel;
```

Builds the HTTP Channel, registers it with the Messenger, and puts one route group at `/messages`
on the Public server: a submission, and a cursored read of the submitting User's own log.

Nothing here connects, listens or applies DDL.

#### Parameters

##### options

[`HttpChannelOptions`](#httpchanneloptions)

#### Returns

[`Channel`](shared-agent-framework.messenger.md#channel)

#### Throws

`ChannelAlreadyRegisteredError` if a Channel is already registered with that Messenger.
  Thrown before either route reaches the server, so a refused second Channel leaves nothing
  behind on it.
