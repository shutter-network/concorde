# shared-agent-framework/gateway

A Gateway is the whole of a deployment as one object: a record of parts under keys of the
Operator's own, and a part itself, so two calls start and stop everything. Each entry is a
Component, which is a `start` and a `stop` and nothing more.

[createGateway](#creategateway) is where a deployment starts. It builds the four parts every deployment
has, a Db, the Agent server, the Public server and the Signal Worker, hands them to the `extend`
callback on [GatewayOptions](#gatewayoptions), and answers with a [Gateway](#gateway) holding those four beside
whatever `extend` returned. [InfraComponents](#infracomponents) names them and is what `extend` reads its
arguments from. [createBareGateway](#createbaregateway) takes a finished record instead, for a deployment whose
infrastructure has a shape of its own, and [serverComponent](#servercomponent) turns a server the Operator
built into a [Component](#component) for such a record.

Every component this package ships is constructed by hand inside `extend`, one `create*` each,
and only the ones a deployment wants. `extend` runs first and `handlers` reads its result, so a
Signal Handler closes over a component of your own and never the reverse.

Two of the four are documented on subpaths of their own: `shared-agent-framework/db` holds the
Db, and `shared-agent-framework/signals` holds the Signal Worker and the whole Signal Handler
vocabulary. The other two are plain Fastify instances, each reached on `.fastify`. This subpath
owns no tables and exports no schema, so every table a deployment needs comes from a component
it constructed in `extend`.

## Example

The smallest Gateway that runs: one Signal Handler, and nothing else of the Operator's own.
```ts
import { createGateway } from "shared-agent-framework/gateway";
import { createPiRuntime } from "shared-agent-framework/pi";
import { templateHandler } from "shared-agent-framework/signals";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  // Not loopback: the agent reaches this server from a container of its own.
  agentListen: { host: "0.0.0.0", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  handlers: () => ({
    "note.written": templateHandler({
      template: new URL("./prompts/note-written.hbs", import.meta.url),
      session: () => "notes",
      data: (signal) => signal.payload,
    }),
  }),
});

await gateway.start();
process.once("SIGTERM", () => void gateway.stop());
```

## Type Aliases

### Component

```ts
type Component = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
```

One part of a Gateway: it starts, and it stops.

A part with nothing to start and nothing to release supplies two methods that do nothing, which
is ordinary rather than an apology: the record is the Gateway's directory of its own parts, and a
part that holds no resource still belongs in it.

A Component has no name of its own. Its key in the Gateway's record is its name, and that key is
what a failed start is reported under.

#### Methods

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

### Gateway

```ts
type Gateway<C> = Component & {
  components: C;
};
```

Every Component a deployment runs, under the Operator's own keys.

It has a Component's shape and therefore is one, so `start` and `stop` on the whole deployment
are the same two calls as on any part of it.

#### Type Declaration

##### components

```ts
readonly components: C;
```

The record as it was given, so a part is reached by the key you wrote it under.

#### Type Parameters

##### C

`C` *extends* `Record`\<`string`, [`Component`](#component)\>

***

### GatewayExtension

```ts
type GatewayExtension = Record<string, Component> & { [K in keyof InfraComponents]?: never };
```

What `extend` may return: Components under keys of your own, and none of the four infrastructure
keys.

Those four are a type error rather than a substitution, because a spread would overwrite one in
silence. Call [createBareGateway](#createbaregateway) to run a Db, a server or a Signal Worker of your own.

***

### GatewayOptions

```ts
type GatewayOptions<E> = {
  agentListen: FastifyListenOptions;
  databaseUrl: string;
  extend?: (components) => E;
  handlers: (components) => SignalHandlers;
  logger?: Logger;
  publicListen: FastifyListenOptions;
  runtime: Runtime;
  sweepIntervalMs?: number;
};
```

#### Type Parameters

##### E

`E` *extends* [`GatewayExtension`](#gatewayextension)

#### Properties

##### agentListen

```ts
readonly agentListen: FastifyListenOptions;
```

Where the Agent server binds. Use loopback.

Nothing on this server authenticates anything, so reaching the port is read and write access
to every route on it. Where the agent's own container reaches this process is a second value
and is not derived from this one: state it in the instructions you mount into the Workspace.

##### databaseUrl

```ts
readonly databaseUrl: string;
```

Where the Db connects. Nothing is on the wire until `start`, so a URL that answers nowhere
fails there and not here.

No environment is read for it. Construction throws and names this option when it is absent,
which is the one refusal a JavaScript caller can reach.

##### extend?

```ts
readonly optional extend?: (components) => E;
```

Builds Components of your own out of the four this call constructed, and returns them under
keys of your own.

Every component this call does not build is constructed here, one `create*` each: Users,
Signatures, Decisions, the Messenger with the single Channel that reaches people, and the
Scheduler. A deployment that wants none of them omits this callback.

###### Parameters

###### components

[`InfraComponents`](#infracomponents)

###### Returns

`E`

##### handlers

```ts
readonly handlers: (components) => SignalHandlers;
```

Builds the `kind`-to-Handler map out of the four infrastructure Components and whatever
`extend` returned.

A callback, because a Signal Handler almost always closes over a Component. It runs after
`extend` and cannot be seen by it, so a Handler reaches a component of your own and never the
reverse.

###### Parameters

###### components

[`InfraComponents`](#infracomponents) & `E`

###### Returns

[`SignalHandlers`](shared-agent-framework.signals.md#signalhandlers)

##### logger?

```ts
readonly optional logger?: Logger;
```

Where the Signal Worker logs. Defaults to a `pino` instance on stdout.

It reaches the Worker and nothing else. A component built in `extend` takes its own.

##### publicListen

```ts
readonly publicListen: FastifyListenOptions;
```

Where the Public server binds. This is the surface meant to be exposed, so loopback inside a
container reaches nobody.

##### runtime

```ts
readonly runtime: Runtime;
```

What a Prompt is handed to, and what an outcome comes back from.

`createPiRuntime` on `shared-agent-framework/pi` returns one for `pi`, and
`createAgentContainerRuntime` on `shared-agent-framework/agent-container` builds one for any
other agent program.

##### sweepIntervalMs?

```ts
readonly optional sweepIntervalMs?: number;
```

How often the Signal Worker looks for Signals left pending, in milliseconds, in place of the
Worker's own interval.

It is the backstop and not the normal path, an emitted Signal waking the Worker as it is
written, so this is how long a Signal can wait when a wake-up went missing.

***

### InfraComponents

```ts
type InfraComponents = {
  agentServer: Component & {
     fastify: FastifyInstance;
  };
  db: Db;
  publicServer: Component & {
     fastify: FastifyInstance;
  };
  worker: SignalWorker;
};
```

The four parts every deployment has, under the keys they are filed under.

This is what `extend` is handed, and the four keys `handlers` is handed beside whatever `extend`
returned. The same four keys are on `gateway.components` afterwards.

#### Properties

##### agentServer

```ts
agentServer: Component & {
  fastify: FastifyInstance;
};
```

###### Type Declaration

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### db

```ts
db: Db;
```

##### publicServer

```ts
publicServer: Component & {
  fastify: FastifyInstance;
};
```

###### Type Declaration

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### worker

```ts
worker: SignalWorker;
```

***

### ListeningServer

```ts
type ListeningServer = {
  close: () => Promise<unknown>;
  listen: (options) => Promise<unknown>;
};
```

#### Methods

##### close()

```ts
close(): Promise<unknown>;
```

###### Returns

`Promise`\<`unknown`\>

##### listen()

```ts
listen(options): Promise<unknown>;
```

###### Parameters

###### options

`FastifyListenOptions`

###### Returns

`Promise`\<`unknown`\>

## Functions

### createBareGateway()

```ts
function createBareGateway<C>(components): Gateway<C>;
```

Assembles a Gateway from a record of Components. Start order is key order, and stop order is the
reverse of it.

A Component counts as started only once its own `start` resolves. If one throws, everything
already started is stopped and the error is rethrown, so a failed boot leaves nothing running.
`stop` stops every Component even when one of them throws, gathers the failures into an
`AggregateError`, and finds nothing left to do on a second call.

Two properties of a JavaScript record are not guarded against. An integer-like key such as `"2"`
sorts ahead of every word, so a Component under one starts first. A symbol key is never started
at all.

#### Type Parameters

##### C

`C` *extends* `Record`\<`string`, [`Component`](#component)\>

#### Parameters

##### components

`C`

#### Returns

[`Gateway`](#gateway)\<`C`\>

***

### createGateway()

```ts
function createGateway<E>(options): Gateway<never>;
```

Builds the Db, both self-describing servers and the Signal Worker, runs `extend` and then
`handlers`, and answers with a Gateway holding those four under `db`, `agentServer`,
`publicServer` and `worker`, beside whatever `extend` returned.

Nothing connects, listens or applies DDL. Construction registers routes and returns, so the
database has to be carrying your own tables by the time you call `gateway.start()`.

Register routes of your own with `fastify.register` rather than writing them onto the instance.
A route written straight onto it is served, and absent from the OpenAPI document.

#### Type Parameters

##### E

`E` *extends* [`GatewayExtension`](#gatewayextension) = `Record`\<`string`, `never`\>

#### Parameters

##### options

[`GatewayOptions`](#gatewayoptions)\<`E`\>

#### Returns

[`Gateway`](#gateway)\<`never`\>

#### Throws

If `databaseUrl` is absent.

***

### serverComponent()

```ts
function serverComponent<S>(server, listen): Component & {
  fastify: S;
};
```

Wraps a server as a Component: `start` binds it, and `stop` closes it.

It constructs nothing and defaults nothing, so call `Fastify()` with whatever options you want
and state where the instance binds. There is no default address. What comes back carries that
instance on `.fastify` with its own type parameters intact, `withTypeProvider` and http2
included, so routes of your own go on the same server the framework's components registered
theirs on.

#### Type Parameters

##### S

`S` *extends* [`ListeningServer`](#listeningserver)

#### Parameters

##### server

`S`

##### listen

`FastifyListenOptions`

#### Returns

[`Component`](#component) & \{
  `fastify`: `S`;
\}
