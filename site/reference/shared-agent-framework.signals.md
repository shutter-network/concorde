# shared-agent-framework/signals

The Signal Worker, from `shared-agent-framework/signals`.

The Worker is the queue, the Signal Handler dispatch and the Run execution. It runs one
Run at a time, whatever Session that Run is in. `createGateway` builds one for you, so
reach for `createSignalWorker` only when you assemble a Gateway by hand.

This subpath also carries the vocabulary a Signal Handler is written in: `Signal`,
`SignalHandler`, `Prompt` and `Runtime`. Its two tables are here as well, for the schema
an Operator generates.

## Example

A Signal Handler, and a Producer that emits into it.
```ts
import type { Db } from "shared-agent-framework";
import type { Signal, SignalHandler, SignalWorker } from "shared-agent-framework/signals";

const greet: SignalHandler<{ name: string }> = {
  handle: (signal: Signal<{ name: string }>) => [
    { session: `user_${signal.payload.name}`, text: `Say hello to ${signal.payload.name}.` },
  ],
};

// A Producer emits in its own transaction, so the row and the wakeup commit together.
async function greetSomebody(db: Db, worker: SignalWorker, name: string): Promise<string> {
  return db.tx((tx) => worker.emit(tx, { kind: "greet", payload: { name } }));
}
```

## Type Aliases

### EmittedSignal

```ts
type EmittedSignal = object;
```

What a Producer hands to `worker.emit`.

#### Properties

##### kind

```ts
readonly kind: string;
```

Selects exactly one Signal Handler. A `kind` with no Handler fails the Signal.

##### payload

```ts
readonly payload: unknown;
```

Arbitrary JSON, taken as fact.

The Signal Worker believes whatever a Producer writes here, including any claim about who the
Signal came from. That is why Producers are parts of the Gateway rather than peers outside it.

***

### PostOutcome

```ts
type PostOutcome = object;
```

What the post phase is told. `failed` is true if any Run from the Signal failed.

#### Properties

##### failed

```ts
readonly failed: boolean;
```

***

### Prompt

```ts
type Prompt = object;
```

What a Handler produces, and the only form in which anything reaches the agent.

`session` names the Session this Prompt continues, and `null` requests a fresh one. A Session
is the agent's own conversation state, kept by the Agent Implementation and continued by
naming it again. That is what makes one Prompt remember an earlier one.

The framework holds no opinion about the names. Any string reaches the Runtime unchanged, and
a name the Agent Implementation will not accept fails that Prompt's Run alone.

#### Properties

##### session

```ts
readonly session: string | null;
```

##### text

```ts
readonly text: string;
```

***

### RunOutcome

```ts
type RunOutcome = 
  | {
  ok: true;
}
  | {
  error: string;
  ok: false;
};
```

How a Run ended.

It carries none of the agent's output. Nothing in the framework reads what the agent said. The
Agent Implementation persists its own Session files. The agent writes anything it wants
recorded through the Agent server or the Workspace.

A failure carries a message, because that message is the Run's `error` column.

***

### RunPrompt

```ts
type RunPrompt = Omit<Prompt, "session"> & object;
```

The Prompt as a Runtime receives it: the Prompt a Handler wrote, with its Session **resolved**.

Two types rather than one nullable type. The `null` a Handler can write is a request for a
fresh Session, not a value. The Signal Worker answers it, and names that Session
after the Run it belongs to. So a Runtime never has a fresh-Session case to handle.

#### Type Declaration

##### session

```ts
readonly session: string;
```

The Session this Run happens in. Always a name, never a request for one.

***

### RunRecord

```ts
type RunRecord = object;
```

A Run as the agent reads it.

`signalId` is the Signal whose Handler produced this Prompt. `session` is a plain name rather
than a reference to anything, and every Run the Worker records now has one.

`session` stays nullable here, because rows written before the Worker always named one still
hold `null`. The timings are ISO 8601 strings, or `null` for a Run that has not reached that
point.

#### Properties

##### endedAt

```ts
readonly endedAt: string | null;
```

##### error

```ts
readonly error: string | null;
```

##### id

```ts
readonly id: string;
```

##### prompt

```ts
readonly prompt: string;
```

##### session

```ts
readonly session: string | null;
```

##### signalId

```ts
readonly signalId: string;
```

##### startedAt

```ts
readonly startedAt: string | null;
```

##### state

```ts
readonly state: RunState;
```

***

### RunState

```ts
type RunState = typeof runStates[number];
```

How a Run ended, or that it has not. One of `runStates`.

***

### Runtime

```ts
type Runtime = object;
```

Starts one Run and reports how it ended.

A Runtime that throws instead of returning a failure becomes a failed Run carrying the thrown
message. Neither form can take the Signal Worker down.

There is no timeout and no cancellation, on this call or anywhere else. A Run that never
returns halts the Gateway.

#### Methods

##### run()

```ts
run(prompt): Promise<RunOutcome>;
```

###### Parameters

###### prompt

[`RunPrompt`](#runprompt)

###### Returns

`Promise`\<[`RunOutcome`](#runoutcome)\>

***

### Signal

```ts
type Signal<TPayload> = object;
```

What a Handler is given.

The Signal's `state` and `error` are absent. A Handler runs because the Signal is
`processing`, and the outcome is the framework's to record.

#### Type Parameters

##### TPayload

`TPayload` = `unknown`

What this Handler expects in the payload. A Producer's payload shape is
  that Producer's contract, so the Signal Worker carries it as `unknown`.

#### Properties

##### emittedAt

```ts
readonly emittedAt: Date;
```

##### id

```ts
readonly id: string;
```

##### kind

```ts
readonly kind: string;
```

##### payload

```ts
readonly payload: TPayload;
```

***

### SignalHandler

```ts
type SignalHandler<TPayload> = object;
```

A Signal Handler: `handle`, and optionally `post`.

`handle` returns zero, one, or many Prompts. Declining, answering, and fanning out are the
same mechanism, and an empty array is not a special case.

`post` runs once, after every Run arising from the Signal has finished. It runs whether they
succeeded, failed, or were never created. It cannot produce Prompts. It is the place for
cleanup and notification, and the whole of the framework's failure handling.

#### Type Parameters

##### TPayload

`TPayload` = `unknown`

#### Methods

##### handle()

```ts
handle(signal): 
  | readonly Prompt[]
| Promise<readonly Prompt[]>;
```

###### Parameters

###### signal

[`Signal`](#signal)\<`TPayload`\>

###### Returns

  \| readonly [`Prompt`](#prompt)[]
  \| `Promise`\<readonly [`Prompt`](#prompt)[]\>

##### post()?

```ts
optional post(signal, outcome): void | Promise<void>;
```

###### Parameters

###### signal

[`Signal`](#signal)\<`TPayload`\>

###### outcome

[`PostOutcome`](#postoutcome)

###### Returns

`void` \| `Promise`\<`void`\>

***

### SignalHandlers

```ts
type SignalHandlers = Readonly<Record<string, SignalHandler>>;
```

The `kind`-to-Handler map: what a Gateway can act on, and the whole of it.

A Signal whose `kind` is absent from the map fails permanently.

***

### SignalRecord

```ts
type SignalRecord = object;
```

A Signal as the agent reads it, and the JSON one route answers with.

The `payload` reaches the agent as the Producer wrote it. `emittedAt` is an ISO 8601 string,
because JSON has no date.

`state` and `error` are included. A Signal's outcome is most of what there is to know about a
prior arrival. A failed Signal is failed permanently, so the reason has to be readable.

#### Properties

##### emittedAt

```ts
readonly emittedAt: string;
```

##### error

```ts
readonly error: string | null;
```

##### id

```ts
readonly id: string;
```

##### kind

```ts
readonly kind: string;
```

##### payload

```ts
readonly payload: unknown;
```

##### state

```ts
readonly state: SignalState;
```

***

### SignalState

```ts
type SignalState = typeof signalStates[number];
```

How far a Signal got. One of `signalStates`.

***

### SignalWorker

```ts
type SignalWorker = Component & object;
```

The one Signal Worker a Gateway runs: a queue to emit into, and a Component to start and stop.

#### Type Declaration

##### agentRoutes

```ts
readonly agentRoutes: FastifyPluginAsync;
```

The Signal Worker's Agent server routes, as a Fastify plugin you can register yourself.

Register it under a prefix of your own, or inside your own encapsulated plugin. A hook you
share with your own routes works too. Passing no server and never registering this is how
the group is switched off.

The routes read the Signal Worker's tables and no other component's. The whole surface is
read-only and unscoped: every Signal and every Run, whatever Session the reading Run is in.

##### emit()

```ts
emit<TSchema>(tx, signal): Promise<string>;
```

Records a Signal as `pending` and returns its id.

It takes the caller's transaction rather than finding one. A Producer therefore cannot
record something and tell the agent about it separately. The Messenger writes the inbound
Message and emits in one transaction, and a rollback loses both.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

The caller's own handle or transaction. The schema is widened rather than named,
  because the transaction carries the schema of the handle it started on.

###### signal

[`EmittedSignal`](#emittedsignal)

###### Returns

`Promise`\<`string`\>

The new Signal's id.

##### start()

```ts
start(): Promise<void>;
```

Starts looking for Signals, with the Handlers this Worker was constructed with.

It resolves immediately. The first thing the worker then does is fail whatever a previous
worker left `processing`. Nothing an Operator does next depends on that finishing. A Signal
emitted meanwhile is a row in a queue, drained once recovery is done.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Stops looking for Signals and waits for the one in flight to finish.

Not a shutdown protocol. Ordering is the Operator's, and the framework ships no signal
handling. There is no cancellation. A Run in flight runs to completion, because abandoning
it would leave partial effects nothing retries.

###### Returns

`Promise`\<`void`\>

***

### SignalWorkerOptions

```ts
type SignalWorkerOptions = object;
```

Everything `createSignalWorker` needs. Three required values, and three with defaults.

#### Properties

##### agentServer?

```ts
readonly optional agentServer?: object;
```

The Agent server, if the agent is to read prior Signals and Runs.

Given one, the constructor registers `agentRoutes` on its Fastify instance at no prefix:
`/signals`, `/signals/:id`, `/runs`, `/runs/:id`. Omit it and nothing is registered anywhere,
which is how the group is switched off.

Structural, and it asks for nothing but the Fastify instance. What `serverComponent` returns
satisfies it. A server built on http2 does not, and takes the `agentRoutes` plugin instead.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### db

```ts
readonly db: Db;
```

##### handlers

```ts
readonly handlers: SignalHandlers;
```

The `kind`-to-Handler map: what this Gateway can act on, and the whole of it.

A construction option rather than an argument to `start`. So a Signal Worker with no Handlers
is unconstructable, not merely unstartable. A Signal whose `kind` has no Handler fails
permanently.

A Handler cannot close over the Worker it runs under. A Handler that emits is a `let` in the
entry point, assigned after construction.

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to a `pino` instance on stdout.

##### runtime

```ts
readonly runtime: Runtime;
```

Drives the Agent Implementation. One Run at a time, never concurrently.

##### sweepIntervalMs?

```ts
readonly optional sweepIntervalMs?: number;
```

How often the worker looks for pending Signals regardless of notifications, in milliseconds.

Not the latency of a Signal: emitting one wakes the worker immediately. This is the safety net
for a notification sent while the listening connection was down. Lower it if a Signal waiting
this long during a database restart is unacceptable. There is no correctness in the number.

## Variables

### runs

```ts
const runs: PgTableWithColumns<{
}>;
```

One Prompt executed in one Session.

`session` is a plain name and not a foreign key. Sessions live in the Agent Implementation, and
the Signal Worker stores only the name it routed to.

The Worker always writes it, a fresh Session included: it names that one `run_<the Run's id>`.
The column stays nullable all the same, because rows written before the Worker did that still
hold `null`.

***

### runStates

```ts
const runStates: readonly ["pending", "running", "done", "failed"];
```

A Run's state. There is no `timed_out`, because there are no timeouts of any kind.

***

### signals

```ts
const signals: PgTableWithColumns<{
}>;
```

An arrival record, written by a Producer. Immutable but for `state` and `error`.

There is no `user_id`. The Signal Worker authenticates nobody, so attribution is not a fact it
holds. It travels in the payload, which the Worker takes as fact, because only a trusted
Producer can write one.

***

### signalStates

```ts
const signalStates: readonly ["pending", "processing", "done", "failed"];
```

A Signal's processing state. One-way: nothing returns to `pending`, and a failed Signal is
never re-run.

***

### workerSchema

```ts
const workerSchema: PgSchema<"saf_signals">;
```

The Signal Worker's schema, named for its subject rather than for the component.

Prefixed because the framework is installed into a database it does not own. An unprefixed
`signals` is a plausible name for a schema an Operator already has. The name is not theirs to
change. The tables below are compiled against it, and their generation reads these same objects.

***

### workerTables

```ts
const workerTables: object;
```

Everything the Signal Worker keeps, as `db.handle` wants it.

One object, so the worker and its Agent server routes ask for the same handle by the same name.

#### Type Declaration

##### runs

```ts
runs: PgTableWithColumns<{
}>;
```

One Prompt executed in one Session.

`session` is a plain name and not a foreign key. Sessions live in the Agent Implementation, and
the Signal Worker stores only the name it routed to.

The Worker always writes it, a fresh Session included: it names that one `run_<the Run's id>`.
The column stays nullable all the same, because rows written before the Worker did that still
hold `null`.

##### signals

```ts
signals: PgTableWithColumns<{
}>;
```

An arrival record, written by a Producer. Immutable but for `state` and `error`.

There is no `user_id`. The Signal Worker authenticates nobody, so attribution is not a fact it
holds. It travels in the payload, which the Worker takes as fact, because only a trusted
Producer can write one.

## Functions

### createSignalWorker()

```ts
function createSignalWorker(options): SignalWorker;
```

Builds a Signal Worker over a Db, a Runtime and a map of Signal Handlers.

`createGateway` builds one for you and keys it last, so it drains first. Call this yourself only
when you assemble a Gateway with `createBareGateway`.

#### Parameters

##### options

[`SignalWorkerOptions`](#signalworkeroptions)

The Db, the Runtime, the Handler map, and optionally the Agent server the read
  routes go on.

#### Returns

[`SignalWorker`](#signalworker)

#### Example

```ts
import { openDb } from "shared-agent-framework";
import { createSignalWorker } from "shared-agent-framework/signals";
import { createPiRuntime } from "shared-agent-framework/pi";

const db = openDb(process.env.DATABASE_URL ?? "");
const worker = createSignalWorker({
  db,
  runtime: createPiRuntime({ image: "my-agent:1" }),
  handlers: {
    "note.written": { handle: (signal) => [{ session: "notes", text: String(signal.payload) }] },
  },
});

await db.start();
await worker.start();
```
