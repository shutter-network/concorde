# shared-agent-framework/http-channel

The HTTP Channel is a Channel implementation for the Messenger, carrying Messages between the
Shared Agent and a User over HTTP. The Messenger owns the log and reaches nobody; a Channel is
what reaches a person over one medium. This one exposes a submission and a poll on the Public
server, which a browser can drive with no client library.

[createHttpChannel](#createhttpchannel) makes one, and [HttpChannelOptions](#httpchanneloptions) is what it takes.
[HttpChannel](#httpchannel) is what comes back, and it has no programmatic API at all. Sending and
reading belong to the Messenger, and HTTP needs no identity of its own beyond the Token a User
already presents, so an Operator's own code calls the Messenger and never this.

Construct the Messenger and Users first. The constructor registers itself with the Messenger,
which accepts at most one Channel, so a deployment that registers this one gives up every other
medium.

It does not use the Db and exports no schema. It stores nothing, and it queues nothing either:
HTTP delivery is the User asking, so an outbound Message is already in the Messenger's log and
the next poll carries it.

## Example

A Gateway a browser can talk to: the Messenger, this Channel registered with it, and a Handler
for the Signal a submission emits.
```ts
import { createGateway } from "shared-agent-framework/gateway";
import { createHttpChannel } from "shared-agent-framework/http-channel";
import type { MessageRecord } from "shared-agent-framework/messenger";
import { createMessenger, messageReceivedKind } from "shared-agent-framework/messenger";
import { createPiRuntime } from "shared-agent-framework/pi";
import { templateHandler } from "shared-agent-framework/signals";
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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> HttpChannel</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.messenger.html#channel" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Channel</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The HTTP Channel as a Component, and every member of it does nothing.

`send` is the Messenger's to call and is a no-op: HTTP delivery is the User asking, so an
outbound Message needs nothing from here, being in the log already for the next poll to carry.
`start` and `stop` are no-ops too, because polling opens no connection and sets no ticker going.
`name` is `"http"`, which nothing routes on and nothing stores.

It keeps nothing: it exports no schema, it queues nothing, and it records no read position, so a
restart loses nothing this component was holding and there is nothing here to migrate. The log
and every Message in it are the Messenger's.

So it has no programmatic API. Everything this Channel does it does for a request on the Public
server or for the Messenger that registered it.

***

### HttpChannelOptions

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> HttpChannelOptions</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  db</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.db.html#db" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Db</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  messenger</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.messenger.html#messenger" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Messenger</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  publicServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">     fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">  };</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  users</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.users.html#users" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Users</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

#### Properties

##### db

```ts
readonly db: Db;
```

The Db one transaction is opened on, and queried through not at all.

This component exports no schema and has no table to read. What it needs a Db for is the
submission: the Message and the Signal that wakes the agent for it are one act, and the
Messenger's inbound write joins that transaction rather than opening one of its own.

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
component that omits it. Structural: anything carrying a Fastify instance satisfies it.

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

Builds the HTTP Channel, registers it with the Messenger, and registers one route group at
`/messages` on the Public server: a submission, and a cursored read of the submitting User's own
log.

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
