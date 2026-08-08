# shared-agent-framework/db

The Db is the one PostgreSQL client in a Gateway. Every other part queries through it, so a
deployment holds one pool, and `pg` reaches no code but this.

[openDb](#opendb) makes one from a connection URL. [Db](#db) is what comes back, a Component whose
programmatic API hands out a schema-typed [Handle](#handle) per component, runs a callback inside a
[Transaction](#transaction), and registers a PostgreSQL `LISTEN` on a connection of its own.
[ChannelListener](#channellistener) is what that registration reports to, and [Listening](#listening) is what
cancels it.

`createGateway` opens a Db already and passes it to `extend`, so call [openDb](#opendb) yourself
only when you assemble a Gateway by hand. Either way it is constructed before every component
that queries through it, each taking it as an option.

**It applies no DDL and verifies none**, so a database behind the code starts cleanly and fails
at the first query instead. The Db owns no tables and exports no schema of its own: every table
belongs to a component, and putting them all in place is the Operator's own `drizzle-kit` run,
before the Gateway starts.

## Example

A pool opened by hand, a handle typed to one component's tables, and a write inside a
transaction.
```ts
import { sql } from "drizzle-orm";
import { openDb } from "shared-agent-framework/db";
import { users, usersTables } from "shared-agent-framework/users";

const db = openDb(process.env.DATABASE_URL ?? "");
// Nothing was on the wire until here, which is what lets every component be constructed first.
await db.start();

// One handle per component, typed to that component's tables and to no others.
const handle = db.handle(usersTables);
const everybody = await handle.select().from(users);
console.log(`${everybody.length} users`);

// Both writes commit together, or neither does. Only what goes through `tx` is in it.
await db.tx(async (tx) => {
  await tx.execute(sql`insert into audit (event) values ('the roll was read')`);
  await tx.execute(sql`update counters set reads = reads + 1`);
});

await db.stop();
```

## Type Aliases

### ChannelListener

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> ChannelListener</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  connected</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  lost</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">error</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  notified</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">payload</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

What `listen` reports.

`notified` is the point of it. The other two are about the connection underneath, and a caller
has to care: PostgreSQL queues nothing for a listener that is not connected. Whatever was sent
while the connection was down is gone, and no gap is visible in what does arrive.

#### Methods

##### connected()?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">connected</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The registration is in place: once on the first connection, and again after every loss.

A reconnection is exactly where a notification goes missing, so a caller that cannot afford to
miss one does its own catching-up from here.

###### Returns

`void`

##### lost()?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">lost</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">error</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The connection was lost, or an attempt to open one failed. Another attempt follows.

###### Parameters

###### error

`unknown`

###### Returns

`void`

##### notified()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">notified</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">payload</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

A notification arrived. `payload` is `NOTIFY`'s, and is empty when it carried none.

###### Parameters

###### payload

`string`

###### Returns

`void`

***

### Db

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Db</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.gateway.html#component" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Component</span></a><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> &#x26;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  handle</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> &#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">schema</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#handle" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Handle</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  listen</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">channel</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">listener</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#channellistener" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ChannelListener</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#listening" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Listening</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  start</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  stop</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  tx</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> &#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">T</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>(</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">body</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">tx</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#transaction" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Transaction</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">T</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">T</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

The one PostgreSQL client in a Gateway: the pool, a schema-typed handle per component,
transactions, and `LISTEN` registrations.

**No migrations, and no DDL of any kind.** Nothing here creates a schema, applies a change or
tracks what was applied. The Operator re-exports the components they run into one barrel and
pushes it with their own `drizzle-kit` before the Gateway starts.

#### Type Declaration

##### handle()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">handle</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">schema</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#handle" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Handle</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">listen</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">channel</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">listener</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#channellistener" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ChannelListener</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#listening" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Listening</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">start</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

Opens the pool, and nothing else.

Eager, so a URL nothing answers on fails here, named as the Db, rather than at whichever query
came first. Nothing about the schema is looked at: a database behind the code starts cleanly
and raises a raw PostgreSQL error at its first query.

###### Returns

`Promise`\<`void`\>

##### stop()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">stop</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

Closes the pool and every connection `listen` opened.

The listening connections are included because they are the Db's own. One left connected keeps
the process alive and its database undroppable.

###### Returns

`Promise`\<`void`\>

##### tx()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">tx</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">T</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>(</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">body</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">tx</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#transaction" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Transaction</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">T</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">T</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

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

### Handle

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Handle</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">> </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgDatabase</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">PgQueryResultHKT</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

#### Type Parameters

##### TSchema

`TSchema` *extends* `Record`\<`string`, `unknown`\> = `Record`\<`string`, `never`\>

***

### Listening

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Listening</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  close</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

#### Methods

##### close()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">close</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

Stops listening and closes the connection. Idempotent, and safe to call while a reconnection is
pending.

###### Returns

`Promise`\<`void`\>

***

### Transaction

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Transaction</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgTransaction</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">PgQueryResultHKT</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Record</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">never</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>, </span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">ExtractTablesWithRelations</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Record</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">never</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>>>;</span></span></code></pre></div>

What `tx` hands its callback: a [Handle](#handle), plus `rollback()`.

`rollback()` throws `TransactionRollbackError` rather than returning, so code that uses it as
control flow has to catch and then filter for it.

## Functions

### openDb()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">function</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> openDb</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">url</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#db" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Db</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

Opens the Db on a PostgreSQL connection URL, such as `postgres://user:pass@host:5432/db`.

Synchronous, and nothing is on the wire yet: the pool opens its first connection when something
is asked of it, which is what lets every component be constructed before the database has to be
there. `start` is what opens the pool deliberately.

#### Parameters

##### url

`string`

#### Returns

[`Db`](#db)
