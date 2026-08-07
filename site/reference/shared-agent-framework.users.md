# shared-agent-framework/users

The User Manager, from `shared-agent-framework/users`.

`createUsers` is the whole of it for an Operator. Hand it the Db, a Token lifetime and the
servers its two route groups belong on. It registers `agentRoutes` under `/users` and
`publicRoutes` under `/auth`. Then put it in the Gateway's record like every other Component.

This subpath also carries the two tables, for the schema an Operator generates. It applies no
DDL itself. Importing it types `request.safUser` on every `FastifyRequest` in your program.

## Example

A Gateway with Users, and a User admitted from the Operator's own code.
```ts
import { createGateway } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";
import { createUsers } from "shared-agent-framework/users";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, agentServer, publicServer }) => ({
    users: createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer }),
  }),
  handlers: () => ({}),
});

await gateway.start();

// A User with a password, which a client trades for a Token at `POST /auth/tokens`.
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

A client needs no second request to know who it is.

#### Properties

##### expiresAt

```ts
readonly expiresAt: string;
```

When it stops working, ISO 8601, from the Manager's construction-time lifetime.

##### token

```ts
readonly token: string;
```

The Token, in the only response that will ever carry it.

##### user

```ts
readonly user: UserRecord;
```

The User it belongs to, including the Attributes governing their authorization.

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

`logN` rather than `N`, because the parameter must be a power of two. Every published
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

A User as the agent reads it, and the JSON these routes answer with.

`attributes` is `unknown`, because it is arbitrary JSON the Gateway never interprets. What a
Signal Handler makes of it is the Handler's business. `createdAt` is an ISO 8601 string, because
JSON has no date.

There is no field for the password. Whether a User has one is not something this surface answers.

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

#### Type Declaration

##### agentRoutes

```ts
readonly agentRoutes: FastifyPluginAsync;
```

The Agent server routes as a Fastify plugin: create a User, read Users.

For an Operator who wants them somewhere other than where `agentServer` puts them. The plugin
carries no prefix of its own. Register it under a prefix of yours, inside your own encapsulated
plugin, or behind your own hook.

Passing no server and never registering this is how the capability is switched off.

##### publicRoutes

```ts
readonly publicRoutes: FastifyPluginAsync;
```

The Public server routes as a Fastify plugin: the login, and the four routes around it.

The same prefix story `agentRoutes` carries. `/auth` is the constructor's default, and
`POST /auth/tokens` is where the login goes.

Registering neither this plugin nor a Public server is how a deployment replaces this login.
Its own scheme mints our Tokens through `issueToken`, and there is no interface to implement.

##### requireUser

```ts
readonly requireUser: preHandlerAsyncHookHandler;
```

The preHandler that requires a Token, as one option on any route.

`publicServer.post("/ask", { preHandler: users.requireUser }, handler)`. It reads the
`Authorization: Bearer …` header. It then assigns the User to `request.safUser`, or answers
the single 401 that every authentication failure gets.

A hook rather than a plugin, so it works on either server, inside any plugin, at any depth.
A route that does not take it reads `request.safUser` as `undefined`, despite the type.
Nothing is protected by default.

##### create()

```ts
create<TSchema>(tx): Promise<UserRecord>;
```

Creates a User with no Attributes and no password, and answers with the record.

Takes the caller's transaction, so admitting a User and writing the Operator's own rows
cannot come apart. A rollback loses both. The caller cannot read this write back through
`get`, which is why the record comes back here.

It accepts no id. A User has no natural key, so seeding is the Operator's own job, out of
band and once.

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

A read, so it takes no transaction and cannot see the caller's own uncommitted write.
`create` answers with the User for that reason.

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

The User needs no password, and their Token is not a lesser Token. It takes the caller's
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

A read, with the same consequence `get` carries. `limit` defaults to the route's default and
is not capped here. The cap on a route bounds a response body the agent reads, and this is
not that.

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
the closest thing to shutting one out. They keep their password, which mints a new Token, so
replace that too.

It takes the caller's transaction. It is idempotent and answers nothing, not even a count. The
rows are deleted rather than marked, which is the only compaction that table gets.

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

Replaces a User's Attributes, wholesale.

This is where authorization lives, and the agent cannot reach it. `POST /users` has no
parameter for an attribute, so an injected prompt cannot mint a privileged User.

Wholesale rather than a merge, because a merge cannot express removal. A merge is one line on
top of this: read, spread, set. A write, so it takes the caller's transaction first, and it
throws when no User has that id.

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
self-service route, and it wants the current password.

It revokes nothing. To lock somebody out, replace the password and then call `revoke`, in that
order. There is no bound on the length here. The empty string stores like any other, and leaves
a User who cannot log in.

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

Does nothing. There is nothing here to start.

The pool belongs to the Db, and the routes belong to the servers they went on. This component
is in the Gateway's record for its membership. Everything it needs was done at construction.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Does nothing, for the reason `start` does not.

A Token outlives a shutdown. What makes it valid is a row and the database's own clock, and
nothing reaps the expired rows.

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

Everything `createUsers` needs: the Db, a Token lifetime, and the servers its routes go on.

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
satisfies it. A server built on http2 does not, and takes `agentRoutes` below instead.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### db

```ts
readonly db: Db;
```

The Db this component queries through. It takes a handle to its own two tables.

##### publicServer?

```ts
readonly optional publicServer?: {
  fastify: FastifyInstance;
};
```

The Public server, if Users are to trade a password for a Token.

Given one, the constructor registers `publicRoutes` on it under `/auth`, which is where
`POST /auth/tokens` comes from.

Omit it to replace this password login with a scheme of your own. That scheme can be OIDC, a
wallet signature, or a corporate header. `issueToken` is a method, so your own route still
mints our Tokens. Nothing else about the User Manager changes.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### scrypt?

```ts
readonly optional scrypt?: ScryptParameters;
```

What a password derivation costs. Defaults to OWASP's 32 MiB row.

Old digests do not follow it. Each digest carries the parameters it was written under, and
verifies at those. So raising this leaves every stored password working, and there is no
rehash on login.

##### tokenTtl

```ts
readonly tokenTtl: number;
```

How long an issued Token lives, in milliseconds.

No default. A long lifetime means fewer logins and a longer window for a stolen Token. Only
the deployment knows which side of that trade it is on.

The lifetime is not per-Token. A Token that never expires is unrepresentable.

## Variables

### tokens

```ts
const tokens: PgTableWithColumns<{
}>;
```

A bearer Token: one row per login, and the only credential that travels on a request.

Nothing here is readable, only verifiable. The plaintext exists once, in the response that
issued it.

***

### users

```ts
const users: PgTableWithColumns<{
}>;
```

A User: an opaque Gateway-issued id, arbitrary Attributes, and a credential that may not exist.

There is no `deactivated_at` and no delete, because nothing removes a User. There is no read
position either, here or in the HTTP Messenger. A client's cursor is the largest `seq` it holds.

***

### usersSchema

```ts
const usersSchema: PgSchema<"saf_users">;
```

The User Manager's schema, named for its subject rather than for the component.

Prefixed because the framework is installed into a database it does not own. An unprefixed
`users` is a plausible name for a schema an Operator already has. The name is not theirs to
change: the tables below are compiled against it, and their generation reads these objects.

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

Everything the User Manager keeps, as `db.handle` wants it.

One object, so every module of this component asks for the same handle by the same name.

#### Type Declaration

##### tokens

```ts
tokens: PgTableWithColumns<{
}>;
```

A bearer Token: one row per login, and the only credential that travels on a request.

Nothing here is readable, only verifiable. The plaintext exists once, in the response that
issued it.

##### users

```ts
users: PgTableWithColumns<{
}>;
```

A User: an opaque Gateway-issued id, arbitrary Attributes, and a credential that may not exist.

There is no `deactivated_at` and no delete, because nothing removes a User. There is no read
position either, here or in the HTTP Messenger. A client's cursor is the largest `seq` it holds.

## Functions

### createUsers()

```ts
function createUsers(options): Users;
```

Builds the User Manager and registers its routes on the servers it is given.

Nothing here connects, listens or applies DDL. Put the result in the Gateway's record under a
key of your own.

#### Parameters

##### options

[`UsersOptions`](#usersoptions)

#### Returns

[`Users`](#users)

#### Throws

If `tokenTtl` is not a positive number of milliseconds.

#### Throws

If a `scrypt` parameter is outside its bounds.

#### Example

No Agent server, so the agent can neither create nor read Users.
```ts
import Fastify from "fastify";
import { openDb, serverComponent } from "shared-agent-framework";
import { createUsers } from "shared-agent-framework/users";

const db = openDb(process.env.DATABASE_URL ?? "");
const publicServer = serverComponent(Fastify(), { host: "0.0.0.0", port: 8080 });
const users = createUsers({ db, tokenTtl: 3_600_000, publicServer });

await db.start();

// Trusted code can still admit somebody and hand them a Token.
const issued = await db.tx(async (tx) => {
  const user = await users.create(tx);
  return users.issueToken(tx, user.id);
});
```
