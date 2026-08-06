# shared-agent-framework/decisions

Decisions, from `shared-agent-framework/decisions`.

`createDecisions` is the whole of it for an Operator. Hand it the Db, Signatures, the User
Manager and both servers. It registers its two route groups at `/decisions` on both. Then key it
in the Gateway's record before the Signal Worker, so that it stops after the drain.

Construct it after Signatures, which it holds. A Decision that was not signed is not a Decision.
It answers with two methods no request can express. `publish` commits to a Statement from inside
the caller's transaction, and `history` reads the whole log. Neither takes a User id, because
this log has no owner.

`DecisionRecord` is the shape every surface answers with, and `jws` is the field that matters:
the artifact is the Decision. This subpath also carries the one table. The log references nobody,
so a barrel carrying it alone generates cleanly.

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
type DecisionRecord = object;
```

A Decision as every surface answers with it: the POST response and both reads.

One shape and not a projection per surface. It is the whole row, four columns. `createdAt` is an
ISO 8601 string, because JSON has no date, and it is the string the artifact's payload carries.

The JWS is the Decision, and the other three fields are the log's convenience. Anybody holding
the public key can read all three back out of `jws`. That is what makes handing one artifact
onward the point of the whole Component.

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
type Decisions = Component & object;
```

What the constructor answers with: the two things trusted code needs and no request can express.

Every other capability is a route this Component registered itself, and no route plugin is
exported. So a Signal Handler and an Operator's entry point get two things. One is a publish that
joins a transaction of their own. The other is a read of the whole log, needing neither a Token
nor a route. A Handler can therefore commit to something and then build the next Prompt from what
is already committed to.

No method writes a Decision without signing it, and neither takes a User id. There is no
parameter for the artifact anywhere, so no caller's bytes reach the `jws` column. And there is
nothing to scope either method by, because the log has no owner.

#### Type Declaration

##### history()

```ts
history(options?): Promise<DecisionRecord[]>;
```

The Decision log, ascending by `seq`, so a Handler can read everything already committed to.

Nothing scopes it: the log is global, and every reader sees the same sequence. The window is
what bounds an answer. A Handler wanting everything asks with `after: 0` and a large `limit`,
rather than by omitting an argument.

A read, so it takes no transaction and cannot see the caller's own uncommitted write. It
answers from the same query both routes answer from, with the same cursor options. `limit`
defaults to the routes' default and is not capped here, because a cap bounds a response body.

###### Parameters

###### options?

`Partial`\<`CursorWindow`\>

The shared window, every field optional.

###### Returns

`Promise`\<[`DecisionRecord`](#decisionrecord)[]\>

##### publish()

```ts
publish<TSchema>(tx, statement): Promise<DecisionRecord>;
```

Publishes a Decision from inside the caller's transaction, and answers with the record.

Takes the caller's transaction rather than finding one, so committing to something and
recording why cannot come apart. A rollback loses both. Ambient enlistment is not available: a
second handle takes its own connection and its writes survive the rollback.

The Statement is the only other argument. The number, the timestamp and the artifact are the
write path's. They are produced in that order, because the signature binds the first two. A
read cannot see the caller's own uncommitted write, so the record comes back here instead.

A publish that rolls back burns its number, since the sequence is not transactional. That is
expected and means nothing.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

The caller's transaction, carrying whatever schema it was started on.

###### statement

`string`

The string being committed to.

###### Returns

`Promise`\<[`DecisionRecord`](#decisionrecord)\>

The Decision, including the number it drew and the artifact signed over it.

##### start()

```ts
start(): Promise<void>;
```

Does nothing. There is nothing here to start.

Nothing is notified when a Decision is published. There is no connection to open and no ticker
to set going. Users poll the log, and the largest `seq` they hold is the whole resume
mechanism.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Does nothing, and there is nothing here a shutdown could lose.

A Decision is a committed row and an artifact somebody may already hold. Both outlive this
process, and the artifact outlives the deployment.

###### Returns

`Promise`\<`void`\>

***

### DecisionsOptions

```ts
type DecisionsOptions = object;
```

Everything `createDecisions` needs: the Db, two Components, and both servers.

#### Properties

##### agentServer

```ts
readonly agentServer: object;
```

The Agent server, where the agent publishes and reads, at `/decisions`.

Required: Decisions the agent cannot publish into holds nothing. Structural, and asks for
nothing but the Fastify instance, so what satisfies it is what `serverComponent` returns.

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
readonly publicServer: object;
```

The Public server, where any authenticated User reads the log, at `/decisions`.

Required, and for a sharper reason. A log no User can read is not public, and a commitment that
is not public is not a commitment.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### signatures

```ts
readonly signatures: Signatures;
```

The Component that holds the signing identity, and the reason this one has no key.

Required, and construct it before this one. A Decision that was not signed is not a Decision.
So there is no degraded mode in which rows arrive without artifacts. Signing happens through
this object in process, never as an HTTP request.

##### users

```ts
readonly users: Users;
```

The User Manager whose Users may read the log.

Required, and it is where the Public read's authentication comes from. `requireUser` is taken
off this object and put on the route as one option. So this Component holds no Token, and it
answers the Manager's single 401.

Unlike the HTTP Messenger's, this is not a schema-level dependency. Nothing here references a
User, so a barrel may carry this schema without the User Manager's.

## Variables

### decisions

```ts
const decisions: PgTableWithColumns<{
}>;
```

One Decision: a Signed Statement, numbered and kept.

Four columns, and no `user_id`. The log is global and a Decision is addressed to nobody. That is
the whole of why a commitment here is a commitment.

***

### decisionsSchema

```ts
const decisionsSchema: PgSchema<"saf_decisions">;
```

Decisions' schema, named for its subject rather than for the Component.

Prefixed because the framework is installed into a database it does not own. The name is not
theirs to change: the table below is compiled against it, and their generation reads this object.

***

### decisionsTables

```ts
const decisionsTables: object;
```

Everything Decisions keeps, as `db.handle` wants it.

One object, so every module of this Component asks for the same handle by the same name.

#### Type Declaration

##### decisions

```ts
decisions: PgTableWithColumns<{
}>;
```

One Decision: a Signed Statement, numbered and kept.

Four columns, and no `user_id`. The log is global and a Decision is addressed to nobody. That is
the whole of why a commitment here is a commitment.

## Functions

### createDecisions()

```ts
function createDecisions(options): Decisions;
```

Builds Decisions and registers its two route groups at `/decisions` on both servers.

Nothing here connects, listens or applies DDL. Put the result in the Gateway's record under a key
of your own, ahead of the Signal Worker.

#### Parameters

##### options

[`DecisionsOptions`](#decisionsoptions)

#### Returns

[`Decisions`](#decisions)

#### Example

Built in `extend`, and then used from the Operator's own trusted code.
```ts
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGateway } from "shared-agent-framework";
import { createDecisions } from "shared-agent-framework/decisions";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createSignatures } from "shared-agent-framework/signatures";
import { createUsers } from "shared-agent-framework/users";

const signingKey = createPrivateKey(readFileSync("./signing-key.pem"));

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer }) => {
    const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
    const signatures = createSignatures({ signingKey, agentServer, publicServer, users });
    return {
      users,
      signatures,
      decisions: createDecisions({ db, signatures, users, agentServer, publicServer }),
    };
  },
  handlers: () => ({}),
});

await gateway.start();

// One transaction holds the Decision and the Operator's own record of why.
const { db, decisions } = gateway.components;
const published = await db.tx((tx) => decisions.publish(tx, "shipping on Friday"));

// And the whole log, for the next Prompt.
const log = await decisions.history({ after: 0, limit: 100 });
console.log(published.seq, log.length);
```
