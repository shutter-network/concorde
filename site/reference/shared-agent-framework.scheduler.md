# shared-agent-framework/scheduler

The Scheduler, from `shared-agent-framework/scheduler`.

`createScheduler` is the whole of it for an Operator. Hand it the Db and the Signal Worker, and
it registers its Agent routes on the server it is given. Then key it in the Gateway's record like
every other Component: `start` arms its firing timer and `stop` cancels it.

It answers with the programmatic interface an Operator always has. That is `schedule`, an upsert
by name, plus `list`, `cancel` and the awaitable `tick`. A `schedule` call the Scheduler will not
accept throws `ScheduleSpecError` before anything is persisted. The Agent route catches exactly
that and answers 400.

`scheduleFiredKind` and `ScheduleFiredRecord` are the two halves of the Signal contract, so a
Handler for a matured Schedule is `SignalHandler<ScheduleFiredRecord>`. Registering no Handler
for that `kind` leaves a stored Schedule firing into a permanently failed Signal. This subpath
also carries the one table. A Schedule references nobody, so a barrel carrying it alone generates
cleanly.

## Example

A Gateway that wakes itself every morning, and the Handler the fire reaches.
```ts
import { createGateway, templateHandler } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";
import type { ScheduleFiredRecord } from "shared-agent-framework/scheduler";
import { createScheduler, scheduleFiredKind } from "shared-agent-framework/scheduler";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  extend: ({ db, worker, agentServer }) => ({
    scheduler: createScheduler({ db, worker, agentServer }),
  }),
  handlers: () => ({
    [scheduleFiredKind]: templateHandler<ScheduleFiredRecord>({
      template: new URL("./prompts/digest.hbs", import.meta.url),
      session: (signal) => signal.payload.scheduleName,
      data: (signal) => signal.payload,
    }),
  }),
});

await gateway.start();

// The Operator's own Schedule, declared at boot. Re-running this converges to one row.
await gateway.components.scheduler.schedule({
  name: "morning-digest",
  spec: { kind: "cron", expr: "0 7 * * *", tz: "Europe/Berlin" },
  data: { audience: "everybody" },
});
```

## Classes

### ScheduleSpecError

A cron `expr`, a `tz` or an `until` the Scheduler will not accept.

Thrown by `schedule` before anything is persisted. So a caller learns of the mistake at creation
rather than through a Schedule that silently never fires.

A named class rather than a bare `Error`, so the Agent routes catch exactly this and answer 400.
Every other error stays a 500. Its `message` is the refusal reason and is safe to surface. It
names the bad value and nothing about the Scheduler's internals.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new ScheduleSpecError(message): ScheduleSpecError;
```

###### Parameters

###### message

`string`

###### Returns

[`ScheduleSpecError`](#schedulespecerror)

###### Overrides

```ts
Error.constructor
```

## Type Aliases

### ScheduleFiredRecord

```ts
type ScheduleFiredRecord = {
  data: unknown;
  firedAt: string;
  scheduledFor: string;
  scheduleName: string;
};
```

The Signal a matured Schedule emits, and half of the Signal contract.

The other half is the fixed `scheduleFiredKind`. Every matured Schedule, from either creator,
emits this one envelope. It carries the creator's opaque `data` verbatim, plus the metadata a
Handler needs to correlate and to judge lateness.

Exported so that an Operator's Handler is `SignalHandler<ScheduleFiredRecord>`, and neither the
`kind` nor the payload shape is re-declared by hand.

#### Properties

##### data

```ts
readonly data: unknown;
```

The creator's opaque data, exactly as it was supplied at creation.

##### firedAt

```ts
readonly firedAt: string;
```

The instant the Scheduler actually emitted, ISO 8601. Late when it is past `scheduledFor`.

##### scheduledFor

```ts
readonly scheduledFor: string;
```

The instant this fire was intended for, ISO 8601. A Handler compares it to `firedAt`.

##### scheduleName

```ts
readonly scheduleName: string;
```

The Schedule this fire came from, its sole identifier and the reference to correlate on.

***

### ScheduleInput

```ts
type ScheduleInput = {
  data?: unknown;
  name: string;
  spec: ScheduleSpec;
  until?: string;
};
```

What a create-or-update takes: the name, the recurrence, the opaque data, and a cron's bound.

`data` is optional and stored as `null` when omitted. `until` bounds a recurring Schedule: after
its last occurrence at or before that instant it is retired. It is meaningless for a `once`,
which bounds itself by firing once. This layer ignores it there, and the Agent route refuses it.

#### Properties

##### data?

```ts
readonly optional data?: unknown;
```

##### name

```ts
readonly name: string;
```

##### spec

```ts
readonly spec: ScheduleSpec;
```

##### until?

```ts
readonly optional until?: string;
```

***

### ScheduleKind

```ts
type ScheduleKind = typeof scheduleKinds[number];
```

Which of the two shapes a stored Schedule is, as the `kind` column's type.

***

### ScheduleOutcome

```ts
type ScheduleOutcome = {
  created: boolean;
  schedule: ScheduleRecord;
};
```

What `schedule` answers with: whether the name was newly created, and the resulting record.

`created` distinguishes an insert from an update, which is the signal an HTTP `PUT` turns into
201 versus 200. It is read from the upsert itself rather than from a lookup in front of it.

A Schedule that resolved to no future fire is `created: false` with a `null` `nextFireAt`, since
nothing was armed.

#### Properties

##### created

```ts
readonly created: boolean;
```

##### schedule

```ts
readonly schedule: ScheduleRecord;
```

***

### Scheduler

```ts
type Scheduler = Component & {
  cancel: (name) => Promise<boolean>;
  list: () => Promise<ScheduleRecord[]>;
  schedule: (input) => Promise<ScheduleOutcome>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  tick: () => Promise<void>;
};
```

What the constructor answers with: the interface the Operator always has.

`schedule`, `list` and `cancel` are the management surface, and they work whether or not the
Agent routes are switched on. `tick` is the due-check the internal timer also calls, exposed as
the testing seam. `start` arms that timer and `stop` cancels it.

#### Type Declaration

##### cancel()

```ts
cancel(name): Promise<boolean>;
```

Cancels a Schedule by name, and answers whether one was there.

So a caller learns that a name was already gone. It is not told that it stopped something which
did not exist.

###### Parameters

###### name

`string`

###### Returns

`Promise`\<`boolean`\>

##### list()

```ts
list(): Promise<ScheduleRecord[]>;
```

Every Schedule, ascending by next fire then name, so an Operator sees what is arranged.

###### Returns

`Promise`\<[`ScheduleRecord`](#schedulerecord)[]\>

##### schedule()

```ts
schedule(input): Promise<ScheduleOutcome>;
```

Creates a Schedule, or updates the one already under this name.

An upsert, so a retry or a revised plan converges to one Schedule rather than accumulating
duplicates. It answers whether it created or updated, and with the resulting record.

A `once` whose instant is already past has no future fire. It is not armed, and any existing
row under the name is removed. The record comes back with a `null` `nextFireAt`.

###### Parameters

###### input

[`ScheduleInput`](#scheduleinput)

###### Returns

`Promise`\<[`ScheduleOutcome`](#scheduleoutcome)\>

###### Throws

`ScheduleSpecError` if a cron `expr` is invalid, a `tz` unknown, or an `until`
  malformed. Nothing is written first.

##### start()

```ts
start(): Promise<void>;
```

Re-derives every Schedule's next fire forward from `now`, then arms the firing timer.

The re-derivation is what makes a restart clean. The persisted `at` is display-only and is not
trusted as a trigger across a boot. So an occurrence that fell during an outage is dropped for
a spent `once` and jumped for a `cron`. Only a continuously-live process frozen through a fire
time fires once late, because no boot ran.

The timer is a single capped `setTimeout`, re-armed after every fire and on every `schedule`
and `cancel`. A second `start` is a no-op rather than a second timer.

###### Returns

`Promise`\<`void`\>

##### stop()

```ts
stop(): Promise<void>;
```

Cancels the firing timer, so no fire begins during or after the worker's drain.

A fire already committed is a pending Signal the next start's worker drains. What `stop`
guarantees is that no new fire begins once it returns. A second `stop`, or a `stop` before any
`start`, finds no timer and does nothing.

###### Returns

`Promise`\<`void`\>

##### tick()

```ts
tick(): Promise<void>;
```

Fires every Schedule matured at the current `now`, and resolves when none is left.

Each fire emits one Signal and retires the spent one-shot in one transaction. This is the
awaitable seam the timer calls and the tests drive directly. Drive it serially: await one
`tick` before the next, which is how the timer calls it too.

###### Returns

`Promise`\<`void`\>

***

### ScheduleRecord

```ts
type ScheduleRecord = {
  data: unknown;
  name: string;
  nextFireAt: string | null;
  spec: ScheduleSpec;
  until: string | null;
};
```

A Schedule as every surface answers with it: the upsert response and the list.

One shape and not a projection per surface. `spec` is the tagged union reconstructed from the
row's columns, and `data` is the creator's opaque payload. `until` is a cron's optional end
instant, null for a `once` and for an unbounded cron.

`nextFireAt` is when it fires next, derived forward from now rather than read from a trusted
timestamp. It is `null` only for a Schedule with no future fire, which is therefore spent.

#### Properties

##### data

```ts
readonly data: unknown;
```

##### name

```ts
readonly name: string;
```

##### nextFireAt

```ts
readonly nextFireAt: string | null;
```

##### spec

```ts
readonly spec: ScheduleSpec;
```

##### until

```ts
readonly until: string | null;
```

***

### SchedulerOptions

```ts
type SchedulerOptions = {
  agentServer?: {
     fastify: FastifyInstance;
  };
  db: Db;
  logger?: Logger;
  maxSleepMs?: number;
  now?: () => Date;
  worker: SignalWorker;
};
```

Everything `createScheduler` needs: the Db, the Signal Worker, and four defaults.

#### Properties

##### agentServer?

```ts
readonly optional agentServer?: {
  fastify: FastifyInstance;
};
```

The Agent server, if the agent is to create, list, read and cancel Schedules over HTTP.

Given one, the constructor registers `PUT`, `GET` and `DELETE` on `/schedules` and
`/schedules/:name` at no prefix. Omit it and nothing is registered anywhere. That is the
disable switch. It stops the agent waking itself and touching the Operator's own Schedules. The
programmatic interface below stays available regardless.

Structural, and asks for nothing but the Fastify instance, so what satisfies it is what
`serverComponent` returns.

###### fastify

```ts
readonly fastify: FastifyInstance;
```

##### db

```ts
readonly db: Db;
```

##### logger?

```ts
readonly optional logger?: Logger;
```

Defaults to a `pino` instance on stdout.

##### maxSleepMs?

```ts
readonly optional maxSleepMs?: number;
```

The longest the firing timer sleeps before it wakes and re-derives due-ness, in milliseconds.
Defaults to roughly a minute.

A cap for correctness rather than tuning. It keeps the armed delay under the 24.85-day
`setTimeout` ceiling. It also bounds the drift a long arm accrues across an NTP step, a suspend
or a DST jump.

There is no correctness in the exact value. Lower it and the timer polls more often. Raise it
past the ceiling and a far Schedule overflows into an immediate wake.

##### now?

```ts
readonly optional now?: () => Date;
```

The clock the due-check reads. Defaults to real time.

Injected so timing is deterministic in tests: set `now`, await `tick`, assert what fired, with
no sleeping.

###### Returns

`Date`

##### worker

```ts
readonly worker: SignalWorker;
```

The Signal Worker a matured Schedule emits into.

Required: a Scheduler that woke nobody would be a Producer that produces nothing. The emit
shares the fire's transaction, which is what makes retiring a spent one-shot and announcing it
one atomic act.

***

### ScheduleSpec

```ts
type ScheduleSpec = 
  | {
  at: string;
  kind: "once";
}
  | {
  expr: string;
  kind: "cron";
  tz?: string;
};
```

How a Schedule recurs: a tagged union, with `kind` as the seam a future format is added at.

 - `once` is a single absolute instant (ISO 8601). It needs no library and is the agent's most
   ordinary request. cron cannot express it, having no year field.
 - `cron` is a recurring expression in a named IANA time zone, computed by `cron-parser`. `tz` is
   optional: a caller who omits it gets UTC, never the server's local zone.

## Variables

### scheduleFiredKind

```ts
const scheduleFiredKind: "saf_schedule_fired" = "saf_schedule_fired";
```

The `kind` of the Signal every matured Schedule emits, and half of the Signal contract.

The other half is that the payload is the `ScheduleFiredRecord`, flat. So a Handler is written
`SignalHandler<ScheduleFiredRecord>` and an Operator's map needs no string literal.

A constant rather than a construction option. The creator never chooses the `kind`, which is the
cap this Component puts on the agent's power. A `kind` with no Handler registered leaves a stored
Schedule firing into a permanently failed Signal.

***

### scheduleKinds

```ts
const scheduleKinds: readonly ["once", "cron"];
```

The two shapes a Schedule's recurrence takes, and the discriminant the row branches on.

`once` is a single absolute instant and needs no library. `cron` is a recurring expression in a
named time zone, parsed by `cron-parser`.

***

### schedulerSchema

```ts
const schedulerSchema: PgSchema<"saf_scheduler">;
```

The Scheduler's schema, named for the Component rather than only its subject.

Prefixed because the framework is installed into a database it does not own. The name is not
theirs to change: the table below is compiled against it, and their generation reads this object.

***

### schedulerTables

```ts
const schedulerTables: {
  schedules: PgTableWithColumns<{
  }>;
};
```

Everything the Scheduler keeps, as `db.handle` wants it.

One object, so every module of this Component asks for the same handle by the same name.

#### Type Declaration

##### schedules

```ts
schedules: PgTableWithColumns<{
}>;
```

One Schedule: a named instruction to emit the Scheduler's fixed Signal at future times.

`name` is the primary key and the sole identifier. There is no surrogate id. So creation is a
`PUT`-shaped upsert on the name, and a cancel is a delete of it.

***

### schedules

```ts
const schedules: PgTableWithColumns<{
}>;
```

One Schedule: a named instruction to emit the Scheduler's fixed Signal at future times.

`name` is the primary key and the sole identifier. There is no surrogate id. So creation is a
`PUT`-shaped upsert on the name, and a cancel is a delete of it.

## Functions

### createScheduler()

```ts
function createScheduler(options): Scheduler;
```

Builds the Scheduler and registers its Agent routes when an Agent server is given.

Nothing here connects, listens or applies DDL. Put the result in the Gateway's record under a key
of your own, ahead of the Signal Worker.

#### Parameters

##### options

[`SchedulerOptions`](#scheduleroptions)

#### Returns

[`Scheduler`](#scheduler)

#### Example

Built in `extend`, and then given the Operator's own boot-time Schedule.
```ts
import { createGateway, templateHandler } from "shared-agent-framework";
import { createPiRuntime } from "shared-agent-framework/pi";
import type { ScheduleFiredRecord } from "shared-agent-framework/scheduler";
import { createScheduler, scheduleFiredKind } from "shared-agent-framework/scheduler";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  agentListen: { host: "127.0.0.1", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  // No `agentServer` here, so the agent cannot reach the Schedules at all.
  extend: ({ db, worker }) => ({ scheduler: createScheduler({ db, worker }) }),
  handlers: () => ({
    [scheduleFiredKind]: templateHandler<ScheduleFiredRecord>({
      template: new URL("./prompts/digest.hbs", import.meta.url),
      session: (signal) => signal.payload.scheduleName,
      data: (signal) => signal.payload,
    }),
  }),
});

await gateway.start();

const { scheduler } = gateway.components;
const { created, schedule } = await scheduler.schedule({
  name: "morning-digest",
  spec: { kind: "cron", expr: "0 7 * * *", tz: "Europe/Berlin" },
});
console.log(created, schedule.nextFireAt);
```
