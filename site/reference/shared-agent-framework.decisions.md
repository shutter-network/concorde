# shared-agent-framework/decisions

Decisions, the component that owns the one global log of Decisions. A Decision is a Statement the
Shared Agent has committed to in public: signed with its key, numbered from 1, kept forever, and
readable by every User rather than addressed to one.

[createDecisions](#createdecisions) makes one. [Decisions](#decisions) is what comes back, carrying the `publish`
and `history` that no request can express. [DecisionRecord](#decisionrecord) is what every surface answers
with, and `jws` is the field that matters: the artifact is the Decision, and the other three
fields can be read back out of it by anybody holding the public key.

Build Signatures first, which this signs through. A Decision that was not signed is not a
Decision, so there is no degraded mode where rows arrive without artifacts. Build the User
Manager first too, for the hook the Public read runs. Key it ahead of the Signal Worker in the
Gateway's record: the Worker is keyed last so it drains first, and a Signal Handler's post phase
may still publish.

Nothing is notified when a Decision is published. There is no Signal and no Handler to wake, so a
User discovers a Decision by polling, and the largest `seq` they hold is the whole resume
mechanism. The subpath also carries the one table, which references no other component's, so a
barrel carrying it without the User Manager's generates cleanly.

## Example

A Gateway with Decisions, and a Statement committed to from the Operator's own code.
```ts
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGateway } from "shared-agent-framework";
import { createDecisions } from "shared-agent-framework/decisions";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createSignatures } from "shared-agent-framework/signatures";
import { createUsers } from "shared-agent-framework/users";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
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

```ts
type Decisions = Component & {
  history: (options?) => Promise<DecisionRecord[]>;
  publish: <TSchema>(tx, statement) => Promise<DecisionRecord>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
```

The Decision log as a Component: a publish that joins the caller's transaction, and a read of the
whole log that needs neither a Token nor a route.

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

`Partial`\<[`CursorWindow`](shared-agent-framework.md#cursorwindow)\>

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

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

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

```ts
type DecisionsOptions = {
  agentServer: {
     fastify: FastifyInstance;
  };
  db: Db;
  publicServer: {
     fastify: FastifyInstance;
  };
  signatures: Signatures;
  users: Users;
};
```

#### Properties

##### agentServer

```ts
readonly agentServer: {
  fastify: FastifyInstance;
};
```

Where the agent publishes and reads, at `/decisions`.

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
barrel may carry this component's tables without the User Manager's.

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
