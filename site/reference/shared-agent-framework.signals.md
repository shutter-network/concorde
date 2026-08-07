# shared-agent-framework/signals

The Signal Worker, the Component that owns the Signal queue, Signal Handler dispatch and Run
execution. A Signal is something that arrived and may make the agent act, emitted by a Producer,
which is anything inside the Gateway trusted to write one. A Run is one execution of the agent
over one Prompt. The Worker takes Signals in the order they arrived and runs one Run at a time,
whatever Session that Run is in.

Most deployments meet this subpath as a vocabulary rather than as a constructor.
[SignalHandler](#signalhandler) is what an Operator writes, and it is the framework's primary extension
point in the way an endpoint handler is a web framework's: it takes a [Signal](#signal) and answers
with [Prompt](#prompt)s, and [SignalHandlers](#signalhandlers) is the map from a `kind` to one of them.
[Runtime](#runtime) is the other seam, the single method an Agent Implementation is driven through.
[createSignalWorker](#createsignalworker) builds the Worker itself, and [SignalWorker](#signalworker) is what comes back,
carrying the `emit` a Producer writes through.

`createGateway` builds a Worker already and keys it last, so it drains while every other
Component is still live, which is when a Handler's post phase sends its failure notice. Build one
yourself only when you assemble a Gateway by hand. Either way the Handler map is a construction
option, so a Handler that emits back into the same Worker is built after it and assigned in.

None of this is on the package root. The Worker, its options and the whole Handler vocabulary are
reachable through `shared-agent-framework/signals` and nowhere else. The two tables are here too,
for the barrel an Operator generates their DDL from; they reference no other component's, so a
barrel may carry them alone.

## Example

A Signal Handler, and a Producer that emits into it.
```ts
import type { Db } from "shared-agent-framework";
import type { Signal, SignalHandler, SignalWorker } from "shared-agent-framework/signals";

const greet: SignalHandler<{ name: string }> = {
  handle: (signal: Signal<{ name: string }>) => [
    { session: `user_${signal.payload.name}`, text: `Say hello to ${signal.payload.name}.` },
  ],
  // Runs once the Run above has finished, however it finished.
  post: (signal, outcome) => {
    if (outcome.failed) console.error(`nobody greeted ${signal.id}`);
  },
};

// A Producer emits inside its own transaction, so the row and the wakeup commit together.
async function greetSomebody(db: Db, worker: SignalWorker, name: string): Promise<string> {
  return db.tx((tx) => worker.emit(tx, { kind: "greet", payload: { name } }));
}
```

## Type Aliases

### EmittedSignal

```ts
type EmittedSignal = {
  kind: string;
  payload: unknown;
};
```

What a Producer hands to [SignalWorker](#signalworker)'s `emit`.

#### Properties

##### kind

```ts
readonly kind: string;
```

Selects exactly one Signal Handler, and is the whole of what dispatch looks at.

One `kind` never reaches two Handlers. Fanning out is one Handler answering with several
Prompts, so there is no second mechanism for it here.

##### payload

```ts
readonly payload: unknown;
```

Arbitrary JSON, taken as fact and never interpreted.

The Signal Worker believes whatever a Producer writes, including any claim about who the Signal
came from. That is why a Producer is a part of the Gateway rather than a peer outside it, and
why attribution is a term in a Producer's payload contract rather than a column here.

***

### PostOutcome

```ts
type PostOutcome = {
  failed: boolean;
};
```

What the post phase is told about the Signal it is closing out.

`failed` is true if any Run failed, and true as well if `handle` threw before there were any, so
it says the Signal came to nothing rather than that the agent ran and came back unhappy.

#### Properties

##### failed

```ts
readonly failed: boolean;
```

***

### Prompt

```ts
type Prompt = {
  session: string | null;
  text: string;
};
```

What a Handler produces from a Signal, and the only form in which anything reaches the agent.

`session` names the Session this Prompt continues, and `null` asks for a fresh one. A Session is
the agent's own conversational state, kept by the Agent Implementation and continued by being
named again, so it is what makes one Prompt remember an earlier one. It organises context and
does not partition it: the agent reads every Signal, Run and Message over the Agent server
whatever Session it is in.

The framework fixes no session topology and validates no name. One shared Session, one per User,
one per Run and any mixture of those are written here and nowhere else. Any string reaches the
Runtime as it was written, and a name the Agent Implementation refuses fails that one Prompt's
Run, carrying that program's own message, while the Prompts beside it still run.

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

How a Run ended, and the whole of what a Runtime reports.

It carries none of the agent's output. Nothing in the framework reads what the agent said: the
Agent Implementation keeps its own Session files, and the agent records anything it wants kept
through the Agent server or the Workspace.

A failure carries a message because that message is what [RunRecord](#runrecord)'s `error` holds and
what every later read of the Run answers with. Nothing parses it, so it is written for a person.

***

### RunPrompt

```ts
type RunPrompt = Omit<Prompt, "session"> & {
  session: string;
};
```

The Prompt as a Runtime receives it: what a Handler wrote, with the Session resolved.

Two types rather than one nullable one. The `null` a Handler may write is a request for a fresh
Session rather than a value, and the Signal Worker answers it before any Runtime is called,
naming that Session after the Run it belongs to. So there is no fresh-Session case to handle
here, no naming convention for a Runtime to invent, and every Run records the name it really ran
under.

#### Type Declaration

##### session

```ts
readonly session: string;
```

***

### RunRecord

```ts
type RunRecord = {
  endedAt: string | null;
  error: string | null;
  id: string;
  prompt: string;
  session: string | null;
  signalId: string;
  startedAt: string | null;
  state: RunState;
};
```

A Run as the agent reads it: one Prompt, in one Session, and how it went.

`signalId` is the Signal whose Handler wrote the Prompt, and `prompt` is the text the agent was
given rather than the template it came from. `session` is a plain name and a reference to
nothing. Every Run the Worker records now carries one, and it stays nullable because rows written
before that still hold `null`.

The timings are ISO 8601 strings, or `null` for a Run that has not reached that point, so a
`running` Run has a `startedAt` and no `endedAt`.

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

***

### Runtime

```ts
type Runtime = {
  run: (prompt) => Promise<RunOutcome>;
};
```

Starts one Run and reports how it ended: the one method an Agent Implementation is driven
through.

Called one Run at a time and never concurrently, whatever Session each is in. An implementation
therefore needs no locking of its own, and a Workspace shared with every Signal Handler is safe.

Throwing instead of answering a failure comes to the same thing: the Run fails carrying the
thrown message. Neither form takes the Signal Worker down.

There is no timeout and no cancellation, here or anywhere else in the framework. A call that
never settles halts the Gateway for every Party, so a Runtime that waits on something remote
brings its own bound.

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
type Signal<TPayload> = {
  emittedAt: Date;
  id: string;
  kind: string;
  payload: TPayload;
};
```

What a Handler is given: the arrival record a Producer wrote, and the whole of it.

The `payload` is whatever that Producer wrote and is never interpreted on the way here, so what a
given `kind` carries is the Producer's contract with this Handler rather than anything the
framework settles.

The `state` and `error` that [SignalRecord](#signalrecord) carries are absent. A Handler runs because the
Signal is being processed, and how it ends is the framework's to record.

#### Type Parameters

##### TPayload

`TPayload` = `unknown`

What this Handler expects to find in the payload. The Signal Worker itself
  carries `unknown`, having no opinion about any of it, so the narrowing is the Handler's.

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
type SignalHandler<TPayload> = {
  handle: (signal) => 
     | readonly Prompt[]
    | Promise<readonly Prompt[]>;
  post?: (signal, outcome) => void | Promise<void>;
};
```

A Signal Handler: `handle`, and optionally `post`.

There is no context object and no second argument. A Handler closes over the logger, the
Workspace path, the Messenger and its prompt template, and its own factory in the entry point
supplies them, which is also why a Handler under test is a function of a Signal and needs no
harness. The one thing it cannot close over is the Signal Worker it runs under, that Worker being
constructed with the map this Handler is in.

`handle` returns zero, one or many Prompts. Declining, answering and fanning out are one
mechanism, and an empty array is not a special case: the Signal is done with no Runs, and the
arrival record stays behind, which is what makes a refusal auditable. Fanning out runs every
Prompt in the order returned, and one that fails does not stop the rest. Throwing fails this
Signal alone, and the Worker carries on.

`post` runs once, after every Run arising from the Signal has finished, whether they succeeded,
failed or were never created. It produces no Prompts, and it is the whole of the framework's
failure handling: notifying somebody, cleaning up, or emitting the work again is written here or
nowhere. Throwing here fails the Signal too, beside whatever else went wrong.

Neither is given a timeout, and neither is ever run twice for one Signal.

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

A Signal whose `kind` is not a key here fails permanently. There is no Handler to run a post
phase, and nothing re-runs it, so a typo in a `kind` is loud and one-way rather than silent.

***

### SignalRecord

```ts
type SignalRecord = {
  emittedAt: string;
  error: string | null;
  id: string;
  kind: string;
  payload: unknown;
  state: SignalState;
};
```

A Signal as the agent reads it, and the JSON two of these routes answer with.

The `payload` arrives as the Producer wrote it, and `emittedAt` as an ISO 8601 string, JSON
having no date.

`state` and `error` are here, where [Signal](#signal) has neither: what there is to know about a
prior arrival is mostly how it ended, and since a failed Signal is failed for good, the reason
has to be readable by whoever finds it.

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

***

### SignalWorker

```ts
type SignalWorker = Component & {
  agentRoutes: FastifyPluginAsync;
  emit: <TSchema>(tx, signal) => Promise<string>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
```

The Signal queue as a Component: something for a Producer to emit into, a Run loop, and a read of
both that the agent reaches over HTTP.

A Signal is a durable row with a processing state rather than an event, so the queue survives the
process and a Gateway that stops mid-queue starts again with the pending ones still in it.
Nothing in flight survives. A Signal left `processing` by a stopped worker is failed at the next
`start` and never re-run, because its Runs may already have sent Messages, written the Workspace
or called something outside, and its Prompt is already in the Session on disk. Its Runs are
failed with it, a `running` row with nothing running being a lie.

It holds no identity and knows nothing about messaging. No method takes a User, and nothing here
is scoped by one.

There is nothing that cancels, retries, reprioritises or removes a Signal, and no way to ask
whether the queue is empty. A failed Signal is failed for good, and doing the work after all
means emitting another.

#### Type Declaration

##### agentRoutes

```ts
readonly agentRoutes: FastifyPluginAsync;
```

The Agent server routes, as a Fastify plugin to register yourself.

Register it under a prefix of your own, or inside your own encapsulated plugin, or behind a
hook you share with your own routes. Passing no server and never registering this is how the
group is switched off.

The routes read these two tables and no other component's, and the whole surface is read-only
and unscoped: every Signal and every Run, whatever Session the reading Run is in.

##### emit()

```ts
emit<TSchema>(tx, signal): Promise<string>;
```

Records a Signal as pending, wakes the worker when the caller's transaction commits, and
answers with the new Signal's id.

It takes that transaction rather than opening one, so recording something and telling the agent
about it cannot come apart: a rollback loses both, and no wakeup is sent for a Signal that never
existed. The transaction may carry any component's schema, this write naming its own table.

It waits for nothing beyond the insert. The Signal is queued, not run, and the id is for
reading the outcome back later rather than for awaiting it.

###### Type Parameters

###### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\>

###### Parameters

###### tx

[`Handle`](shared-agent-framework.md#handle)\<`TSchema`\>

###### signal

[`EmittedSignal`](#emittedsignal)

###### Returns

`Promise`\<`string`\>

##### start()

```ts
start(): Promise<void>;
```

Starts looking for Signals, with the Handlers this Worker was constructed with.

It resolves immediately, and the first thing the worker does after that is fail whatever a
previous worker left `processing`. Nothing an Operator does next waits on that: a Signal
emitted meanwhile is a row in a queue, drained once the recovery is done.

###### Returns

`Promise`\<`void`\>

###### Throws

If it has already been called. One Signal Worker drains one queue, Runs being serial
  across the whole Gateway.

##### stop()

```ts
stop(): Promise<void>;
```

Stops looking for Signals and waits for the Run in flight to finish.

Not a shutdown protocol. The order Components stop in is the Operator's, and the framework
installs no `SIGTERM` handling of its own. There is no cancellation either: the Run in flight
runs to completion, because abandoning it would leave partial effects nothing retries. So this
takes as long as the slowest Run the agent can have started.

Whatever is still pending stays pending, for the next worker over this database to drain.

###### Returns

`Promise`\<`void`\>

***

### SignalWorkerOptions

```ts
type SignalWorkerOptions = {
  agentServer?: {
     fastify: FastifyInstance;
  };
  db: Db;
  handlers: SignalHandlers;
  logger?: Logger;
  runtime: Runtime;
  sweepIntervalMs?: number;
};
```

#### Properties

##### agentServer?

```ts
readonly optional agentServer?: {
  fastify: FastifyInstance;
};
```

The Agent server, if the agent is to read prior Signals and Runs.

Given one, the constructor registers `agentRoutes` on its Fastify instance at no prefix:
`/signals`, `/signals/:id`, `/runs` and `/runs/:id`. Omit it and nothing is registered
anywhere, which is how the group is switched off.

Structural, and it asks for nothing but the Fastify instance, so what `serverComponent` returns
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

A construction option rather than an argument to `start`, so a Signal Worker with no Handlers
is unconstructable rather than merely unstartable.

Held rather than copied. The Worker looks a `kind` up in this same object at dispatch, so an
entry written into it before `start` is dispatched on, and that is the way out of the knot a
Handler that emits back into this Worker ties: it cannot close over an object that does not
exist yet, so it is built after construction and assigned in.

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to a `pino` instance on stdout.

One info line as each Signal is claimed and as it finishes, one as each Run starts and ends
carrying the Session it ran in, and a debug line for every wakeup saying what caused it. A
Signal Handler's failure and a Run's are logged at error whether or not anything else notices
them, and a Signal a stopped worker left behind at warn. No Prompt text and no payload is ever
written.

##### runtime

```ts
readonly runtime: Runtime;
```

What a Prompt is handed to. `createPiRuntime`, on `shared-agent-framework/pi`, builds the one
this framework ships.

##### sweepIntervalMs?

```ts
readonly optional sweepIntervalMs?: number;
```

How often the worker looks for pending Signals regardless of notifications, in milliseconds.
Defaults to 5000.

Not the latency of a Signal: emitting one wakes the worker at once. This is the safety net for
a notification sent while the listening connection was down, so what the number bounds is how
long a Signal can sit unnoticed after a database restart. There is no correctness in it, and
the cost of lowering it is a query per interval forever.

## Variables

### runs

```ts
const runs: PgTableWithColumns<{
}>;
```

One Prompt executed in one Session, and the Worker's record of its own work.

`session` is a plain name and not a foreign key. Sessions belong to the Agent Implementation, and
what is kept here is the name the Prompt was routed to. The Worker always writes one, a fresh
Session included, naming that one after the Run. The column stays nullable because rows written
before it did that still hold `null`.

***

### runStates

```ts
const runStates: readonly ["pending", "running", "done", "failed"];
```

A Run's state. There is no `timed_out`, the framework imposing no timeout on a Run or on anything
else, so a Run that never ends stays `running` and holds the queue.

***

### signals

```ts
const signals: PgTableWithColumns<{
}>;
```

An arrival record, written by a Producer and immutable but for `state` and `error`.

Nothing deletes one. A Signal a Handler declined leaves a row behind exactly as a Signal that ran
does, which is what makes a refusal auditable afterwards.

***

### signalStates

```ts
const signalStates: readonly ["pending", "processing", "done", "failed"];
```

A Signal's processing state. One-way: nothing returns to `pending`, and a failed Signal is never
re-run, so `error` is the whole of what became of it.

***

### workerSchema

```ts
const workerSchema: PgSchema<"saf_signals">;
```

The PostgreSQL schema both tables below live in, `saf_signals`, named for its subject rather than
for the Component.

Prefixed because the framework is installed into a database it does not own, where a bare
`signals` is a plausible name for something an Operator already has. Not configurable: the tables
are compiled against this object, and the same object is what a generation reads.

***

### workerTables

```ts
const workerTables: {
  runs: PgTableWithColumns<{
  }>;
  signals: PgTableWithColumns<{
  }>;
};
```

#### Type Declaration

##### runs

```ts
runs: PgTableWithColumns<{
}>;
```

One Prompt executed in one Session, and the Worker's record of its own work.

`session` is a plain name and not a foreign key. Sessions belong to the Agent Implementation, and
what is kept here is the name the Prompt was routed to. The Worker always writes one, a fresh
Session included, naming that one after the Run. The column stays nullable because rows written
before it did that still hold `null`.

##### signals

```ts
signals: PgTableWithColumns<{
}>;
```

An arrival record, written by a Producer and immutable but for `state` and `error`.

Nothing deletes one. A Signal a Handler declined leaves a row behind exactly as a Signal that ran
does, which is what makes a refusal auditable afterwards.

## Functions

### createSignalWorker()

```ts
function createSignalWorker(options): SignalWorker;
```

Builds a Signal Worker over a Db, a Runtime and a map of Signal Handlers, and registers the read
routes on the Agent server if one was passed.

`createGateway` builds a Worker already and keys it last, so it drains while every other
Component is still live. Reach for this only when assembling a Gateway by hand with
`createBareGateway`.

#### Parameters

##### options

[`SignalWorkerOptions`](#signalworkeroptions)

#### Returns

[`SignalWorker`](#signalworker)
