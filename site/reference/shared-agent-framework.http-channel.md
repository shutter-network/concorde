# shared-agent-framework/http-channel

The HTTP Channel, from `shared-agent-framework/http-channel`.

`createHttpChannel` is the whole of it for an Operator. Hand it the Db, the Messenger, the User
Manager and the Public server. It registers itself with the Messenger and puts one route group
at `/messages` on that server: a submission, and a cursored read of the submitting User's own
log. Then key it in the Gateway's record before the Signal Worker, beside the Messenger, so that
it stops after the drain.

**It owns no tables, and this subpath carries a constructor and nothing beside it.** The log is
the Messenger's, so there is nothing here for an Operator's migration barrel: barrel
`shared-agent-framework/messenger` instead, and `shared-agent-framework/users` beside it.

It answers with no method trusted code calls. Everything it does, it does for a request or for
the Messenger: `send` is a no-op, because HTTP delivery is the User asking, and `start` and
`stop` are no-ops because polling holds nothing between requests. What trusted code wants —
`send` into whichever medium reaches a person, and `history` — is on the Messenger and is the
same call whichever Channel a deployment built.

There is **no route anywhere that chooses a Channel**, and no Message records which one it
travelled by: one Channel per Messenger, so a deployment runs HTTP or another medium and not
both.

## Example

A Gateway a browser can talk to: the Messenger, and this Channel registered with it.
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

### HttpChannel

```ts
type HttpChannel = Channel;
```

The HTTP Channel as a Component, and it is a Channel and nothing more.

There is no method here that trusted code calls: everything this component does, it does for a
request on the Public server or for the Messenger that registered it. `send` is the Messenger's
to call and does nothing; `start` and `stop` do nothing, because polling opens no connection and
sets no ticker going.

A deployment holds it to key it in the Gateway's record, ahead of the Signal Worker like the
Messenger itself.

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

Everything `createHttpChannel` needs: the Db, two Components, and the Public server.

#### Properties

##### db

```ts
readonly db: Db;
```

The Db this component opens one transaction on, and queries through not at all.

It owns no tables. What it needs a Db for is the transaction a submission runs in: the Message
and the Signal that wakes the agent for it are one act, and the Messenger's inbound write
takes the transaction rather than opening one, so that a Channel with bookkeeping of its own
can join it.

##### messenger

```ts
readonly messenger: Messenger;
```

The Messenger that owns the log. Build it before this.

The constructor calls `register` on it, which is what makes this Channel the one that reaches
people and hands back the only way to write an inbound Message. A second Channel on the same
Messenger is refused there.

##### publicServer

```ts
readonly publicServer: {
  fastify: FastifyInstance;
};
```

The Public server, where Users reach their own Messages, at `/messages`.

Required. A Channel nobody can reach is broken rather than smaller. Structural, so what
`serverComponent` returns satisfies it.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### users

```ts
readonly users: Users;
```

The User Manager whose Users these Messages belong to.

Where the routes' authentication comes from, and the whole of what this option is for.
`requireUser` is taken off this object and put on the route as one option, so every refusal is
the Manager's single 401 and this component authenticates nobody.

## Functions

### createHttpChannel()

```ts
function createHttpChannel(options): Channel;
```

Builds the HTTP Channel, registers it with the Messenger, and puts its routes at `/messages` on
the Public server.

Nothing here connects, listens or applies DDL. Key the result before the Signal Worker, so that
it stops after the drain: a Signal Handler's post phase runs `messenger.send` into this
component's `send`.

#### Parameters

##### options

[`HttpChannelOptions`](#httpchanneloptions)

#### Returns

[`Channel`](shared-agent-framework.messenger.md#channel)

#### Throws

`ChannelAlreadyRegisteredError` if a Channel is already registered with that Messenger.

#### Example

Built in `extend`, after the Messenger it registers with.
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
```
