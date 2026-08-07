# shared-agent-framework

The framework core, from `shared-agent-framework`.

The root carries what belongs to no component:

- `createGateway`, which builds the infrastructure every deployment needs.
- `createBareGateway`, which assembles a Gateway from a record you wrote yourself.
- `Component`, the contract every part of a Gateway satisfies.
- `openDb`, the PostgreSQL client every component queries through.
- The Agent Container, which declares how the agent's container runs.
- `templateHandler`, a Signal Handler that renders a Handlebars file.
- `CursorWindow`, the stretch of a log a paged read asks for, which two components take as
  an argument and neither of them owns.

Each opinionated component has a subpath of its own, and the root imports none of them.
A deployment loads only the components it builds.

## Example

The smallest Gateway that runs: no component of the Operator's own, and one Handler.
```ts
import { createGateway, templateHandler } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
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

### AgentContainer

```ts
type AgentContainer = {
  containerCommand?: readonly string[];
  entrypoint?: readonly string[];
  env?: Readonly<Record<string, string>>;
  extraArgs?: readonly string[];
  image: string;
  logger?: Logger;
  mounts?: MountTable;
  networks?: readonly string[];
};
```

The container one Run happens in, as an Operator declares it.

Only `image` is required. Everything else is a default, or a fact about a deployment that
most deployments do not have.

#### Properties

##### containerCommand?

```ts
readonly optional containerCommand?: readonly string[];
```

How the container runtime is invoked. Defaults to `["docker"]`, and `["podman"]` works.

##### entrypoint?

```ts
readonly optional entrypoint?: readonly string[];
```

What to run inside the image, overriding its own `ENTRYPOINT`.

The first word becomes `--entrypoint`, which takes exactly one. Anything after it goes
after the image name, ahead of what the agent's own function contributes.

##### env?

```ts
readonly optional env?: Readonly<Record<string, string>>;
```

Environment variables for the agent's container, such as a provider API key or a proxy.

Only what is named here reaches the agent. None of the Gateway's own environment does. That
is why the agent runs in a container rather than in this process. Every **value** is
hidden in the loggable copy of the command line.

##### extraArgs?

```ts
readonly optional extraArgs?: readonly string[];
```

Container flags the framework does not model, spliced last, so a flag here overrides one
the framework set.

This is the one escape hatch, and it is also how to countermand `--user`: a later `--user`
wins. It reaches the container runtime only. There is still no way to pass the agent itself an
unmodelled flag.

##### image

```ts
readonly image: string;
```

The container image. The one thing no deployment can leave out.

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to a `pino` instance on stdout.

##### mounts?

```ts
readonly optional mounts?: MountTable;
```

What the container sees on disk. Absent means nothing at all.

That is a legitimate deployment. An image that bakes in its own configuration and keeps no
state mounts nothing. The cost is silent, because no Session survives a
`--rm` container. Every Run is then a first Run, and no log line says so.

##### networks?

```ts
readonly optional networks?: readonly string[];
```

The container networks to join, one `--network` each.

Plural, because a container can join several. There is no default: the container runtime's
own is the shared bridge, and no network at all breaks every Run. The agent needs both its
model and the Agent server.

***

### AgentContainerRuntime

```ts
type AgentContainerRuntime = Runtime & {
  commandFor: (prompt) => ComposedCommand;
};
```

A Runtime, plus one pure method the seam itself does not need.

`commandFor` composes a command line without starting a container. It is the only way to
see the Runtime's own defaults applied.

#### Type Declaration

##### commandFor()

```ts
commandFor(prompt): ComposedCommand;
```

###### Parameters

###### prompt

[`RunPrompt`](shared-agent-framework.signals.md#runprompt)

###### Returns

[`ComposedCommand`](#composedcommand)

***

### AgentContainerRuntimeSpec

```ts
type AgentContainerRuntimeSpec = {
  container: AgentContainer;
  run: (prompt) => RunPlan;
};
```

What one containerised agent is: a box, and how to drive an agent inside it.

`container` is contained rather than intersected. So an Operator's declaration and an
author's behaviour stay visibly apart. A field written in the wrong half is a
type error.

#### Properties

##### container

```ts
readonly container: AgentContainer;
```

#### Methods

##### run()

```ts
run(prompt): RunPlan;
```

The whole of what an Agent Implementation adds.

One function rather than two, because `outcome` is produced per Run. It can therefore close
over what this Run is and name the Session when it fails. It is called once per Run, and
its result drives both the command line and the reader.

It is handed a `RunPrompt`, so the Session is always a string. The Signal Worker settled
the fresh-Session case before the Runtime was called.

###### Parameters

###### prompt

[`RunPrompt`](shared-agent-framework.signals.md#runprompt)

###### Returns

[`RunPlan`](#runplan)

***

### ChannelListener

```ts
type ChannelListener = {
  connected?: () => void;
  lost?: (error) => void;
  notified: (payload) => void;
};
```

What `db.listen` reports.

`notified` is the point of it. The other two are about the connection underneath, and a caller
has to care: PostgreSQL queues nothing for a listener that is not connected. Whatever was sent
while the connection was down is gone, and no gap is visible in what does arrive.

#### Methods

##### connected()?

```ts
optional connected(): void;
```

The registration is in place, on the first connection and again after every loss.

A reconnection is exactly where a notification goes missing. So a caller that cannot afford
to miss one acts here too.

###### Returns

`void`

##### lost()?

```ts
optional lost(error): void;
```

The connection was lost, or an attempt to open one failed. Another follows.

###### Parameters

###### error

`unknown`

###### Returns

`void`

##### notified()

```ts
notified(payload): void;
```

A notification arrived. `payload` is `NOTIFY`'s, empty when it carried none.

###### Parameters

###### payload

`string`

###### Returns

`void`

***

### Component

```ts
type Component = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
```

One part of a Gateway. It starts, and it stops.

Both methods are necessary. If a part has nothing to start and nothing to release, give
two methods that do nothing.

A Component has no name. Its key in the Gateway record is its name.

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

### ComposedCommand

```ts
type ComposedCommand = {
  args: readonly string[];
  command: string;
  redactedArgs: readonly string[];
  stdin: string;
};
```

One Run's command line, and what to feed it.

#### Properties

##### args

```ts
readonly args: readonly string[];
```

Its arguments: the container's flags, then the image, then the agent's own.

##### command

```ts
readonly command: string;
```

The program: the container runtime.

##### redactedArgs

```ts
readonly redactedArgs: readonly string[];
```

The same arguments with every environment **value** replaced, for a log line.

Redacted here, because this is the one place that knows which arguments are values and
which are flags. Log this rather than `args`.

##### stdin

```ts
readonly stdin: string;
```

The Prompt, or whatever else the agent's function asked to have written to stdin.

***

### CursorWindow

```ts
type CursorWindow = {
  after?: number;
  before?: number;
  limit: number;
};
```

Which stretch of a log a read asks for: one cursor, or the other, or neither, and a limit.

It carries no User id. Which log is read is settled elsewhere. A Token settles it on the
Public server, and a query parameter on the Agent server. So it is the same shape wherever
a log is paged. A component that wants its own name aliases this type, and the alias stays
internal: an alias is transparent to the compiler, so a signature written against one still
resolves to this.

Exported from `shared-agent-framework`, the one name in this module that is. `Decisions.history`
and `HttpMessenger.history` each take `Partial` of it, every field optional, so a caller that
wants the newest page passes nothing.

Both cursors at once describes two windows, and the route refuses it with `bothCursors`.

#### Properties

##### after?

```ts
readonly optional after?: number;
```

##### before?

```ts
readonly optional before?: number;
```

##### limit

```ts
readonly limit: number;
```

***

### Db

```ts
type Db = Component & {
  handle: <TSchema>(schema) => Handle<TSchema>;
  listen: (channel, listener) => Listening;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  tx: <T>(body) => Promise<T>;
};
```

The Gateway's PostgreSQL client: the pool, a schema-typed handle per component, transactions
and `LISTEN` registrations.

**No migrations.** The Operator generates and applies their own DDL. Nothing here creates a
schema or tracks what was applied.

A Component, and normally the first entry in the Gateway's record. Everything queries it, and
the drain queries it on the way down, so it starts first and stops last.

#### Type Declaration

##### handle()

```ts
handle<TSchema>(schema): Handle<TSchema>;
```

A handle over the shared pool, typed to `schema`.

The pool itself is never handed out, which keeps `pg` out of the public API.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### schema

`TSchema`

###### Returns

[`Handle`](#handle)\<`TSchema`\>

##### listen()

```ts
listen(channel, listener): Listening;
```

Registers `listen <channel>` on a connection of the Db's own, outside the pool, and reports
what arrives on it.

It cannot be a pooled connection. A `LISTEN` registration belongs to a session. A pooled
connection goes back to the pool as soon as its query resolves. This is therefore the one
place the Db keeps a connection open on a caller's behalf.

###### Parameters

###### channel

`string`

###### listener

[`ChannelListener`](#channellistener)

###### Returns

[`Listening`](#listening)

Immediately, without waiting for the connection, and it never rejects. Failures go
  to `listener.lost` and are retried with a backoff until `close`.

##### start()

```ts
start(): Promise<void>;
```

Opens the pool, and nothing else.

Eager, so a URL nothing answers on is a startup failure naming the Db. It is not a surprise
at the first query. Nothing about the schema is checked. A database behind the code surfaces
as a raw PostgreSQL error at its first query.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Closes the pool and every connection `listen` opened.

Listening connections are included because they are the Db's. One left connected keeps the
process alive and its database undroppable.

###### Returns

`Promise`\<`void`\>

##### tx()

```ts
tx<T>(body): Promise<T>;
```

Runs `body` in a transaction: commits on return, rolls back on throw.

###### Type Parameters

###### T

`T`

###### Parameters

###### body

(`tx`) => `Promise`\<`T`\>

###### Returns

`Promise`\<`T`\>

***

### Gateway

```ts
type Gateway<C> = Component & {
  components: C;
};
```

Every Component a deployment has, under the Operator's own keys.

A Gateway is itself a Component, because it has a Component's shape.

#### Type Declaration

##### components

```ts
readonly components: C;
```

The record it was given, unchanged, so a part can be reached by its own key.

#### Type Parameters

##### C

`C` *extends* `Record`\<`string`, [`Component`](#component)\>

***

### GatewayExtension

```ts
type GatewayExtension = Record<string, Component> & { [K in keyof InfraComponents]?: never };
```

What `extend` can return: Components under keys of your own, and none of the four
infrastructure keys.

The four are refused because a spread would overwrite one in silence. To run a Db, a server or
a Signal Worker of your own, call `createBareGateway` instead.

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

Everything `createGateway` needs. Four required values, and four with defaults.

#### Type Parameters

##### E

`E` *extends* [`GatewayExtension`](#gatewayextension)

#### Properties

##### agentListen

```ts
readonly agentListen: FastifyListenOptions;
```

Where the Agent server binds. Use loopback.

This server has no authentication at all, so reaching the port is read-write access to
everything on it. Where the agent's own container reaches this process is a second value.
State it in the instructions you mount into the Workspace.

##### databaseUrl

```ts
readonly databaseUrl: string;
```

Where the Db connects. The pool opens at `start`, not here.

Required, and read from no environment. Construction throws and names this option when
it is absent.

##### extend?

```ts
readonly optional extend?: (components) => E;
```

Components of your own, built from the infrastructure this call constructed.

This is where the opinionated components go: the User Manager, Signatures, Decisions, the
HTTP Messenger and the Scheduler. What it returns is keyed ahead of the Worker, so those
Components stop after the drain. That is what a Signal Handler's post phase needs.

###### Parameters

###### components

[`InfraComponents`](#infracomponents)

###### Returns

`E`

##### handlers

```ts
readonly handlers: (components) => SignalHandlers;
```

The `kind`-to-Handler map, built from the four infrastructure Components and whatever
`extend` returned.

Required, and a callback because a Signal Handler usually needs a Component. It runs
after `extend`, so a Handler can reach a component of your own. `extend` cannot see the
handlers, which is the correct direction.

###### Parameters

###### components

[`InfraComponents`](#infracomponents) & `E`

###### Returns

[`SignalHandlers`](shared-agent-framework.signals.md#signalhandlers)

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to a `pino` instance on stdout. The Signal Worker is what reads it.

##### publicListen

```ts
readonly publicListen: FastifyListenOptions;
```

Where the Public server binds. This is the surface meant to be exposed, so loopback
inside a container reaches nobody.

##### runtime

```ts
readonly runtime: Runtime;
```

Drives the Agent Implementation. `createPiRuntime` from `shared-agent-framework/pi`
returns one.

##### sweepIntervalMs?

```ts
readonly optional sweepIntervalMs?: number;
```

How often the Signal Worker sweeps for pending work, in milliseconds. Its own default.

***

### Handle

```ts
type Handle<TSchema> = PgDatabase<PgQueryResultHKT, TSchema>;
```

A Drizzle handle over the pool, or inside a transaction, typed to the schema it carries.

One type for both. A cross-component signature widens `TSchema` rather than naming one
component's schema. A transaction carries the schema of the handle it started on.

#### Type Parameters

##### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\> = `Record`\<`string`, `never`\>

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

The infrastructure every deployment has, under the keys it is filed under.

This is the record `extend` receives, and the four keys `handlers` receives beside
whatever `extend` returned.

This is not the start order. The Worker is keyed last in the Gateway's own record, so that
it drains while everything else is still live.

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

### Listening

```ts
type Listening = {
  close: () => Promise<void>;
};
```

A registration made by `db.listen`.

#### Methods

##### close()

```ts
close(): Promise<void>;
```

Stops listening and closes the connection. Idempotent, and safe to call while a
reconnection is pending.

###### Returns

`Promise`\<`void`\>

***

### ListeningServer

```ts
type ListeningServer = {
  close: () => Promise<unknown>;
  listen: (options) => Promise<unknown>;
};
```

The whole of what the framework asks of a server: somewhere to listen, and a way to close.

A Fastify instance satisfies it. That is all that is asked. It is what keeps `fastify` a
peer dependency with no runtime value imported.

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

***

### LogFields

```ts
type LogFields = Record<string, unknown>;
```

Structured context on one log line.

***

### Logger

```ts
type Logger = {
  debug: (fields, message) => void;
  error: (fields, message) => void;
  info: (fields, message) => void;
  warn: (fields, message) => void;
};
```

What every part of the Gateway accepts. Four levels and no more.

`fatal` and `trace` exist in `pino`, and nothing here has a use for them. Leaving them out
keeps a hand-written logger short.

#### Methods

##### debug()

```ts
debug(fields, message): void;
```

###### Parameters

###### fields

[`LogFields`](#logfields)

###### message

`string`

###### Returns

`void`

##### error()

```ts
error(fields, message): void;
```

###### Parameters

###### fields

[`LogFields`](#logfields)

###### message

`string`

###### Returns

`void`

##### info()

```ts
info(fields, message): void;
```

###### Parameters

###### fields

[`LogFields`](#logfields)

###### message

`string`

###### Returns

`void`

##### warn()

```ts
warn(fields, message): void;
```

###### Parameters

###### fields

[`LogFields`](#logfields)

###### message

`string`

###### Returns

`void`

***

### Mount

```ts
type Mount = {
  agentPath: string;
  gatewayPath: string;
  readOnly?: boolean;
};
```

One entry: a directory or a single file the agent's container can reach.

The declaration does not say which of the two it is. Each path is named for the actor that
resolves it: `agentPath` the agent's own container, and `gatewayPath` the Gateway process.

#### Properties

##### agentPath

```ts
readonly agentPath: string;
```

Where the agent's container resolves it: the mount point the agent sees. Absolute, and
always POSIX whatever this platform is.

##### gatewayPath

```ts
readonly gatewayPath: string;
```

Where the Gateway process resolves it, on its own side. Absolute.

##### readOnly?

```ts
readonly optional readOnly?: boolean;
```

Whether the agent can write it. Defaults to `false`.

A read-only **file** nested inside a read-write **directory** works. The container runtime
sorts bind mounts by destination depth. So the file is unwritable and unlinkable, and every
sibling operation still succeeds.

***

### MountTable

```ts
type MountTable = {
  entries: readonly Mount[];
  hostRoot?: {
     gatewayPath: string;
     hostPath: string;
  };
};
```

The whole of the agent container's filesystem.

Everything else about the container is the `AgentContainer`'s: the image, the entry point, the
networks and the environment.

#### Properties

##### entries

```ts
readonly entries: readonly Mount[];
```

What the container sees.

Declaration order is preserved and means nothing. The daemon sorts bind mounts by
destination depth. A nested entry nests under its parent, whatever order they were written
in.

An empty list is a deployment too, and is not refused. Nothing the agent writes outlives its
`--rm` container, so every Run is a first Run.

##### hostRoot?

```ts
readonly optional hostRoot?: {
  gatewayPath: string;
  hostPath: string;
};
```

How this Gateway's own filesystem maps to the host's, for a Gateway in a container.

Absent means the Gateway runs on the host, which is the common case. Every entry's
`gatewayPath` is then its own source, because the daemon resolves the same string. The two
part company only when the Gateway is itself in a container. That is one fact about the
deployment, not a property of each mount.

Present, it is exhaustive. A `gatewayPath` equal to the root resolves to `hostPath` whole,
and one below it resolves to `hostPath` plus the remainder. An entry falling **outside** the
root is refused at resolution, naming the entry and the root. `hostPath` is handed to the
daemon unread. Nothing discovers either value, so state both yourself.

###### gatewayPath

```ts
readonly gatewayPath: string;
```

Where the shared tree sits inside this Gateway's own container. Absolute.

###### hostPath

```ts
readonly hostPath: string;
```

Where the daemon finds that same tree on the host. Absolute, and handed over unread.

***

### RunPlan

```ts
type RunPlan = {
  args: readonly string[];
  stdin: string;
  outcome: (stdout) => Promise<RunOutcome>;
};
```

How to perform one Run: the agent's arguments, its stdin, and how to read what comes back.

#### Properties

##### args

```ts
readonly args: readonly string[];
```

The agent's own arguments, placed after the image name.

##### stdin

```ts
readonly stdin: string;
```

Written to the container's stdin, which is then closed.

#### Methods

##### outcome()

```ts
outcome(stdout): Promise<RunOutcome>;
```

Reads the container's stdout into an outcome.

Raw bytes rather than text, so a multi-byte character split across two chunks is the
reader's to reassemble. Report a bad stream as a failed Run rather than throwing.

###### Parameters

###### stdout

`AsyncIterable`\<`Uint8Array`\<`ArrayBufferLike`\>\>

###### Returns

`Promise`\<[`RunOutcome`](shared-agent-framework.signals.md#runoutcome)\>

***

### TemplateHandlerOptions

```ts
type TemplateHandlerOptions<TPayload> = {
  data: (signal) => unknown;
  helpers?: Readonly<Record<string, Handlebars.HelperDelegate>>;
  partials?: Readonly<Record<string, string>>;
  session: (signal) => string | null | Promise<string | null>;
  template: string | URL;
};
```

What `templateHandler` needs. Every dependency is named here rather than in a context.

#### Type Parameters

##### TPayload

`TPayload` = `unknown`

#### Properties

##### data

```ts
readonly data: (signal) => unknown;
```

The values the template substitutes. A referenced value this does not supply fails the
Signal rather than rendering empty.

A returned Promise is awaited, so this can be `async`. That is where a Handler queries
what the Prompt needs: the Message log, the Workspace, or your own tables.

###### Parameters

###### signal

[`Signal`](shared-agent-framework.signals.md#signal)\<`TPayload`\>

###### Returns

`unknown`

##### helpers?

```ts
readonly optional helpers?: Readonly<Record<string, Handlebars.HelperDelegate>>;
```

Handlebars helpers, registered on this Handler's own environment and invisible to every
other one. Their output is substituted unescaped, like everything else.

##### partials?

```ts
readonly optional partials?: Readonly<Record<string, string>>;
```

Handlebars partials, as template source rather than as compiled templates.

This Handler compiles them with the same options as the template itself, so `noEscape`
and `strict` hold inside them too.

##### session

```ts
readonly session: (signal) => string | null | Promise<string | null>;
```

Which Session this Signal's Prompt continues, or `null` for a fresh one.

The topology is yours to choose: one Session per User, one per Run, or one for the whole
agent.

###### Parameters

###### signal

[`Signal`](shared-agent-framework.signals.md#signal)\<`TPayload`\>

###### Returns

`string` \| `null` \| `Promise`\<`string` \| `null`\>

##### template

```ts
readonly template: string | URL;
```

The Handlebars file, as a path or a `file:` URL. Re-read for every Prompt.

A relative path resolves against the process's working directory. For a template beside
the module that names it, write `new URL("./prompt.hbs", import.meta.url)`.

***

### Transaction

```ts
type Transaction = PgTransaction<PgQueryResultHKT, Record<string, never>, ExtractTablesWithRelations<Record<string, never>>>;
```

What `db.tx` hands its callback: a `Handle`, plus `rollback()`.

`rollback()` throws `TransactionRollbackError` rather than returning, so code using it as
control flow has to catch and filter.

## Functions

### createAgentContainerRuntime()

```ts
function createAgentContainerRuntime(spec): AgentContainerRuntime;
```

Builds a Runtime that runs the agent as one fresh container per Run.

Construction composes a command line once, for its throwing alone. So a deployment that
cannot work is refused where the Operator wrote it. That matters, because a failed Run is
never retried.

#### Parameters

##### spec

[`AgentContainerRuntimeSpec`](#agentcontainerruntimespec)

The container to run, and the one function that drives the agent inside it.

#### Returns

[`AgentContainerRuntime`](#agentcontainerruntime)

#### Throws

If the image is empty, or if the Mount Table cannot mean what it says.

#### Example

```ts
import { createAgentContainerRuntime } from "shared-agent-framework";

const runtime = createAgentContainerRuntime({
  container: {
    image: "my-agent:1",
    networks: ["saf_agent"],
    env: { MY_API_KEY: process.env.MY_API_KEY ?? "" },
    mounts: { entries: [{ agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" }] },
  },
  run: (prompt) => ({
    args: ["--session", prompt.session],
    stdin: prompt.text,
    outcome: async () => ({ ok: true }),
  }),
});
```

***

### createBareGateway()

```ts
function createBareGateway<C>(components): Gateway<C>;
```

Assembles a Gateway from a record of Components. Start order is key order.

`start` starts each Component in turn. If one throws, it stops what had already started
and rethrows, so a failed boot leaves nothing running. `stop` stops every Component in
reverse, even if one throws, and a second call finds nothing to do.

Two things are not guarded. An integer-like key such as `"2"` sorts ahead of every word
in any JavaScript object, so it starts first. A symbol key is never started at all,
because `Object.entries` does not see one.

#### Type Parameters

##### C

`C` *extends* `Record`\<`string`, [`Component`](#component)\>

#### Parameters

##### components

`C`

The parts to run, in the order they must start.

#### Returns

[`Gateway`](#gateway)\<`C`\>

#### Example

```ts
import { createBareGateway, openDb, serverComponent } from "shared-agent-framework";
import Fastify from "fastify";

const db = openDb(process.env.DATABASE_URL ?? "");
const gateway = createBareGateway({
  db,
  publicServer: serverComponent(Fastify(), { host: "0.0.0.0", port: 8080 }),
});

await gateway.start();
```

***

### createGateway()

```ts
function createGateway<E>(options): Gateway<never>;
```

Builds the infrastructure, runs `extend` and `handlers`, and answers with a Gateway.

Nothing here connects, listens or applies DDL. Construction only registers routes on the
two servers. Your database already carries your own schema before you call `gateway.start()`.

Register your own routes with `fastify.register`, not straight onto the instance. A route
written directly on the instance is served and absent from the OpenAPI document.

#### Type Parameters

##### E

`E` *extends* [`GatewayExtension`](#gatewayextension) = `Record`\<`string`, `never`\>

#### Parameters

##### options

[`GatewayOptions`](#gatewayoptions)\<`E`\>

Where the Db connects, where each server binds, the Runtime, and the two
  callbacks that build the rest.

#### Returns

[`Gateway`](#gateway)\<`never`\>

A Gateway whose `components` holds the four infrastructure keys and everything
  `extend` returned.

#### Throws

If `databaseUrl` is absent.

#### Example

```ts
import { createGateway, templateHandler } from "shared-agent-framework";
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
  handlers: ({ users }) => ({
    "note.written": templateHandler({
      template: new URL("./prompts/note-written.hbs", import.meta.url),
      session: () => "notes",
      data: async (signal) => ({ payload: signal.payload, users: await users.list() }),
    }),
  }),
});

await gateway.start();
```

***

### defaultLogger()

```ts
function defaultLogger(): Logger;
```

The logger a part uses when the Operator supplies none: JSON lines on stdout at `info`.

#### Returns

[`Logger`](#logger-2)

A `pino` instance, typed as `Logger`, so `pino`'s own types stay out of the
  public API.

#### Example

```ts
import { defaultLogger, type Logger } from "shared-agent-framework";

const log: Logger = defaultLogger();
log.info({ signalId: "abc" }, "Signal claimed");
```

***

### mountArguments()

```ts
function mountArguments(table): readonly string[];
```

Turns a Mount Table into its `--mount` arguments, or refuses it.

Pure and total. It applies `hostRoot`, and it refuses:

- a relative path on either side;
- a `.` or `..` segment in any path it resolves;
- an entry falling outside the root;
- two entries naming one target.

It performs no I/O, so it cannot tell you whether any path exists. That is the daemon's
answer at the first Run.

`createAgentContainerRuntime` calls it during construction, so a table that cannot work is
refused where the Operator wrote it.

#### Parameters

##### table

[`MountTable`](#mounttable)

#### Returns

readonly `string`[]

One `--mount` and its value per entry, in declaration order, and nothing else.

#### Throws

On any of the four refusals above.

#### Example

```ts
import { mountArguments } from "shared-agent-framework";

const args = mountArguments({
  entries: [
    { agentPath: "/workspace", gatewayPath: "/srv/saf/workspace" },
    { agentPath: "/workspace/AGENTS.md", gatewayPath: "/srv/saf/AGENTS.md", readOnly: true },
  ],
  hostRoot: { gatewayPath: "/srv/saf", hostPath: "/var/lib/saf" },
});
// ["--mount", "type=bind,source=/var/lib/saf/workspace,target=/workspace", …]
```

***

### openDb()

```ts
function openDb(url): Db;
```

Opens the Db on a PostgreSQL connection URL.

Synchronous, and it connects lazily: the pool opens its first connection when something is
asked of it. That is what lets every component be constructed before anything is on the wire.
`start` then opens the pool itself, rather than leaving a bad URL to whichever query came
first.

#### Parameters

##### url

`string`

A PostgreSQL connection URL, such as `postgres://user:pass@host:5432/db`.

#### Returns

[`Db`](#db)

#### Example

```ts
import { openDb } from "shared-agent-framework";
import { users } from "shared-agent-framework/users";

const db = openDb(process.env.DATABASE_URL ?? "");
await db.start();

const handle = db.handle({ users });
const rows = await handle.select().from(users).limit(10);

await db.stop();
```

***

### serverComponent()

```ts
function serverComponent<S>(server, listen): Component & {
  fastify: S;
};
```

Gives a server a place in the Gateway's start order.

It constructs nothing and defaults nothing. Call `Fastify()` with your own options, pass
the instance here, and state where it listens. The instance comes back on `.fastify`, so
your own routes go on the same server the framework's do.

#### Type Parameters

##### S

`S` *extends* [`ListeningServer`](#listeningserver)

#### Parameters

##### server

`S`

Anything with `listen` and `close`. A Fastify instance of any type
  parameters, including `withTypeProvider` and http2.

##### listen

`FastifyListenOptions`

Where to bind. There is no default address.

#### Returns

[`Component`](#component) & \{
  `fastify`: `S`;
\}

#### Example

```ts
import { serverComponent } from "shared-agent-framework";
import Fastify from "fastify";

const publicServer = serverComponent(Fastify({ trustProxy: true }), {
  host: "0.0.0.0",
  port: 8080,
});

publicServer.fastify.register(async (instance) => {
  instance.get("/health", async () => ({ ok: true }));
});
```

***

### templateHandler()

```ts
function templateHandler<TPayload>(options): SignalHandler<TPayload>;
```

Builds a Signal Handler that renders one Prompt per Signal from a Handlebars template.

One Prompt, always. This Handler does not fan out to several Sessions, and it does not
decline a Signal. The contract allows both. To add a post phase, wrap it:
`{ ...templateHandler(options), post }` is a valid Handler.

#### Type Parameters

##### TPayload

`TPayload` = `unknown`

#### Parameters

##### options

[`TemplateHandlerOptions`](#templatehandleroptions)\<`TPayload`\>

The template, the Session to continue, and the values to substitute.

#### Returns

[`SignalHandler`](shared-agent-framework.signals.md#signalhandler)\<`TPayload`\>

#### Example

```ts
import { templateHandler } from "shared-agent-framework";

const handler = templateHandler<{ userId: string; body: string }>({
  template: new URL("./prompts/message-received.hbs", import.meta.url),
  session: (signal) => `user_${signal.payload.userId}`,
  data: (signal) => signal.payload,
  helpers: { upper: (value: string) => value.toUpperCase() },
});
```
