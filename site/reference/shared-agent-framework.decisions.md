# shared-agent-framework/decisions

The Decisions component owns the one global log of Decisions. A Decision is a Statement the
Shared Agent has committed to in public: signed with its key, numbered from 1, kept forever, and
readable by every User rather than addressed to one.

[createDecisions](#createdecisions) makes one. [Decisions](#decisions) is what comes back, and its programmatic API
publishes into the log and reads it back. [DecisionRecord](#decisionrecord) is what every surface answers
with, and `jws` is the field that matters: the artifact is the Decision, and the other three
fields can be read back out of it by anybody holding the public key.

Construct Signatures and Users first. Every Decision is signed, so there is no degraded mode in
which rows arrive without artifacts.

Publishing notifies nobody. It emits no Signal and wakes no Handler, so a User discovers a
Decision by polling, and the largest `seq` they hold is the whole resume mechanism.

The subpath exports the one table beside the constructor, for the schema an Operator generates
their migrations from. It references no other component's table, so it can go into that schema
on its own.

## Example

A Gateway with Decisions, and a Statement committed to from the Operator's own code.
```ts
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGateway } from "shared-agent-framework/gateway";
import { createDecisions } from "shared-agent-framework/decisions";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createSignatures } from "shared-agent-framework/signatures";
import { createUsers } from "shared-agent-framework/users";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  // Not loopback: the agent reaches this server from a container of its own.
  agentListen: { host: "0.0.0.0", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer }) => {
    const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
    const signatures = createSignatures({
      signingKey: createPrivateKey(readFileSync("./signing-key.pem")),
      agentServer,
      publicServer,
      users,
    });
    return {
      users,
      signatures,
      decisions: createDecisions({ db, signatures, users, agentServer, publicServer }),
    };
  },
  handlers: () => ({}),
});

await gateway.start();

// The artifact is in hand before the transaction commits.
const { db, decisions } = gateway.components;
const published = await db.tx((tx) => decisions.publish(tx, "shipping on Friday"));
console.log(published.seq, published.jws);
```

## Type Aliases

### DecisionRecord

```ts
type DecisionRecord = {
  createdAt: string;
  jws: string;
  seq: number;
  statement: string;
};
```

A Decision as every surface answers with it: the publish response, both reads, and `history`.

The artifact is the Decision. Anybody holding the public key reads the other three fields back
out of `jws`, which is what makes handing one string to a third party worth doing.

`createdAt` is ISO 8601, JSON having no date, and is the same string the artifact's payload
carries rather than a re-rendering of it.

#### Properties

##### createdAt

```ts
readonly createdAt: string;
```

##### jws

```ts
readonly jws: string;
```

##### seq

```ts
readonly seq: number;
```

##### statement

```ts
readonly statement: string;
```

***

### Decisions

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Decisions</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.gateway.html#component" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Component</span></a><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> &#x26;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  history</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">options</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><a href="#decisionrecord" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">DecisionRecord</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">[]>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  publish</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> &#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">tx</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">statement</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><a href="#decisionrecord" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">DecisionRecord</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  start</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  stop</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

The Decision log as a Component. Its programmatic API is two methods: a publish that joins the
caller's transaction, and a read of the whole log that needs neither a Token nor a route.

Every other capability is a route this component registered itself, and no route plugin is
exported. A Signal Handler therefore commits to something and builds the next Prompt out of what
is already committed to, without going near HTTP.

There is no parameter for the artifact anywhere, so no caller's bytes reach the `jws` column, and
neither method takes a User id, the log having no owner and nothing to scope by.

Publishing notifies nothing. No Signal is emitted and no Handler wakes, so a Decision published
during a Run cannot queue work for the Run that published it.

`start` and `stop` do nothing. A Decision is a committed row and an artifact somebody may already
hold, and both outlive this process.

#### Type Declaration

##### history()

```ts
history(options?): Promise<DecisionRecord[]>;
```

Reads the log, ascending by `seq`, so a Handler can see everything already committed to.

Nothing scopes it: every reader sees the same sequence, and `options` is what bounds the
answer. Asking for everything means `{ after: 0, limit: <large> }` rather than omitting the
argument, which answers the newest page instead.

A read, so it takes no transaction and cannot see the caller's own uncommitted write. `limit`
takes the routes' default when omitted and is not capped here, a cap being there to bound a
response body.

###### Parameters

###### options?

###### after?

`number`

###### before?

`number`

###### limit?

`number`

###### Returns

`Promise`\<[`DecisionRecord`](#decisionrecord)[]\>

##### publish()

```ts
publish<TSchema>(tx, statement): Promise<DecisionRecord>;
```

Publishes a Decision inside the transaction `tx` belongs to, and answers with the record.

Takes the caller's transaction rather than opening one, so committing to something and
recording why cannot come apart: a rollback loses both. Ambient enlistment is not available,
because a second handle takes its own connection and its writes would survive that rollback.

`statement` is the only other argument. The number, the timestamp and the artifact belong to
the write path, and the record comes back from here because a read cannot see the caller's own
uncommitted write.

A publish that rolls back burns its number, the sequence not being transactional. Gaps in the
log are expected and mean nothing.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.db.md#handle)\<`TSchema`\>

###### statement

`string`

###### Returns

`Promise`\<[`DecisionRecord`](#decisionrecord)\>

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

### DecisionsOptions

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> DecisionsOptions</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  agentServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">     fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">  };</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  db</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.db.html#db" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Db</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  publicServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">     fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">  };</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  signatures</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.signatures.html#signatures" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Signatures</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  users</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.users.html#users" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Users</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

#### Properties

##### agentServer

```ts
readonly agentServer: {
  fastify: FastifyInstance;
};
```

Where the agent publishes and reads, at `/decisions`.

Structural: anything carrying a Fastify instance satisfies it.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### db

```ts
readonly db: Db;
```

##### publicServer

```ts
readonly publicServer: {
  fastify: FastifyInstance;
};
```

Where any authenticated User reads the log, at `/decisions`.

A log no User can read is not public, and a commitment that is not public is not a commitment,
so there is no assembly of this component that omits it.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### signatures

```ts
readonly signatures: Signatures;
```

Where every Decision is signed, which is why this component holds no key of its own.

Build it first. Signing happens through this object in process and never as an HTTP request to
the Signatures routes, so a publish inside a transaction never leaves the process.

##### users

```ts
readonly users: Users;
```

Supplies the `requireUser` hook that the Public read runs, so this component holds no Token and
authenticates nobody.

Not a schema-level dependency, unlike the Messenger's: nothing here references a User, so a
barrel may carry this component's tables without the tables of Users.

## Variables

### decisions

```ts
const decisions: PgTableWithColumns<{
}>;
```

One Decision: a Signed Statement, numbered and kept.

Four columns, and no `user_id`. The log is global and a Decision is addressed to nobody, which is
the whole of why a commitment here is a commitment.

***

### decisionsSchema

```ts
const decisionsSchema: PgSchema<"saf_decisions">;
```

The PostgreSQL schema every table below lives in, `saf_decisions`.

Prefixed because the framework is installed into a database it does not own, and not
configurable: the table is compiled against this object, and the same object is what a
generation reads.

***

### decisionsTables

```ts
const decisionsTables: {
  decisions: PgTableWithColumns<{
  }>;
};
```

#### Type Declaration

##### decisions

```ts
decisions: PgTableWithColumns<{
}>;
```

One Decision: a Signed Statement, numbered and kept.

Four columns, and no `user_id`. The log is global and a Decision is addressed to nobody, which is
the whole of why a commitment here is a commitment.

## Functions

### createDecisions()

```ts
function createDecisions(options): Decisions;
```

Builds Decisions and registers its two route groups at `/decisions` on both servers.

Nothing here connects, listens or applies DDL.

#### Parameters

##### options

[`DecisionsOptions`](#decisionsoptions)

#### Returns

[`Decisions`](#decisions)
