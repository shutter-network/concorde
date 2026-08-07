# shared-agent-framework/users

The User Manager, the component that holds the identities a Gateway authenticates. A User is an
opaque Gateway-issued id, a set of Attributes the Operator writes, and a set of Tokens. There is
no email and no username anywhere, so the id is the only handle a User has. Attributes are
arbitrary JSON that nothing in the framework interprets, and they are where a deployment's
grouping and therefore its authorization live.

[createUsers](#createusers) makes one. [Users](#users) is what comes back, and it carries the methods and
the `requireUser` hook that the rest of a deployment reaches for. [UserRecord](#userrecord) is what
every surface here answers with.

Other components take that hook rather than authenticating anybody themselves, so build this one
before them. Two of them also point a foreign key at the `users` table, so an Operator's barrel
that carries the Messenger's tables or the Nostr Channel's without this subpath's generates a
constraint onto a table it never creates.

The subpath also exports the `users` and `tokens` tables, for the barrel an Operator's
`drizzle-kit` reads, and importing it declares `request.safUser` on every `FastifyRequest` in
the program, whether or not the program builds this component.

## Example

A Gateway with Users, and a User admitted from the Operator's own code.
```ts
import { createGateway } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createUsers } from "shared-agent-framework/users";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  // Not loopback: the agent reaches this server from a container of its own.
  agentListen: { host: "0.0.0.0", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer }) => ({
    users: createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer }),
  }),
  handlers: () => ({}),
});

await gateway.start();

// One transaction, so a User with no password never reaches the table.
const { db, users } = gateway.components;
const admitted = await db.tx(async (tx) => {
  const user = await users.create(tx);
  await users.setPassword(tx, user.id, "correct horse battery staple");
  return user;
});
console.log(`admitted ${admitted.id}, and that id is what they log in with`);
```

## Type Aliases

### IssuedToken

```ts
type IssuedToken = {
  expiresAt: string;
  token: string;
  user: UserRecord;
};
```

What a login answers with: the Token, when it expires, and the User it belongs to.

The User is embedded rather than referenced, so a client needs no second request to know who it
is.

#### Properties

##### expiresAt

```ts
readonly expiresAt: string;
```

When it stops working, ISO 8601, from the lifetime this Gateway was built with.

##### token

```ts
readonly token: string;
```

The Token, in the only response that will ever carry it.

##### user

```ts
readonly user: UserRecord;
```

The User it belongs to, Attributes and all.

***

### ScryptParameters

```ts
type ScryptParameters = {
  blockSize: number;
  logN: number;
  parallelism: number;
};
```

What a scrypt derivation costs, as the Operator states it and as each digest records it.

`logN` rather than `N`, because the parameter must be a power of two and every published
recommendation is written that way. The other two are scrypt's own `r` and `p`, spelled out.

#### Properties

##### blockSize

```ts
readonly blockSize: number;
```

scrypt's `r`. With `logN` it decides how much memory the derivation needs.

##### logN

```ts
readonly logN: number;
```

log₂ of the CPU/memory cost. Memory is `128 · 2^logN · blockSize` bytes.

##### parallelism

```ts
readonly parallelism: number;
```

scrypt's `p`. Node runs the passes serially, so this multiplies the time.

***

### UserRecord

```ts
type UserRecord = {
  attributes: unknown;
  createdAt: string;
  id: string;
};
```

A User as every surface answers with one: both reads, the created record, and a login.

`attributes` is arbitrary JSON that nothing in the Gateway interprets, and `createdAt` is ISO
8601, JSON having no date. Whether a User has a password is answered nowhere, on this shape or
on any other.

#### Properties

##### attributes

```ts
readonly attributes: unknown;
```

##### createdAt

```ts
readonly createdAt: string;
```

##### id

```ts
readonly id: string;
```

***

### Users

```ts
type Users = Component & {
  agentRoutes: FastifyPluginAsync;
  publicRoutes: FastifyPluginAsync;
  requireUser: preHandlerAsyncHookHandler;
  create: <TSchema>(tx) => Promise<UserRecord>;
  get: (id) => Promise<UserRecord | undefined>;
  issueToken: <TSchema>(tx, user) => Promise<IssuedToken>;
  list: (options?) => Promise<UserRecord[]>;
  revoke: <TSchema>(tx, user) => Promise<void>;
  setAttributes: <TSchema>(tx, user, attributes) => Promise<void>;
  setPassword: <TSchema>(tx, user, password) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
```

The User Manager as a Component: two route plugins, one hook, and the methods no route has.

It keeps a User's Attributes and a scrypt digest of their password, and one row per issued
Token. A Token's plaintext exists once, in the response that issued it, so nothing here answers
with one afterwards. Nothing removes a User either: `revoke` is the closest thing to shutting
one out.

Setting Attributes, replacing a password and issuing a Token are methods rather than routes.
Trusted code holds this object, and the Agent server is the surface an injected prompt reaches,
so the three capabilities that escalate are not there to reach.

Every write takes the caller's transaction as its first argument and every read takes none, so a
read cannot see the caller's own uncommitted write. That is why `create` and `issueToken` answer
with what they wrote.

Nothing is notified when a User is created, logs in or is revoked. No Signal is emitted and no
Handler wakes, so a deployment that wants one emits it itself inside the same transaction.

`start` and `stop` do nothing. A Token outlives a shutdown, being a row and the database's own
clock, and nothing reaps an expired one.

#### Type Declaration

##### agentRoutes

```ts
readonly agentRoutes: FastifyPluginAsync;
```

The Agent server routes as a Fastify plugin: create a User, read Users.

For an Operator who wants them somewhere other than where `agentServer` puts them. The plugin
carries no prefix of its own, so register it under a prefix of yours, inside your own
encapsulated plugin, or behind your own hook.

Passing no Agent server and never registering this is how the capability is switched off.

##### publicRoutes

```ts
readonly publicRoutes: FastifyPluginAsync;
```

The Public server routes as a Fastify plugin: the login, and the four routes around it.

The same prefix story `agentRoutes` carries. `/auth` is what the constructor uses, and
`POST /auth/tokens` is where the login goes.

Registering neither this plugin nor a Public server is how a deployment replaces this login
with its own. That scheme mints ordinary Tokens through `issueToken`, and there is no
interface to implement.

##### requireUser

```ts
readonly requireUser: preHandlerAsyncHookHandler;
```

The preHandler that requires a Token, as one option on any route.

`publicServer.post("/ask", { preHandler: users.requireUser }, handler)`. It reads the
`Authorization: Bearer …` header, then assigns the User to `request.safUser` or answers the
single 401 that every authentication failure gets.

A hook rather than a plugin, so it works on either server, inside any plugin, at any depth.
Nothing is protected by default, and a route that does not take it reads `request.safUser` as
`undefined` despite the type.

##### create()

```ts
create<TSchema>(tx): Promise<UserRecord>;
```

Creates a User with no Attributes and no password, and answers with the record.

Takes the caller's transaction, so admitting a User and writing the Operator's own rows cannot
come apart: a rollback loses both. The record comes back from here because a read cannot see
that uncommitted write.

It accepts no id. A User has no natural key, so "create this User if absent" is not
expressible and seeding the first one is the Operator's own job, out of band and once.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### Returns

`Promise`\<[`UserRecord`](#userrecord)\>

##### get()

```ts
get(id): Promise<UserRecord | undefined>;
```

One User by id, or `undefined`.

A read, so it takes no transaction and cannot see the caller's own uncommitted write. `create`
answers with the User for that reason.

###### Parameters

###### id

`string`

###### Returns

`Promise`\<[`UserRecord`](#userrecord) \| `undefined`\>

##### issueToken()

```ts
issueToken<TSchema>(tx, user): Promise<IssuedToken>;
```

Issues a Token to a User who presented nothing, and answers what a login answers.

This is how a deployment adds a login of its own. Write a route on the Public server,
establish identity however you like, and call this. What comes back is an ordinary Token, and
nothing downstream can tell how it was obtained.

The User needs no password, and their Token is not a lesser Token. It reads on the caller's
transaction, so one transaction can create a User and hand them a Token. It throws when no
User has that id.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### user

`string`

###### Returns

`Promise`\<[`IssuedToken`](#issuedtoken)\>

##### list()

```ts
list(options?): Promise<UserRecord[]>;
```

Users, newest first, limited.

A read, with the same consequence `get` carries. `limit` takes the routes' default when
omitted and is not capped here: a cap is there to bound a response body the agent reads, and
this is not that.

###### Parameters

###### options?

###### limit?

`number`

###### Returns

`Promise`\<[`UserRecord`](#userrecord)[]\>

##### revoke()

```ts
revoke<TSchema>(tx, user): Promise<void>;
```

Revokes every Token of one User, so that none of them works again.

What `DELETE /auth/tokens` does, reachable without HTTP. Nothing removes a User, so this is
the closest thing to shutting one out, and it is not close: they keep their password, which
mints a new Token, so replace that too.

Idempotent, and it answers nothing, not even a count. The rows are deleted rather than marked,
which is the only compaction that table gets.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### user

`string`

###### Returns

`Promise`\<`void`\>

##### setAttributes()

```ts
setAttributes<TSchema>(
   tx, 
   user, 
attributes): Promise<void>;
```

Replaces a User's Attributes, wholesale, and throws when no User has that id.

This is where authorization lives, and the agent cannot reach it: `POST /users` has no
parameter for an attribute, so an injected prompt cannot mint a privileged User.

Wholesale rather than a merge, because a merge cannot express removal. A merge is one line on
top of this: read, spread, set.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### user

`string`

###### attributes

`unknown`

###### Returns

`Promise`\<`void`\>

##### setPassword()

```ts
setPassword<TSchema>(
   tx, 
   user, 
password): Promise<void>;
```

Replaces a User's password, proving nothing: the whole of account recovery here.

An Operator sets a new password from their own code, having established out of band that it is
right. It also gives a password to a User who had none. `PUT /auth/password` is the
self-service route, and that one wants the current password.

It revokes nothing, so to lock somebody out, replace the password and then call `revoke`, in
that order. There is no bound on the length here: the empty string stores like any other and
leaves a User who cannot log in. It throws when no User has that id.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### user

`string`

###### password

`string`

###### Returns

`Promise`\<`void`\>

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

### UsersOptions

```ts
type UsersOptions = {
  agentServer?: {
     fastify: FastifyInstance;
  };
  db: Db;
  publicServer?: {
     fastify: FastifyInstance;
  };
  scrypt?: ScryptParameters;
  tokenTtl: number;
};
```

#### Properties

##### agentServer?

```ts
readonly optional agentServer?: {
  fastify: FastifyInstance;
};
```

The Agent server, if the agent is to create and read Users.

Given one, the constructor registers `agentRoutes` on it under `/users`: `POST /users`,
`GET /users` and `GET /users/:id`. Omit it and nothing is registered anywhere, which is how
the agent's ability to create a User is denied. There is no flag and no route to guard.

Structural, and asks for nothing but the Fastify instance. What `serverComponent` returns
satisfies it. A server built on http2 does not, and takes `agentRoutes` instead.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### db

```ts
readonly db: Db;
```

##### publicServer?

```ts
readonly optional publicServer?: {
  fastify: FastifyInstance;
};
```

The Public server, if Users are to trade a password for a Token.

Given one, the constructor registers `publicRoutes` on it under `/auth`, which is where
`POST /auth/tokens` comes from.

Omit it to replace this password login with a scheme of your own, which can be OIDC, a wallet
signature or a corporate header. `issueToken` is a method, so that scheme still mints ordinary
Tokens and nothing else about this component changes.

Structural, on the same terms as `agentServer`.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### scrypt?

```ts
readonly optional scrypt?: ScryptParameters;
```

What a password derivation costs. Defaults to OWASP's 32 MiB row, around 200ms of one core.

Old digests do not follow it. Each digest carries the parameters it was written under and
verifies at those, so raising this leaves every stored password working and there is no rehash
on login. The cost is paid on every login, and nothing here rate limits one.

##### tokenTtl

```ts
readonly tokenTtl: number;
```

How long an issued Token lives, in milliseconds.

No default. A long lifetime means fewer logins and a longer window for a stolen Token, and
only the deployment knows which side of that trade it is on.

It is not per-Token: every Token this Gateway issues gets this lifetime, and one that never
expires is unrepresentable.

## Variables

### tokens

```ts
const tokens: PgTableWithColumns<{
}>;
```

A bearer Token: one row per login, and the only credential a request ever carries.

The plaintext exists once, in the response that issued it, so a row is verifiable and never
readable. Nothing reaps a row past its expiry. An expired Token stops matching.

***

### users

```ts
const users: PgTableWithColumns<{
}>;
```

A User: an opaque Gateway-issued id, arbitrary Attributes, and a password that may not exist.

Nothing removes a row. There is no delete, no deactivation and no column recording either, so a
reference to a User from another component's table cannot come to dangle.

***

### usersSchema

```ts
const usersSchema: PgSchema<"saf_users">;
```

The PostgreSQL schema every table below lives in, `saf_users`.

Prefixed because the framework is installed into a database it does not own, and an unprefixed
`users` is a plausible name for a schema an Operator already has. Not configurable: the tables
are compiled against this object, and the same object is what a generation reads.

***

### usersTables

```ts
const usersTables: {
  tokens: PgTableWithColumns<{
  }>;
  users: PgTableWithColumns<{
  }>;
};
```

#### Type Declaration

##### tokens

```ts
tokens: PgTableWithColumns<{
}>;
```

A bearer Token: one row per login, and the only credential a request ever carries.

The plaintext exists once, in the response that issued it, so a row is verifiable and never
readable. Nothing reaps a row past its expiry. An expired Token stops matching.

##### users

```ts
users: PgTableWithColumns<{
}>;
```

A User: an opaque Gateway-issued id, arbitrary Attributes, and a password that may not exist.

Nothing removes a row. There is no delete, no deactivation and no column recording either, so a
reference to a User from another component's table cannot come to dangle.

## Functions

### createUsers()

```ts
function createUsers(options): Users;
```

Builds the User Manager and registers its route groups on whichever servers it is given.

Nothing here connects, listens or applies DDL.

#### Parameters

##### options

[`UsersOptions`](#usersoptions)

#### Returns

[`Users`](#users)

#### Throws

If `tokenTtl` is not a positive number of milliseconds.

#### Throws

If a `scrypt` parameter is not a positive integer, or `logN` is above 20.
