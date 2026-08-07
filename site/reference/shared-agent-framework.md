# shared-agent-framework

The framework core, and the two words the rest of this reference is written in. A **Shared Agent**
is an AI agent that acts for several parties at once and is controlled by none of them alone. The
**Operator** is whoever runs one: they hold its configuration, write its Signal Handlers, and are
trusted by every party.

[createGateway](#creategateway) is where a deployment starts. It builds the four things every deployment
has, hands them to an `extend` callback where the components you want are constructed by hand,
and answers with a [Gateway](#gateway). A Gateway is a record of [Component](#component)s under your own
keys, started in key order and stopped in the reverse of it, and a Component itself.
[createBareGateway](#createbaregateway) takes such a record directly, for a deployment that needs a different
infrastructure shape than the one `createGateway` builds.

What is left here belongs to no one component. [openDb](#opendb) is the PostgreSQL client every
component queries through. [createAgentContainerRuntime](#createagentcontainerruntime) runs an agent as one fresh
container per Run, taking an [AgentContainer](#agentcontainer) and a [MountTable](#mounttable) that know nothing
about which agent program it is. [templateHandler](#templatehandler) is a Signal Handler that renders a
Handlebars file, [defaultLogger](#defaultlogger) is what a part logs through when you supply nothing, and
[CursorWindow](#cursorwindow) is the stretch of a log a paged read asks for, which two components take and
neither owns.

Every other component has a subpath of its own, and nothing here imports one, so a deployment
loads only what it constructs.

## Example

The smallest Gateway that runs: nothing of the Operator's own beyond one Signal Handler.
```ts
import { createGateway, templateHandler } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";

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

The container one Run happens in, as an Operator declares it. Inert: it creates nothing, checks
no path and starts nothing.

Everything but `image` is a default worth overriding, or a fact about a deployment that most
deployments do not have.

The container is always run with `--rm`, with stdin open and no TTY, and as this process's own
uid and gid. None of the three is configurable: a TTY makes an agent decide it is being used
interactively, and a container running as root leaves files in a bind mount that a Signal
Handler can read and delete but cannot change.

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

What to run inside the image, in place of its own `ENTRYPOINT`.

The first word becomes `--entrypoint`, which takes exactly one. Anything after it is the
container's command and lands after the image name, ahead of what the agent's own function
contributes.

##### env?

```ts
readonly optional env?: Readonly<Record<string, string>>;
```

Environment variables for the agent's container, such as a provider API key or a proxy.

Only what is named here reaches the agent, and none of the Gateway's own environment does,
which is most of why the agent runs in a container at all. Every **value** is hidden in the
loggable copy of the command line, with no exception for a name that looks harmless.

##### extraArgs?

```ts
readonly optional extraArgs?: readonly string[];
```

Container flags the framework does not model, spliced in last so that one here overrides one
the framework set.

The one escape hatch, and how to countermand `--user`, a later `--user` winning. It reaches
the container runtime only: there is still no way to pass the agent itself an unmodelled flag.

##### image

```ts
readonly image: string;
```

The container image, handed to the container runtime as written, so a tag or a digest pins what
runs.

##### logger?

```ts
readonly optional logger?: Logger;
```

Where this Runtime logs its two `debug` lines per Run, the composed command line and how the
container ended. Defaults to a `pino` instance on stdout, which drops both.

##### mounts?

```ts
readonly optional mounts?: MountTable;
```

What the container can reach on disk. Absent means nothing at all.

That is a real deployment: an image that bakes in its own configuration and keeps no state
mounts nothing. What it costs is silent, because nothing written survives the container. Every
Run is then a first Run, whatever Session it names, and no log line says so.

##### networks?

```ts
readonly optional networks?: readonly string[];
```

The container networks to join, one `--network` each.

Plural, a container being able to join several. There is no default and no good one: the
container runtime's own is the shared bridge, and no network at all breaks every Run, the
agent needing both its model and the Agent server.

***

### AgentContainerRuntime

```ts
type AgentContainerRuntime = Runtime & {
  commandFor: (prompt) => ComposedCommand;
};
```

A Runtime, plus one pure method the seam itself has no use for.

`commandFor` composes the command line for a Prompt without starting anything, which is the only
way to see this Runtime's own defaults applied to a declaration.

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

What one containerised agent is: the box an Operator declares, and the one function that drives
an agent inside it.

The two are separate fields rather than one flat object, so a field written in the wrong half is
a type error rather than a container flag nothing reads.

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

The whole of what an Agent Implementation adds. Called once per Run, and its result drives both
the command line and the reading of stdout.

One function and not two, because `outcome` comes out of it per Run and can therefore close
over which Run this is and name the Session when it fails.

`prompt.session` is always a string here. A Signal Handler may ask for a fresh Session, and
the Signal Worker has already settled that and named it before anything reaches this.

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

What `listen` reports.

`notified` is the point of it. The other two are about the connection underneath, and a caller
has to care: PostgreSQL queues nothing for a listener that is not connected. Whatever was sent
while the connection was down is gone, and no gap is visible in what does arrive.

#### Methods

##### connected()?

```ts
optional connected(): void;
```

The registration is in place: once on the first connection, and again after every loss.

A reconnection is exactly where a notification goes missing, so a caller that cannot afford to
miss one does its own catching-up from here.

###### Returns

`void`

##### lost()?

```ts
optional lost(error): void;
```

The connection was lost, or an attempt to open one failed. Another attempt follows.

###### Parameters

###### error

`unknown`

###### Returns

`void`

##### notified()

```ts
notified(payload): void;
```

A notification arrived. `payload` is `NOTIFY`'s, and is empty when it carried none.

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

The same arguments with every environment **value** replaced. Log this and never `args`.

Redacted here because this is the one place that knows which argument is a value and which is
a flag. A variable set to nothing stays visibly empty, there being nothing in it to hide.

##### stdin

```ts
readonly stdin: string;
```

The Prompt, or whatever else the agent's own function asked to have written to stdin.

***

### CursorWindow

```ts
type CursorWindow = {
  after?: number;
  before?: number;
  limit: number;
};
```

Which stretch of a log a read asks for: one cursor, the other, or neither, and a limit.

No cursor at all answers the newest page, which is what a client opening a log wants. `before`
answers the newest page strictly below that `seq`, which is scrolling back, and `after` walks
forwards from it, which is polling. `after: 0` reads a log from its beginning, nothing being
numbered 0. All three answer ascending by `seq`, so pages concatenate without anything being
reversed.

Both cursors together describe two windows rather than one. An HTTP route given both answers
400; a `history` method given both refuses nothing and reads between them.

It carries no User id. Which log is read is settled elsewhere, by the Token on the Public server
and by a query parameter on the Agent server, so one shape serves wherever a log is paged. The
two `history` methods take `Partial` of it, every field optional, so a caller wanting the newest
page passes nothing at all.

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

The one PostgreSQL client in a Gateway: the pool, a schema-typed handle per component,
transactions, and `LISTEN` registrations.

**No migrations, and no DDL of any kind.** Nothing here creates a schema, applies a change or
tracks what was applied. The Operator re-exports the components they run into one barrel and
pushes it with their own `drizzle-kit` before the Gateway starts.

#### Type Declaration

##### handle()

```ts
handle<TSchema>(schema): Handle<TSchema>;
```

A handle over the shared pool, typed to `schema` and to nothing else.

The pool is never handed out, so `pg` reaches nothing in a deployment's own code. Call this
once per component with that component's tables.

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
what arrives on it. This is the one place the Db holds a connection open on a caller's behalf.

It answers before that connection exists and never rejects, so a component registers in its
own constructor. A failure to connect reaches `lost` and is retried with a growing backoff
until `close`, which means a registration that has never once succeeded looks the same from
here as a healthy one.

###### Parameters

###### channel

`string`

###### listener

[`ChannelListener`](#channellistener)

###### Returns

[`Listening`](#listening)

##### start()

```ts
start(): Promise<void>;
```

Opens the pool, and nothing else.

Eager, so a URL nothing answers on fails here, named as the Db, rather than at whichever query
came first. Nothing about the schema is looked at: a database behind the code starts cleanly
and raises a raw PostgreSQL error at its first query.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Closes the pool and every connection `listen` opened.

The listening connections are included because they are the Db's own. One left connected keeps
the process alive and its database undroppable.

###### Returns

`Promise`\<`void`\>

##### tx()

```ts
tx<T>(body): Promise<T>;
```

Runs `body` in a transaction: commits when it returns, rolls back when it throws.

Only writes made through the handle `body` is given are in it. A component's own handle takes
its own connection, so a write through one inside `body` commits on its own and survives the
rollback. That is why a method meant to join a caller's transaction takes the handle as an
argument instead of finding one.

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
`createAgentContainerRuntime` builds one for any other agent program.

##### sweepIntervalMs?

```ts
readonly optional sweepIntervalMs?: number;
```

How often the Signal Worker looks for Signals left pending, in milliseconds, in place of the
Worker's own interval.

It is the backstop and not the normal path, an emitted Signal waking the Worker as it is
written, so this is how long a Signal can wait when a wake-up went missing.

***

### Handle

```ts
type Handle<TSchema> = PgDatabase<PgQueryResultHKT, TSchema>;
```

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

### Listening

```ts
type Listening = {
  close: () => Promise<void>;
};
```

#### Methods

##### close()

```ts
close(): Promise<void>;
```

Stops listening and closes the connection. Idempotent, and safe to call while a reconnection is
pending.

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

What every part of a Gateway logs through. Four levels, and any object carrying them satisfies
it, so a deployment that logs elsewhere passes its own object instead of adapting one.

`fatal` and `trace` are `pino`'s and are left out. Nothing here has a use for either, and their
absence is what keeps a hand-written logger four methods long.

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

Nothing here says which of the two it is, and nothing needs to. Each path is named for the actor
that resolves it: `agentPath` for the agent's own container, `gatewayPath` for the Gateway
process.

#### Properties

##### agentPath

```ts
readonly agentPath: string;
```

The mount point the agent sees. Absolute, and POSIX whatever platform this is.

Two entries naming one `agentPath` are refused, a trailing slash making no difference.

##### gatewayPath

```ts
readonly gatewayPath: string;
```

Where the Gateway process resolves the same thing, on its own side. Absolute.

##### readOnly?

```ts
readonly optional readOnly?: boolean;
```

Whether the agent can write it. Defaults to `false`.

A read-only **file** nested inside a read-write **directory** works, the container runtime
sorting bind mounts by destination depth: the file is unwritable and unlinkable while every
operation on its siblings still succeeds. That is how a file the agent must not change becomes
one it cannot.

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

The whole of what the agent's container can reach on disk.

Everything else about the container belongs to the `AgentContainer` that carries this: the image,
the entry point, the networks and the environment.

#### Properties

##### entries

```ts
readonly entries: readonly Mount[];
```

The entries, in whatever order suits the reader.

Declaration order is preserved in the arguments and means nothing to the outcome. The daemon
sorts bind mounts by destination depth, so a nested entry nests under its parent however the
two were written.

An empty list is a deployment too and is not refused. Nothing the agent writes then outlives
the container, so every Run is a first Run.

##### hostRoot?

```ts
readonly optional hostRoot?: {
  gatewayPath: string;
  hostPath: string;
};
```

How this Gateway's own filesystem maps to the host's, for a Gateway that is itself in a
container.

Absent means the Gateway runs on the host, which is the common case: every entry's
`gatewayPath` is then its own bind source, the daemon resolving the same string this process
does. The two part company only for a containerised Gateway, and that is one fact about the
deployment rather than a property of each mount, which is why it is stated once here.

Present, it is exhaustive. A `gatewayPath` equal to the root resolves to `hostPath` whole, one
below it resolves to `hostPath` with the remainder appended, and one falling **outside** the
root is refused, naming the entry and the root. Nothing discovers either value, so state both
yourself. A shared tree spanning more than one host mount cannot be expressed through one
pair: write daemon-namespace paths into each `gatewayPath` and declare no root at all, at the
price of paths this process cannot itself list.

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

Reads the container's stdout into an outcome, and decides whether the Run succeeded.

Raw bytes rather than text, so a multi-byte character split across two chunks is this
function's to reassemble. Report a bad stream as a failed Run rather than throwing: a throw
kills the container and propagates, where a failure is recorded against the Run with the exit
status and stderr appended to the message.

The stream is what decides. A reader that answers success is believed even if the container
then exits non-zero, which is logged as the contradiction it is.

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

#### Type Parameters

##### TPayload

`TPayload` = `unknown`

#### Properties

##### data

```ts
readonly data: (signal) => unknown;
```

The values the template substitutes. A name the template references and this does not supply
fails the Signal rather than rendering as nothing.

A returned Promise is awaited, so this can be `async`, and it is where a Handler reads what the
Prompt needs: the Message log, the Workspace, or tables of your own.

###### Parameters

###### signal

[`Signal`](shared-agent-framework.signals.md#signal)\<`TPayload`\>

###### Returns

`unknown`

##### helpers?

```ts
readonly optional helpers?: Readonly<Record<string, Handlebars.HelperDelegate>>;
```

Handlebars helpers, registered on an environment belonging to this Handler alone. Another
Handler built by another call cannot see them, and neither can the shared `Handlebars`
instance. What a helper returns is substituted unescaped, like everything else.

##### partials?

```ts
readonly optional partials?: Readonly<Record<string, string>>;
```

Handlebars partials, as template source rather than as templates already compiled.

They are compiled here with the same options as the template itself, so `noEscape` and `strict`
hold inside them too.

##### session

```ts
readonly session: (signal) => string | null | Promise<string | null>;
```

Which Session this Signal's Prompt continues, or `null` to ask for a fresh one.

The topology is yours: one Session per User, one per Run, or one for the whole agent. A
returned Promise is awaited.

###### Parameters

###### signal

[`Signal`](shared-agent-framework.signals.md#signal)\<`TPayload`\>

###### Returns

`string` \| `null` \| `Promise`\<`string` \| `null`\>

##### template

```ts
readonly template: string | URL;
```

The Handlebars file, as a path or a `file:` URL, read and compiled again for every Prompt.
Edit the wording and the next Signal renders through it, with no restart.

A relative path resolves against the process's working directory. For a template beside the
module that names it, write `new URL("./prompt.hbs", import.meta.url)`.

It is compiled with `noEscape`, so nothing substituted is HTML-escaped, and with `strict`,
which fails the Signal on a variable `data` did not supply. `strict` also disables inverse
sections: a caret block such as `^absent` throws, and the `unless` helper is what to write in
its place. The `if`, `each` and `else` helpers behave as usual.

***

### Transaction

```ts
type Transaction = PgTransaction<PgQueryResultHKT, Record<string, never>, ExtractTablesWithRelations<Record<string, never>>>;
```

What `tx` hands its callback: a [Handle](#handle), plus `rollback()`.

`rollback()` throws `TransactionRollbackError` rather than returning, so code that uses it as
control flow has to catch and then filter for it.

## Functions

### createAgentContainerRuntime()

```ts
function createAgentContainerRuntime(spec): AgentContainerRuntime;
```

Builds a Runtime that runs the agent as one fresh container per Run, discarding the container
afterwards.

A command line is composed once here and thrown away, so that a declaration which cannot work is
refused where the Operator wrote it. That is worth a startup failure because the alternative is
a Run that fails at the first Signal and is never retried.

#### Parameters

##### spec

[`AgentContainerRuntimeSpec`](#agentcontainerruntimespec)

#### Returns

[`AgentContainerRuntime`](#agentcontainerruntime)

#### Throws

If the image is empty, or if the Mount Table cannot mean what it says.

***

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

### defaultLogger()

```ts
function defaultLogger(): Logger;
```

What a part logs through when the Operator supplies nothing: `pino`, writing JSON lines to stdout
at `info`.

Typed as [Logger](#logger-2) and not as a `pino` logger, so nothing in a deployment's own code ends up
holding `pino`'s types. Everything below `info` is dropped, and `debug` is where the parts write
what they are doing, so a deployment that wants those lines configures `pino` itself and passes
the result.

#### Returns

[`Logger`](#logger-2)

***

### mountArguments()

```ts
function mountArguments(table): readonly string[];
```

Turns a Mount Table into one `--mount` and its value per entry, in declaration order, or refuses
the table.

Pure and total. It applies `hostRoot`, and it refuses a relative path on either side, a `.` or
`..` segment in any path it resolves, an entry falling outside the root, and two entries naming
one target.

It performs no I/O, so it cannot say whether any of these paths exists. That answer comes from
the daemon at the first Run, as a Run that failed and will not be retried, which is why
`createAgentContainerRuntime` calls this at construction: the refusals it can make, it makes
where the Operator wrote the table.

#### Parameters

##### table

[`MountTable`](#mounttable)

#### Returns

readonly `string`[]

#### Throws

On any of those four.

***

### openDb()

```ts
function openDb(url): Db;
```

Opens the Db on a PostgreSQL connection URL, such as `postgres://user:pass@host:5432/db`.

Synchronous, and nothing is on the wire yet: the pool opens its first connection when something
is asked of it, which is what lets every component be constructed before the database has to be
there. `start` is what opens the pool deliberately.

#### Parameters

##### url

`string`

#### Returns

[`Db`](#db)

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

***

### templateHandler()

```ts
function templateHandler<TPayload>(options): SignalHandler<TPayload>;
```

Builds a Signal Handler that renders one Prompt per Signal from a Handlebars template.

One Prompt, always. It never fans a Signal out across several Sessions and never declines one,
although the Handler contract allows both. It has no post phase either, and gains one by being
spread: `{ ...templateHandler(options), post }` is a Handler.

A template that cannot be read, and one that does not render, each fail the Signal with a message
naming the file. Handlebars names the variable, the line and the column, and never the file,
which is the one thing an Operator running several templates needs.

#### Type Parameters

##### TPayload

`TPayload` = `unknown`

#### Parameters

##### options

[`TemplateHandlerOptions`](#templatehandleroptions)\<`TPayload`\>

#### Returns

[`SignalHandler`](shared-agent-framework.signals.md#signalhandler)\<`TPayload`\>
