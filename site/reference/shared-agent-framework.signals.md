# shared-agent-framework/signals

The Signal Worker owns the Signal queue, Signal Handler dispatch and Run execution. A Signal is
something that arrived and may make the agent act, emitted by a Producer, which is anything
inside the Gateway trusted to write one. A Run is one execution of the agent over one Prompt. The
Worker claims Signals in the order they arrived and runs one Run at a time, whatever Session that
Run is in.

Most deployments meet this subpath as a vocabulary rather than as a constructor.
[SignalHandler](#signalhandler) is what an Operator writes, and it is the framework's primary extension
point in the way an endpoint handler is a web framework's: it takes a [Signal](#signal) and answers
with [Prompt](#prompt)s, and [SignalHandlers](#signalhandlers) is the map from a `kind` to one of them.
[Runtime](#runtime) is the other seam, the single method an Agent Implementation is driven through.
[createSignalWorker](#createsignalworker) builds the Worker itself, and [SignalWorker](#signalworker) is what comes back.
Its programmatic API is `emit`, which a Producer writes a Signal through.

[templateHandler](#templatehandler) is a Handler most deployments start from rather than writing
[SignalHandler](#signalhandler) by hand: it renders one Prompt per Signal from a Handlebars file, and
[TemplateHandlerOptions](#templatehandleroptions) is where the file, the Session and the values it substitutes are
stated. It is an ordinary Handler built by an ordinary function, so a deployment that outgrows it
returns one of its own from the same place and unwires nothing.

`createGateway` builds a Worker already, so reach for the constructor only when you assemble a
Gateway by hand. Either way the Handler map is a construction option, so a Handler that emits
back into the same Worker is built after the Worker and assigned in.

The two tables are here beside the constructor, for the schema an Operator generates their
migrations from. They reference no other component's table, so that schema can carry them alone.

## Example

A Signal Handler, and a Producer that emits into it.
```ts
import type { Db } from "shared-agent-framework/db";
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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> EmittedSignal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> kind</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> payload</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

What a Producer hands to [SignalWorker](#signalworker)'s `emit`.

#### Properties

##### kind

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> kind</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

Selects exactly one Signal Handler, and is the whole of what dispatch looks at.

One `kind` never reaches two Handlers. Fanning out is one Handler answering with several
Prompts, so there is no second mechanism for it here.

##### payload

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> payload</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

Arbitrary JSON, taken as fact and never interpreted.

The Signal Worker believes whatever a Producer writes, including any claim about who the Signal
came from. That is why a Producer is a part of the Gateway rather than a peer outside it, and
why attribution is a term in a Producer's payload contract rather than a column here.

***

### PostOutcome

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PostOutcome</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> failed</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> boolean</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

What the post phase is told about the Signal it is closing out.

`failed` is true if any Run failed, and true as well if `handle` threw before there were any, so
it says the Signal came to nothing rather than that the agent ran and came back unhappy.

#### Properties

##### failed

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> failed</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> boolean</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

***

### Prompt

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Prompt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> session</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> text</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> session</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### text

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> text</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

***

### RunOutcome

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> RunOutcome</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  |</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">      readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> ok</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> true</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">    }</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  |</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">      readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> error</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">      readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> ok</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> false</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">    };</span></span></code></pre></div>

How a Run ended, and the whole of what a Runtime reports.

It carries none of the agent's output. Nothing in the framework reads what the agent said: the
Agent Implementation keeps its own Session files, and the agent records anything it wants kept
through the Agent server or the Workspace.

A failure carries a message because that message is what [RunRecord](#runrecord)'s `error` holds and
what every later read of the Run answers with. Nothing parses it, so it is written for a person.

***

### RunPrompt

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> RunPrompt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Omit</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><a href="#prompt" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Prompt</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"session"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">> </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">&#x26;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> session</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

The Prompt as a Runtime receives it: what a Handler wrote, with the Session resolved.

Two types rather than one nullable one. The `null` a Handler may write is a request for a fresh
Session rather than a value, and the Signal Worker answers it before any Runtime is called,
naming that Session after the Run it belongs to. So there is no fresh-Session case to handle
here, no naming convention for a Runtime to invent, and every Run records the name it really ran
under.

#### Type Declaration

##### session

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> session</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

***

### RunRecord

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> RunRecord</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> endedAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> error</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> id</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> prompt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> session</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> signalId</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> startedAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> state</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#runstate" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">RunState</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

A Run as the agent reads it: one Prompt, in one Session, and how it went.

`signalId` is the Signal whose Handler wrote the Prompt, and `prompt` is the text the agent was
given rather than the template it came from. `session` is a plain name and a reference to
nothing. Every Run the Worker records now carries one, and it stays nullable because rows written
before that still hold `null`.

The timings are ISO 8601 strings, or `null` for a Run that has not reached that point, so a
`running` Run has a `startedAt` and no `endedAt`.

#### Properties

##### endedAt

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> endedAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### error

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> error</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### id

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> id</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### prompt

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> prompt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### session

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> session</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### signalId

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> signalId</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### startedAt

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> startedAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### state

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> state</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#runstate" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">RunState</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

***

### RunState

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> RunState</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> typeof</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> </span><a href="#runstates" class="saf-signature-link"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">runStates</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">[number];</span></span></code></pre></div>

***

### Runtime

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Runtime</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  run</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">prompt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#runprompt" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">RunPrompt</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><a href="#runoutcome" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">RunOutcome</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">run</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">prompt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#runprompt" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">RunPrompt</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><a href="#runoutcome" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">RunOutcome</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

###### Parameters

###### prompt

[`RunPrompt`](#runprompt)

###### Returns

`Promise`\<[`RunOutcome`](#runoutcome)\>

***

### Signal

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Signal</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">> </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> emittedAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Date</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> id</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> kind</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> payload</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> emittedAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Date</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### id

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> id</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### kind

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> kind</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### payload

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> payload</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

***

### SignalHandler

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> SignalHandler</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">> </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  handle</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signal" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Signal</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> readonly</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#prompt" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Prompt</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">[] </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">|</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#prompt" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Prompt</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">[]>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  post</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signal" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Signal</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">outcome</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#postoutcome" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">PostOutcome</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> void</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">handle</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signal" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Signal</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> readonly</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#prompt" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Prompt</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">[] </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">|</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#prompt" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Prompt</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">[]>;</span></span></code></pre></div>

###### Parameters

###### signal

[`Signal`](#signal)\<`TPayload`\>

###### Returns

  \| readonly [`Prompt`](#prompt)[]
  \| `Promise`\<readonly [`Prompt`](#prompt)[]\>

##### post()?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">post</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signal" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Signal</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">outcome</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#postoutcome" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">PostOutcome</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> void</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

###### Parameters

###### signal

[`Signal`](#signal)\<`TPayload`\>

###### outcome

[`PostOutcome`](#postoutcome)

###### Returns

`void` \| `Promise`\<`void`\>

***

### SignalHandlers

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> SignalHandlers</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Readonly</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Record</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><a href="#signalhandler" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignalHandler</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>>;</span></span></code></pre></div>

The `kind`-to-Handler map: what a Gateway can act on, and the whole of it.

A Signal whose `kind` is not a key here fails permanently. There is no Handler to run a post
phase, and nothing re-runs it, so a typo in a `kind` is loud and one-way rather than silent.

***

### SignalRecord

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> SignalRecord</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> emittedAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> error</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> id</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> kind</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> payload</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> state</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signalstate" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignalState</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

A Signal as the agent reads it, and the JSON two of these routes answer with.

The `payload` arrives as the Producer wrote it, and `emittedAt` as an ISO 8601 string, JSON
having no date.

`state` and `error` are here, where [Signal](#signal) has neither: what there is to know about a
prior arrival is mostly how it ended, and since a failed Signal is failed for good, the reason
has to be readable by whoever finds it.

#### Properties

##### emittedAt

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> emittedAt</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### error

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> error</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### id

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> id</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### kind

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> kind</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### payload

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> payload</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### state

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> state</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signalstate" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignalState</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

***

### SignalState

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> SignalState</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> typeof</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> </span><a href="#signalstates" class="saf-signature-link"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">signalStates</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">[number];</span></span></code></pre></div>

***

### SignalWorker

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> SignalWorker</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.gateway.html#component" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Component</span></a><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> &#x26;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> agentRoutes</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyPluginAsync</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  emit</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> &#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">tx</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.db.html#handle" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Handle</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#emittedsignal" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">EmittedSignal</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  start</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">  stop</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> () </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> agentRoutes</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyPluginAsync</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The Agent server routes, as a Fastify plugin to register yourself.

Register it under a prefix of your own, or inside your own encapsulated plugin, or behind a
hook you share with your own routes. Passing no server and never registering this is how the
group is switched off.

The routes read these two tables and no other component's, and the whole surface is read-only
and unscoped: every Signal and every Run, whatever Session the reading Run is in.

##### emit()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">emit</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">tx</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.db.html#handle" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Handle</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#emittedsignal" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">EmittedSignal</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

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

[`Handle`](shared-agent-framework.db.md#handle)\<`TSchema`\>

###### signal

[`EmittedSignal`](#emittedsignal)

###### Returns

`Promise`\<`string`\>

##### start()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">start</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

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

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">stop</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">()</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">void</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

Stops looking for Signals and waits for the Run in flight to finish.

Not a shutdown protocol: the framework installs no `SIGTERM` handling of its own. There is no
cancellation either. The Run in flight runs to completion, because abandoning it would leave
partial effects nothing retries, so this takes as long as the slowest Run the agent can have
started.

Whatever is still pending stays pending, for the next worker over this database to drain.

###### Returns

`Promise`\<`void`\>

***

### SignalWorkerOptions

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> SignalWorkerOptions</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> =</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> agentServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">    readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">  };</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> db</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.db.html#db" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Db</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> handlers</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signalhandlers" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignalHandlers</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> logger</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.logging.html#logger" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Logger</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> runtime</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#runtime" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Runtime</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> sweepIntervalMs</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> number</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

#### Properties

##### agentServer?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> agentServer</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

The Agent server, if the agent is to read prior Signals and Runs.

Given one, the constructor registers `agentRoutes` on its Fastify instance at no prefix:
`/signals`, `/signals/:id`, `/runs` and `/runs/:id`. Omit it and nothing is registered
anywhere, which is how the group is switched off.

Structural: anything carrying a Fastify instance satisfies it. A server built on http2 does
not, and takes the `agentRoutes` plugin instead.

###### fastify

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> fastify</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> FastifyInstance</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### db

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> db</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.db.html#db" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Db</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

##### handlers

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> handlers</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signalhandlers" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignalHandlers</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The `kind`-to-Handler map: what this Gateway can act on, and the whole of it.

A construction option rather than an argument to `start`, so a Signal Worker with no Handlers
is unconstructable rather than merely unstartable.

Held rather than copied. The Worker looks a `kind` up in this same object at dispatch, so an
entry written into it before `start` is dispatched on, and that is the way out of the knot a
Handler that emits back into this Worker ties: it cannot close over an object that does not
exist yet, so it is built after construction and assigned in.

##### logger?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> logger</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="./shared-agent-framework.logging.html#logger" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Logger</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

Defaults to a `pino` instance on stdout.

One info line as each Signal is claimed and as it finishes, one as each Run starts and ends
carrying the Session it ran in, and a debug line for every wakeup saying what caused it. A
Signal Handler's failure and a Run's are logged at error whether or not anything else notices
them, and a Signal a stopped worker left behind at warn. No Prompt text and no payload is ever
written.

##### runtime

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> runtime</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#runtime" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Runtime</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

What a Prompt is handed to. `createPiRuntime`, on `shared-agent-framework/pi`, builds the one
this framework ships.

##### sweepIntervalMs?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> sweepIntervalMs</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> number</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

How often the worker looks for pending Signals regardless of notifications, in milliseconds.
Defaults to 5000.

Not the latency of a Signal: emitting one wakes the worker at once. This is the safety net for
a notification sent while the listening connection was down, so what the number bounds is how
long a Signal can sit unnoticed after a database restart. There is no correctness in it, and
the cost of lowering it is a query per interval forever.

***

### TemplateHandlerOptions

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">type</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> TemplateHandlerOptions</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">> </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> data</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signal" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Signal</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> helpers</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Readonly</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Record</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Handlebars</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">.</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">HelperDelegate</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>>;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> partials</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Readonly</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Record</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>>;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> session</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signal" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Signal</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">  readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> template</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> URL</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

#### Type Parameters

##### TPayload

`TPayload` = `unknown`

#### Properties

##### data

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> data</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signal" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Signal</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> unknown</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The values the template substitutes. A name the template references and this does not supply
fails the Signal rather than rendering as nothing.

A returned Promise is awaited, so this can be `async`, and it is where a Handler reads what the
Prompt needs: the Message log, the Workspace, or tables of your own.

###### Parameters

###### signal

[`Signal`](#signal)\<`TPayload`\>

###### Returns

`unknown`

##### helpers?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> helpers</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Readonly</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Record</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Handlebars</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">.</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">HelperDelegate</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>>;</span></span></code></pre></div>

Handlebars helpers, registered on an environment belonging to this Handler alone. Another
Handler built by another call cannot see them, and neither can the shared `Handlebars`
instance. What a helper returns is substituted unescaped, like everything else.

##### partials?

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> partials</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">?:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Readonly</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Record</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>>;</span></span></code></pre></div>

Handlebars partials, as template source rather than as templates already compiled.

They are compiled here with the same options as the template itself, so `noEscape` and `strict`
hold inside them too.

##### session

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> session</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> (</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signal</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signal" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">Signal</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">=></span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> Promise</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> null</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

Which Session this Signal's Prompt continues, or `null` to ask for a fresh one.

The topology is yours: one Session per User, one per Run, or one for the whole agent. A
returned Promise is awaited.

###### Parameters

###### signal

[`Signal`](#signal)\<`TPayload`\>

###### Returns

`string` \| `null` \| `Promise`\<`string` \| `null`\>

##### template

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">readonly</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70"> template</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> string</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> |</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> URL</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

The Handlebars file, as a path or a `file:` URL, read and compiled again for every Prompt.
Edit the wording and the next Signal renders through it, with no restart.

A relative path resolves against the process's working directory. For a template beside the
module that names it, write `new URL("./prompt.hbs", import.meta.url)`.

It is compiled with `noEscape`, so nothing substituted is HTML-escaped, and with `strict`,
which fails the Signal on a variable `data` did not supply. `strict` also disables inverse
sections: a caret block such as `^absent` throws, and the `unless` helper is what to write in
its place. The `if`, `each` and `else` helpers behave as usual.

## Variables

### runs

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> runs</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgTableWithColumns</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;{}>;</span></span></code></pre></div>

One Prompt executed in one Session, and the Worker's record of its own work.

`session` is a plain name and not a foreign key. Sessions belong to the Agent Implementation, and
what is kept here is the name the Prompt was routed to. The Worker always writes one, a fresh
Session included, naming that one after the Run. The column stays nullable because rows written
before it did that still hold `null`.

***

### runStates

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> runStates</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> readonly</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> [</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"pending"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"running"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"done"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"failed"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">];</span></span></code></pre></div>

A Run's state. There is no `timed_out`, the framework imposing no timeout on a Run or on anything
else, so a Run that never ends stays `running` and holds the queue.

***

### signals

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> signals</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgTableWithColumns</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;{}>;</span></span></code></pre></div>

An arrival record, written by a Producer and immutable but for `state` and `error`.

Nothing deletes one. A Signal a Handler declined leaves a row behind exactly as a Signal that ran
does, which is what makes a refusal auditable afterwards.

***

### signalStates

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> signalStates</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583"> readonly</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> [</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"pending"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"processing"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"done"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">, </span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"failed"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">];</span></span></code></pre></div>

A Signal's processing state. One-way: nothing returns to `pending`, and a failed Signal is never
re-run, so `error` is the whole of what became of it.

***

### workerSchema

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> workerSchema</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgSchema</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF">"saf_signals"</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

The PostgreSQL schema both tables below live in, `saf_signals`, named for its subject rather than
for the Component.

Prefixed because the framework is installed into a database it does not own, where a bare
`signals` is a plausible name for something an Operator already has. Not configurable: the tables
are compiled against this object, and the same object is what a generation reads.

***

### workerTables

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF"> workerTables</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8"> {</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  runs</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgTableWithColumns</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;{}>;</span></span>
<span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">  signals</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgTableWithColumns</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;{}>;</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">};</span></span></code></pre></div>

#### Type Declaration

##### runs

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">runs</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgTableWithColumns</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;{}>;</span></span></code></pre></div>

One Prompt executed in one Session, and the Worker's record of its own work.

`session` is a plain name and not a foreign key. Sessions belong to the Agent Implementation, and
what is kept here is the name the Prompt was routed to. The Worker always writes one, a fresh
Session included, naming that one after the Run. The column stays nullable because rows written
before it did that still hold `null`.

##### signals

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">signals</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> PgTableWithColumns</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;{}>;</span></span></code></pre></div>

An arrival record, written by a Producer and immutable but for `state` and `error`.

Nothing deletes one. A Signal a Handler declined leaves a row behind exactly as a Signal that ran
does, which is what makes a refusal auditable afterwards.

## Functions

### createSignalWorker()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">function</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> createSignalWorker</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">options</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signalworkeroptions" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignalWorkerOptions</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signalworker" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignalWorker</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">;</span></span></code></pre></div>

Builds a Signal Worker over a Db, a Runtime and a map of Signal Handlers, and registers the read
routes on the Agent server if one was passed.

`createGateway` builds a Worker already. Reach for this only when assembling a Gateway by hand
with `createBareGateway`.

#### Parameters

##### options

[`SignalWorkerOptions`](#signalworkeroptions)

#### Returns

[`SignalWorker`](#signalworker)

***

### templateHandler()

<div class="language-ts vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">ts</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0" v-pre=""><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">function</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> templateHandler</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>(</span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70">options</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#templatehandleroptions" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TemplateHandlerOptions</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>)</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">:</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0"> </span><a href="#signalhandler" class="saf-signature-link"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">SignalHandler</span></a><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">&#x3C;</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0">TPayload</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">>;</span></span></code></pre></div>

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

[`SignalHandler`](#signalhandler)\<`TPayload`\>
