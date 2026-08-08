# shared-agent-framework/scheduler

The Scheduler component owns Schedules and wakes the deployment when one matures. A Schedule is a
named, stored instruction to emit one Signal at future times: a cron expression in a named IANA
time zone, or a single absolute instant. Its name is its whole identity, in one flat namespace
the agent and the Operator share, so creating a name that exists updates it.

[createScheduler](#createscheduler) makes one. [Scheduler](#scheduler) is what comes back, and `schedule` is the
upsert both creators go through. [scheduleFiredKind](#schedulefiredkind) and [ScheduleFiredRecord](#schedulefiredrecord) are
the two halves of the Signal contract, so a Handler for a matured Schedule is written
`SignalHandler<ScheduleFiredRecord>` with no string literal of its own.

Construct the Signal Worker first, which every fire emits into. Then register a Handler under
that one `kind`: with none, a stored Schedule fires into a Signal that fails on every attempt.
Passing no Agent server registers no route, which keeps the agent away from Schedules and leaves
the programmatic API to the Operator.

A missed fire is never replayed. Every next fire is derived forward from now, at each boot and
after each fire, so a daily digest arranged before a week of downtime fires once afterwards
rather than seven times.

The subpath exports the one table beside the constructor, for the schema an Operator generates
their migrations from. It references no other component's table, so it can go into that schema on
its own.

## Example

A Gateway that wakes itself every morning, and the Handler each fire reaches.
```ts
import { createGateway } from "shared-agent-framework/gateway";
import { createPiRuntime } from "shared-agent-framework/pi";
import type { ScheduleFiredRecord } from "shared-agent-framework/scheduler";
import { createScheduler, scheduleFiredKind } from "shared-agent-framework/scheduler";
import { templateHandler } from "shared-agent-framework/signals";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? "",
  runtime: createPiRuntime({ image: "my-agent:1" }),
  // Not loopback: the agent reaches this server from a container of its own.
  agentListen: { host: "0.0.0.0", port: 8081 },
  publicListen: { host: "0.0.0.0", port: 8080 },
  // Drop `agentServer` here and the routes vanish, leaving the programmatic API below.
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

// The Operator's own Schedule, arranged at boot. Running this again converges to one row.
const { schedule } = await gateway.components.scheduler.schedule({
  name: "morning-digest",
  spec: { kind: "cron", expr: "0 7 * * *", tz: "Europe/Berlin" },
  data: { audience: "everybody" },
});
console.log(schedule.nextFireAt);
```

## Classes

### ScheduleSpecError

A name, a cron `expr`, a `tz`, an `until` or a `once` instant the Scheduler will not accept.

Thrown by `schedule` before anything is written, so a caller learns of the mistake at creation
rather than through a Schedule that silently never fires, or one the agent cannot address.

The `message` is the refusal reason and is safe to show a caller: it names the value that was
refused and nothing about the Scheduler itself. A named class rather than a bare `Error` so that
the Agent routes catch this and only this, and answer 400. Every other failure stays a 500.

#### Extends

- `Error`

#### Constructors

##### Constructor

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">new</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">message</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#schedulespecerror" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleSpecError</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

###### Parameters

###### message

`string`

###### Returns

[`ScheduleSpecError`](#schedulespecerror)

###### Overrides

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">Error.</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">constructor</span></span></code></pre></div>

## Type Aliases

### ScheduleFiredRecord

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> ScheduleFiredRecord</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> data</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> firedAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> scheduledFor</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> scheduleName</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

The payload of the Signal a matured Schedule emits, flat, and half of the Signal contract.

The other half is the fixed `kind`. Every fire of every Schedule, from either creator, arrives as
this one shape, so a Handler is written `SignalHandler<ScheduleFiredRecord>` and neither the
`kind` string nor the payload shape is spelled out a second time by hand.

#### Properties

##### data

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> data</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The creator's data, byte for byte as it was supplied. The Scheduler reads none of it.

##### firedAt

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> firedAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

When the Scheduler actually emitted, ISO 8601. Past `scheduledFor` means the fire was late.

##### scheduledFor

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> scheduledFor</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The instant the fire was arranged for, ISO 8601.

##### scheduleName

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> scheduleName</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The Schedule this fire came from, which is its whole identity and the thing to correlate on.

***

### ScheduleInput

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> ScheduleInput</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> data</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> name</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> spec</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#schedulespec" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleSpec</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> until</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

What a create-or-update takes.

`data` is the creator's own, uninterpreted, and is stored as null when omitted. `until` bounds a
`cron`: after its last occurrence at or before that instant the Schedule retires. It means
nothing on a `once`, which bounds itself by firing once, and is ignored there rather than
refused. The Agent route refuses it instead.

#### Properties

##### data?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> data</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### name

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> name</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### spec

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> spec</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#schedulespec" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleSpec</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### until?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> until</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

***

### ScheduleKind

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> ScheduleKind</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> typeof</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> </span><a href="#schedulekinds" class="saf-signature-link"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">scheduleKinds</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">[number];</span></span></code></pre></div>

***

### ScheduleOutcome

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> ScheduleOutcome</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> created</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> boolean</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> schedule</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#schedulerecord" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleRecord</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

What a create-or-update answers with.

`created` is read out of the write itself rather than from a lookup in front of it, so nothing
races between the two. It is what an HTTP `PUT` turns into 201 versus 200. A create that resolved
to no future fire is `created: false` carrying a record whose `nextFireAt` is null, nothing
having been armed.

#### Properties

##### created

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> created</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> boolean</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### schedule

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> schedule</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#schedulerecord" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleRecord</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

***

### Scheduler

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Scheduler</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.gateway.html#component" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Component</span></a><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> &#x26;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  cancel</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">name</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">boolean</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  list</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><a href="#schedulerecord" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleRecord</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">[]>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  schedule</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">input</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#scheduleinput" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleInput</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><a href="#scheduleoutcome" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleOutcome</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  start</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  stop</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  tick</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

The Schedules a deployment has arranged, as a Component: an upsert by name, a list, a cancel, and
the due-check the timer calls.

A Schedule is stored, so it outlives the Run and the process that arranged it. Nothing removes
one but a cancel, a `once` that has fired, or a `cron` reaching its `until`. There is no expiry
and nothing sweeps.

The programmatic API works whether or not the Agent routes were registered, and none of its four
methods is scoped: names live in one flat namespace that the Operator and the agent share, so
either reaches what the other arranged.

An occurrence is announced once. The Signal and the row's advance or delete commit in one
transaction, so nothing can fire twice or retire silently. An occurrence that fell while the
process was down is skipped rather than replayed, every next fire being derived forward from now.

#### Type Declaration

##### cancel()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">cancel</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">name</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">boolean</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

Cancels the Schedule this name addresses, and answers whether one was there.

A name that was already gone answers `false` rather than an idempotent `true`, so a caller is
never told it stopped something that did not exist. A `cron` carrying no `until` has a next
fire forever, so this is what ends one.

###### Parameters

###### name

`string`

###### Returns

`Promise`\<`boolean`\>

##### list()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">list</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><a href="#schedulerecord" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleRecord</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">[]>;</span></span></code></pre></div>

Every Schedule, soonest to fire first and then by name.

Unbounded: the cap on a page belongs to the Agent route rather than to this.

###### Returns

`Promise`\<[`ScheduleRecord`](#schedulerecord)[]\>

##### schedule()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">schedule</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">input</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#scheduleinput" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleInput</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><a href="#scheduleoutcome" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleOutcome</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

Creates a Schedule under this name, or updates the one already there, and answers with the
record and whether the name was new.

An upsert, so a retry or a revised plan converges to one Schedule instead of accumulating
duplicates, and a declaration made at every boot is safe to re-run.

A spec with no future fire is not refused here. A `once` whose instant has passed, and a `cron`
whose `until` sits at or before its next occurrence, arm nothing: any row under the name is
removed, and the record answers with a null `nextFireAt`. The Agent route refuses that same
case with a 400 instead, a caller in the moment being able to act on it.

Refuses a name that is not a url-safe key: at most 128 letters, digits, dots, dashes and
underscores. The Agent routes' `/:name` path holds one to that same rule, so every Schedule
this creates is one those routes can address.

###### Parameters

###### input

[`ScheduleInput`](#scheduleinput)

###### Returns

`Promise`\<[`ScheduleOutcome`](#scheduleoutcome)\>

###### Throws

`ScheduleSpecError` for a name outside that set, a cron `expr` that will not parse, a
  `tz` that is no IANA zone, or a malformed `until`. Nothing is written first.

##### start()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">start</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

Re-derives every Schedule's next fire forward from now, then arms the firing timer.

The re-derivation is what makes a restart clean. A stored next fire is not trusted as a trigger
across a boot, so an occurrence that fell during an outage is dropped for a spent `once` and
jumped for a `cron`, however many were missed. The one fire that still arrives late is on a
process that stayed live and was frozen through the instant, because no boot ran.

A second `start` is a no-op rather than a second timer.

###### Returns

`Promise`\<`void`\>

##### stop()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">stop</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

Cancels the firing timer, so no fire begins once it returns.

A fire already under way commits its Signal with the row's advance or delete, so an occurrence
announced during a shutdown is announced exactly once. A Signal no Worker reached before the
process ended is run at the next boot.

A second `stop`, or a `stop` before any `start`, finds no timer and does nothing.

###### Returns

`Promise`\<`void`\>

##### tick()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">tick</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

Fires every Schedule the clock has reached, and resolves when none is left.

The seam the timer calls, exposed so a test drives the same code with an injected clock and
without sleeping. Drive it serially, awaiting one call before the next, which is how the timer
calls it. It arms nothing: a `tick` on a stopped Scheduler fires what is due and leaves the
timer as it found it.

###### Returns

`Promise`\<`void`\>

***

### ScheduleRecord

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> ScheduleRecord</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> data</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> name</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> nextFireAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> spec</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#schedulespec" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleSpec</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> until</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

A Schedule as every surface answers with it: the upsert's answer and the list's entries.

One shape rather than a projection per surface, so a record in hand and a record read back later
agree field for field. `spec` is the union rebuilt from the stored columns, with a cron's zone
resolved. `until` is a cron's end instant, and is null for a `once` and for an unbounded cron.

`nextFireAt` is derived forward from now rather than read off a trusted timestamp. It is null
only for a Schedule with no future fire, which is therefore spent and stored nowhere.

#### Properties

##### data

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> data</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### name

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> name</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### nextFireAt

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> nextFireAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### spec

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> spec</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#schedulespec" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ScheduleSpec</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### until

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> until</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

***

### SchedulerOptions

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> SchedulerOptions</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> agentServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">    readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">  };</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> db</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.db.html#db" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Db</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> logger</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.logging.html#logger" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Logger</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> maxSleepMs</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> number</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> now</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Date</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> worker</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.signals.html#signalworker" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignalWorker</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

#### Properties

##### agentServer?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> agentServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

Where the agent creates, lists, reads and cancels Schedules over HTTP. Omit it and no route is
registered anywhere, which is the switch that keeps the agent away from Schedules altogether.
The programmatic API below stays available either way.

Given one, the constructor registers `PUT /schedules/:name`, `GET /schedules`,
`GET /schedules/:name` and `DELETE /schedules/:name`, at no prefix. These are the only routes
in the framework that address a record by a name its caller chose rather than by an id the
Gateway minted, which is why the create is a `PUT`.

Worth switching off for two reasons. An agent that wakes itself can loop the one serial Signal
lane, and nothing scopes a Schedule by creator, so the same routes reach the Operator's own.

Structural: anything carrying a Fastify instance satisfies it.

###### fastify

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### db

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> db</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.db.html#db" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Db</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### logger?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> logger</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.logging.html#logger" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Logger</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

Defaults to a `pino` instance on stdout.

One info line per fire, naming the Schedule, and one error line for a due-check that failed.
That failure is swallowed rather than thrown, so the line is the only record of it.

##### maxSleepMs?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> maxSleepMs</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> number</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The longest the firing timer sleeps before it wakes and re-derives due-ness, in milliseconds.
Defaults to roughly a minute.

A bound on correctness rather than a tuning knob. It keeps an armed delay under the 24.85-day
`setTimeout` ceiling, and it bounds the drift a long arm accrues across an NTP step, a suspend
or a DST jump. Lower it and the timer wakes more often for nothing. Raise it past the ceiling
and a far Schedule overflows into an immediate wake.

##### now?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> now</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Date</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The clock the due-check, the derivations and every timestamp read. Defaults to real time.

Taken as an option so timing is deterministic in a test: set the instant, await `tick`, and
assert what fired, with nothing sleeping.

###### Returns

`Date`

##### worker

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> worker</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.signals.html#signalworker" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignalWorker</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The Signal Worker every fire emits into.

The emit joins the fire's own transaction, so announcing an occurrence and retiring or
advancing the Schedule commit together or not at all.

***

### ScheduleSpec

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> ScheduleSpec</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  |</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">      readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> at</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">      readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> kind</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF"> "once"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">    }</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  |</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">      readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> expr</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">      readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> kind</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF"> "cron"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">      readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> tz</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">    };</span></span></code></pre></div>

How a Schedule recurs: a tagged union on `kind`.

 - `once` is one absolute instant, ISO 8601. cron cannot express it, having no year field.
 - `cron` is a recurring expression evaluated in a named IANA time zone. `tz` may be omitted, and
   then it is UTC rather than the zone the Gateway's host is set to.

## Variables

### scheduleFiredKind

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> scheduleFiredKind</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF"> "saf_schedule_fired"</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF"> "saf_schedule_fired"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The `kind` every matured Schedule emits under, and half of the Signal contract. The other half is
that the payload is the fired record, flat.

A constant and not a construction option, which is the cap this component puts on the agent's
power: whatever the agent arranges, it wakes the one Handler the Operator wrote. Register that
Handler. A Schedule that fires with none registered under this `kind` leaves a Signal that fails
on every attempt.

***

### scheduleKinds

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> scheduleKinds</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> readonly</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> [</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"once"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"cron"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">];</span></span></code></pre></div>

***

### schedulerSchema

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> schedulerSchema</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"saf_scheduler"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

The PostgreSQL schema the Scheduler's table lives in, `saf_scheduler`.

Prefixed because the framework is installed into a database it does not own, and not
configurable: the table is compiled against this object, and the same object is what a generation
reads.

***

### schedulerTables

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> schedulerTables</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  schedules</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgTableWithColumns</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;{}>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

#### Type Declaration

##### schedules

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">schedules</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgTableWithColumns</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;{}>;</span></span></code></pre></div>

One Schedule: a named instruction to emit the Scheduler's one Signal at future times.

`name` is the primary key and the only identifier. There is no surrogate id beside it, so a
create is an upsert on the name and a cancel is a delete of it.

***

### schedules

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> schedules</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgTableWithColumns</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;{}>;</span></span></code></pre></div>

One Schedule: a named instruction to emit the Scheduler's one Signal at future times.

`name` is the primary key and the only identifier. There is no surrogate id beside it, so a
create is an upsert on the name and a cancel is a delete of it.

## Functions

### createScheduler()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">function</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> createScheduler</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">options</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#scheduleroptions" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SchedulerOptions</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#scheduler" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Scheduler</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

Builds the Scheduler, and registers the four Agent routes when an Agent server is given.

Nothing here connects, listens or applies DDL, and no timer is armed until `start`.

#### Parameters

##### options

[`SchedulerOptions`](#scheduleroptions)

#### Returns

[`Scheduler`](#scheduler)
