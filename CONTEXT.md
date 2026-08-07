# Shared Agent Framework

A framework for building AI agents that serve several parties at once, where no single party may control the agent or reach it privately.

## Components

**Shared Agent**:
An AI agent that acts for more than one party at the same time and is controlled by none of them individually.
_Avoid_: multi-tenant agent, group agent, bot

**Party**:
One of the entities a Shared Agent belongs to. Explains why this framework exists, and has no operational role: parties hold no privileges over the agent and are not represented in the data model. See [ADR-0008](./docs/adr/0008-party-is-not-in-the-data-model.md).
_Avoid_: owner, tenant, stakeholder, principal

**Operator**:
Whoever runs and configures a Shared Agent. Trusted by every Party: holds the agent's configuration, writes its Signal Handlers, and has the only direct access to the Agent Implementation. See [ADR-0001](./docs/adr/0001-the-gateway-is-trusted.md).
_Avoid_: builder, host, admin, provider, owner, integrator, implementor

**Developer**:
The coding half of an Operator: whoever writes the entry point, the Signal Handlers and the Prompt templates against the framework's public API. Not a separate party or a separate trust level, and never a role in the data model. The word exists because the API reference is written for exactly this reader, where the rest of an Operator's job (holding the signing key, running the stack, owning the database) is not what an API reference speaks to. See [ADR-0047](./docs/adr/0047-a-component-is-one-subpath.md).
_Avoid_: user, consumer, integrator, client

**Gateway**:
The trusted application that mediates every interaction into and out of a Shared Agent. One deployable, and now a thing rather than only an assembly: a record of Components, started in the order of its keys and stopped in the reverse of it, and structurally a Component itself. It is still not a registry and not a plugin host, since it resolves nothing, injects nothing and cannot say what depends on what. The Operator's entry point still constructs and still holds. `createGateway` builds the irreducible infrastructure a deployment using our parts always needs (the Db, both self-describing servers and the Signal Worker) and hands it to the Operator's `extend`, where the opinionated parts (Users, Signatures, Decisions, the Messenger and its one Channel) are constructed by hand, each a one-liner, and only the ones a deployment wants. `createBareGateway` takes a record of anything. See [ADR-0037](./docs/adr/0037-the-gateway-is-a-record-of-components.md), [ADR-0045](./docs/adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md) and [ADR-0020](./docs/adr/0020-producers-are-trusted-components-of-the-gateway.md).
_Avoid_: proxy, broker, shield, warden, sidecar

**Component**:
An entry in the Gateway's record: a `start`, a `stop`, and nothing else. **Not only things that run.** Users, the Messenger, the HTTP Channel, Signatures and Decisions have no work at either end and are Components anyway, because the record is the Gateway's directory of its own parts, and membership is what gives one a position before it needs one. Signatures and the HTTP Channel go further and have no tables either, which changes nothing: they are entries in the record like the rest. Both methods stay required, since with no `name` beside them a Component whose methods were optional would be the empty type. Not a plugin contract: nothing declares dependencies, routes or tables to the framework. See [ADR-0037](./docs/adr/0037-the-gateway-is-a-record-of-components.md), [ADR-0031](./docs/adr/0031-parts-that-run-are-components.md) and [ADR-0032](./docs/adr/0032-components-wire-themselves-at-construction.md).
_Avoid_: service, plugin, module, extension

**Signal Worker**:
The Component that owns the Signal queue, Signal Handler dispatch, Run execution, and the Agent server routes for Signals and Runs. Holds no identity and knows nothing about messaging. One Signal at a time, globally, which is what "worker" is there to say. Formerly the **Core**, the name every ADR up to [ADR-0030](./docs/adr/0030-passwords-are-traded-for-bearer-tokens.md) uses. See [ADR-0012](./docs/adr/0012-the-gateway-is-a-serial-signal-worker.md).
_Avoid_: core, engine, kernel, runner, signal processor, prompt worker

**Producer**:
Anything inside the Gateway that emits Signals into the Signal Worker's queue. A **role**, not a kind of thing: the Messenger and the Scheduler are Producers, and so is a loop the Operator writes. A Channel is **not** one, despite being where an inbound Message comes from: it hands the Message to the Messenger, which is what writes the Signal. Privileged, in that whatever it writes into a payload the Signal Worker takes as fact.
_Avoid_: source, ingress, adapter, connector

**Public server**:
The HTTP server exposed outside the Gateway. Named for its exposure rather than its audience, because some of its routes serve no authenticated User. Users reach the Users component and the HTTP Channel through it, and reach nothing else. A Channel that is not HTTP does not appear on it at all: the Nostr Channel's inbound edge is a Relay subscription, not a route.
_Avoid_: user server, external API, frontend

**Agent server**:
The HTTP server only the Agent Implementation reaches, carrying the Signal Worker's Signal and Run routes plus whatever Producers expose to the agent. A mediation point, not a security boundary against the agent. See [ADR-0010](./docs/adr/0010-the-agent-reaches-the-gateway-over-http.md).
_Avoid_: internal API, private server, control plane

**Db**:
The Component everything else reaches PostgreSQL through: the pool, the schema-typed handle each one queries on, transactions and `LISTEN` registrations, and nothing else. Reached at `gateway.components.db`, like every other Component. **It applies no DDL and verifies none.** It once carried `migrate` and `registerMigrations` beside `start` and `stop`; migration ownership moved to the Operator, who assembles the parts they run into a barrel and applies it with their own `drizzle-kit`, so `db.start()` opens the pool and says nothing about what tables are there ([ADR-0046](./docs/adr/0046-the-operator-owns-migrations.md), superseding that half of [ADR-0032](./docs/adr/0032-components-wire-themselves-at-construction.md)). The agent cannot touch it directly, only through the Agent server. Contrast the Workspace, which the agent reads and writes as files. Formerly the **Store**, which named the persistent state rather than the client, and persistent state has no lifecycle to start and stop. See [ADR-0022](./docs/adr/0022-the-store-is-postgresql-through-drizzle.md).
_Avoid_: store, datastore, persistence layer, repository

**Messenger**:
The Producer that owns the Message log: it records a Message in either direction, emits a Signal from an inbound one in the same transaction, holds the log the agent writes into and both sides read, and carries the agent's own routes on the Agent server. **It reaches nobody.** Getting a Message to a person is a Channel's job, and the Messenger knows only the one registered with it. It owns neither Users nor their authentication, being constructed with Users. The content is a `text` string, the Signal `kind` is fixed, and the log is one per User across both directions: three of the four freedoms [ADR-0034](./docs/adr/0034-the-http-messenger-is-an-opinionated-messenger.md) declined, moved up here from the part that declined them. A Component with a `start` and a `stop` that do nothing, keyed ahead of the Signal Worker so that it outlives the drain, because that is when a Signal Handler's post phase sends its failure notice. **The name was held in reserve and is now spent**: it was the designed name from [ADR-0007](./docs/adr/0007-messages-carry-arbitrary-json-payloads.md) onwards, and the qualifier on the HTTP Channel was the price paid up front for a peer that turned out to be a Channel rather than a second Producer. See [ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md), [ADR-0029](./docs/adr/0029-users-are-a-part-of-their-own.md) and [ADR-0036](./docs/adr/0036-the-http-messengers-user-id-is-a-foreign-key.md).
_Avoid_: HTTP Messenger, message server, chat server, inbox service, message bus

**Channel**:
What reaches one person over one medium: the other half of messaging, and the Messenger's only outward edge. A `name`, a `send` the Messenger calls inside the caller's transaction, and a lifecycle. Nothing else, so it is no more a plugin contract than a Component is ([ADR-0021](./docs/adr/0021-the-framework-has-no-plugin-system.md), [ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). It registers itself with the Messenger at construction and gets back a handle, which is the only way an inbound Message can be written, so no other code can write one and no Channel can claim to be another. **One per Messenger**, refused at registration rather than documented: which is why nothing yet records which Channel a Message travelled by, and why a deployment runs HTTP or Nostr and not both. Never a **Transport**: see Rejected. A PostgreSQL notification channel is always written as that, never as an unqualified Channel, the way a process signal is always `SIGTERM`.
_Avoid_: Transport, adapter, connector, provider, driver, bridge

**HTTP Channel**:
The Channel that serves Users over the Public server: a submission, and a cursored read of their own log. Named for its medium now that the freedoms it used to be named for belong to the Messenger. **It owns no tables and does nothing at either end**, and its `send` is a no-op, because HTTP delivery is the User asking ([ADR-0035](./docs/adr/0035-a-users-messages-are-one-log-read-by-cursor.md)). The second Component with no schema, after Signatures. Formerly the **HTTP Messenger**, which held the log as well, and the name every ADR up to [ADR-0047](./docs/adr/0047-a-component-is-one-subpath.md) uses.
_Avoid_: HTTP Messenger, web channel, REST channel, polling API

**Nostr Channel**:
The Channel that exchanges NIP-17 private direct messages with Users over one Relay the Operator runs. It holds the Shared Agent's Nostr identity, the Relay connection, and three tables of its own and no share of anyone else's — which public key is which User, which envelopes it has already read, and which replies the Relay has not taken yet — so messaging and authentication stay fully separate. The first Channel with real work at either end, and the first part of the framework holding a long-lived connection it opened itself to something other than the Db. **It admits nobody**: a public key with no User is dropped and nothing is stored, because Users are preregistered. It announces exactly one thing about itself, a **Relay list**, and no profile. It is also the first component with no entry in the reference deployment, one Channel per Messenger meaning the example keeps HTTP. See [ADR-0049](./docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md) and [ADR-0050](./docs/adr/0050-the-shared-agent-has-a-nostr-identity-too.md).
_Avoid_: Nostr Messenger, Nostr transport, relay client, DM bridge, npub adapter

**Users**:
The component that owns Users and their credentials — management on the Agent server, authentication on the Public server. It hashes passwords with scrypt, issues Tokens and revokes them, sets Attributes and replaces credentials. Not a Producer: it emits no Signals and holds no reference to the Signal Worker. A Component all the same, with a `start` and a `stop` that do nothing, because the Gateway's record holds every part and not only the ones that run ([ADR-0037](./docs/adr/0037-the-gateway-is-a-record-of-components.md)). Write "the Users component" wherever the bare plural could be read as the people. **Two former names, and the history is the entry's value.** It was the **User Directory** first, the name [ADR-0029](./docs/adr/0029-users-are-a-part-of-their-own.md) was recorded under and every document used until the first rename swept them; that ADR's argument did not change, only the word. "Directory" was two words at once here, and the other one is a path the agent writes into: `agentDir`, `PI_CODING_AGENT_DIR`, and [ADR-0025](./docs/adr/0025-the-pi-adapter-spawns-one-confined-process-per-run.md) and [ADR-0028](./docs/adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md) throughout. It also undersold a part that mostly writes, a directory being somewhere you look things up. It became the **User Manager** on this argument: **"Manager" was the vaguest word in this glossary, and it was taken knowing that**, since the other entries name what a thing is or does (a Signal Worker works Signals, a Mount Table is a table of mounts) where "manager" names a department, so it was declared the exception and not a precedent for the next entry. **User Registry** was the considered alternative and was dropped because it names registration, which is the one thing this part does not do (ADR-0029 keeps self-registration a Signal), and covers issuing and revoking no better than "Directory" did. The deciding argument was that "manager" is what this part reads as to the people who use it, so it was not a wart for a later reader to fix. No public name moved with that rename: `createUsers`, the `Users` type, the `saf_users` schema and the `shared-agent-framework/users` subpath were untouched — as was `usersMigrations`, which has since gone with the migration subsystem, its tables now reached on that same `shared-agent-framework/users` subpath beside `createUsers` ([ADR-0046](./docs/adr/0046-the-operator-owns-migrations.md), [ADR-0047](./docs/adr/0047-a-component-is-one-subpath.md)). **That last sentence is why the wart was fixed after all**, and [ADR-0044](./docs/adr/0044-components-are-named-for-what-they-own.md) renamed the component to **Users**: every identifier a consumer touches already said so and only the prose said Manager. **The rename has landed.** These documents, the doc comments, the OpenAPI descriptions and the test names all say Users now, and again no identifier moved, because there was none left to move. The ADRs keep the word they were written with, a dated record being wrong to rewrite. See [ADR-0029](./docs/adr/0029-users-are-a-part-of-their-own.md) and [ADR-0030](./docs/adr/0030-passwords-are-traded-for-bearer-tokens.md).
_Avoid_: User Manager, User Directory, User Registry, auth service, identity provider, IdP, user store, account system, user module

**Signatures**:
The Component that holds the Shared Agent's Signing identity, and **only that one** now that a Nostr Channel holds a Nostr identity it could not use, and makes Signed Statements with it — signing on the Agent server, verification and the public key on the Public server. **Stores nothing**, so its subpath carries a constructor and nothing beside it ([ADR-0047](./docs/adr/0047-a-component-is-one-subpath.md)); it was the only Component of which that was true until the HTTP Channel lost its tables to the Messenger. Not a Producer: it emits no Signals. Named for what it owns rather than as a *Signer*, which named one of its three routes ([ADR-0044](./docs/adr/0044-components-are-named-for-what-they-own.md)). See [ADR-0041](./docs/adr/0041-the-shared-agent-has-a-signing-identity.md) and [ADR-0042](./docs/adr/0042-a-signature-is-a-compact-jws.md).
_Avoid_: Signer, Notary, Attestor, Seal, signing service, key manager, KMS

**Decisions**:
The Component that owns the one global log of Decisions: it accepts the agent's statement, has Signatures sign it, numbers it and keeps it, and answers reads from the agent and from any authenticated User. Not a Producer — publishing emits no Signal, because a Decision is published *during* a Run and the worker is serial. Holds no Users and references none, so unlike the Messenger it imposes no construction order on the Users component. See [ADR-0043](./docs/adr/0043-decisions-are-one-global-log.md).
_Avoid_: Decision Log, Decision Registry, Decision Manager, ledger, bulletin, minutes

**Scheduler**:
The Producer that owns Schedules: recurrence, one-shots, cancellation, next-fire computation, and time zones. It emits a Signal when a Schedule matures, and serves two creators of one shared model: the agent, through an API on the Agent server that both creates and manages Schedules, and the Operator, through a programmatic interface in code. Every matured Schedule emits the same fixed Signal `kind`, `scheduleFiredKind`, carrying the creator's opaque data beside the fire's metadata, so the Scheduler is a timer in front of the ordinary Signal dispatch and adds no new Handler concept. The agent's route is disableable, and that switch is the only guard on it: a self-waking agent can loop the single serial lane (ADR-0018), and since the model has no per-creator scoping, the same switch is what keeps a prompt-injectable agent (ADR-0003) away from the Operator's Schedules. Opted into by the deployment like the Messenger rather than built by default (ADR-0045). See [ADR-0018](./docs/adr/0018-scheduling-is-a-separate-component.md).
_Avoid_: cron, timer, job queue

**Agent Implementation**:
The interchangeable agent program at the centre of the architecture. `pi` is the primary target; `openclaw` is the reference alternative. Formerly the **Agent Runtime**, the name ADR-0005 was recorded under and every ADR up to [ADR-0032](./docs/adr/0032-components-wire-themselves-at-construction.md) used before the rename swept them. Renamed because "runtime" had come to mean three things at once, and this was the weakest of the three claims on it: `pi` is a program, and the word was wanted for what actually runs one. See [ADR-0005](./docs/adr/0005-pi-is-the-primary-agent-runtime.md) and [ADR-0033](./docs/adr/0033-an-agent-is-a-container-and-one-function.md).
_Avoid_: agent runtime, engine, backend, model, LLM

**Runtime**:
What the Signal Worker hands a Prompt to and gets an outcome back from, and the narrowest interface in the framework: one method. A construction option of the Worker's rather than a Component, and after [ADR-0037](./docs/adr/0037-the-gateway-is-a-record-of-components.md) close to the only thing in the Gateway's design that is neither. It carries none of the Agent Implementation's own configuration, because what that reads on disk is the Operator's to place where it will look. Named for the Worker's own field, which has always been `runtime`. Formerly the **Runtime Adapter**; "adapter" is gone, since there is no longer a second kind of thing for it to adapt between. See [ADR-0016](./docs/adr/0016-agent-configuration-is-opaque-to-the-framework.md) and [ADR-0033](./docs/adr/0033-an-agent-is-a-container-and-one-function.md).
_Avoid_: runtime adapter, driver, plugin, connector, backend

**Agent Container**:
The declaration of the container one Run happens in: the image, the Mount Table, the networks, the environment, the entry point, and the flags the framework does not model. Inert and agent-agnostic: it creates nothing, checks no path and starts nothing, resolving to container arguments and no more. Only the image is required. See [ADR-0033](./docs/adr/0033-an-agent-is-a-container-and-one-function.md).
_Avoid_: sandbox, box, environment, runtime config, container spec

**Agent Container Runtime**:
The Runtime that runs an Agent Implementation as one fresh container per Run, generic over which one. It owns the whole of the container: the arguments, the confinement, the process, the redaction and the diagnosis of a failure. What an Agent Implementation adds to it is **one function**, which says what to put after the image, what to write on stdin, and how to read what comes back. `createPiRuntime` is that function plus two defaults. See [ADR-0033](./docs/adr/0033-an-agent-is-a-container-and-one-function.md).
_Avoid_: container adapter, executor, launcher, supervisor

**Mount Table**:
The declaration of which directories and files the agent's container sees, and where each one comes from. One entry is a **Mount**. The Workspace is one of them; so is any file the Operator wants the agent to be unable to change. Optional: an image carrying its own configuration and keeping nothing between Runs mounts nothing, and the cost of that is only that no Session survives the container. It used to carry the container's user as well, on the argument that what is shared and who shares it are two halves of one fact; the user is no longer configuration at all. See [ADR-0028](./docs/adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md).
_Avoid_: volume, bind, share, sandbox, mount config

**OpenClaw daemon**:
OpenClaw's own central process, which its own documentation calls "the Gateway". Always written as "the OpenClaw daemon" here — unqualified "Gateway" always means ours.

## Signals and Runs

**Signal**:
Something arriving from outside that may cause the agent to act. Emitted by a Producer, carrying a `kind` and an arbitrary JSON payload. Immutable but for its processing state. A process signal is always written as `SIGTERM` or `SIGINT` here, never as an unqualified "signal": unqualified Signal always means ours, so nothing of ours is ever named `onSignal`.
_Avoid_: trigger, event, request, stimulus

**Signal Handler**:
Arbitrary code, authored by the Operator, that accepts Signals of one `kind` and produces Prompts from them, declaring which Session each Prompt goes to. The framework's primary extension point, in the way an endpoint handler is a web framework's. See [ADR-0006](./docs/adr/0006-session-routing-is-chosen-by-the-signal-handler.md) and [ADR-0009](./docs/adr/0009-signal-handlers-are-arbitrary-code.md).
_Avoid_: trigger, processor, adapter, hook, listener

**Prompt**:
What a Signal Handler produces from a Signal, and the only form in which anything from outside reaches the agent. A Signal may yield none, one, or many. It names the Session it goes to, or writes `null` to ask for a fresh one — and *that* form of it reaches the Handler seam only: the Signal Worker answers the request before calling a Runtime, so a Prompt at the Runtime seam always names a Session and is a type of its own (`RunPrompt`) rather than the same type re-checked. See [ADR-0033](./docs/adr/0033-an-agent-is-a-container-and-one-function.md).

**Post phase**:
The Signal Handler's second entry point, for cleanup. Runs once after all Runs arising from a Signal have finished, receives a flag saying whether one failed, and cannot produce Prompts. See [ADR-0017](./docs/adr/0017-failed-runs-are-not-retried.md).
_Avoid_: post handler, teardown, finalizer, callback

**Session**:
The Agent Implementation's unit of conversational continuity. A Signal Handler routes each Prompt to a fresh or a named Session. Organises context; does not isolate it. A Handler asking for a fresh one is answered by the Signal Worker, which names it after the Run it belongs to before any Runtime sees it. So every Run records the Session it actually used, and no Runtime invents a naming convention of its own.
_Avoid_: chat, conversation, thread, context

**Run**:
One execution of the agent: a single Prompt, in one Session, producing whatever the agent emits.
_Avoid_: turn, job, invocation, task

**Workspace**:
The files and data that Signal Handlers and the agent share, as opposed to the Db, which the agent cannot touch directly. Global to a Shared Agent, not per Session.
_Avoid_: scratch, working directory, shared state

## Identity

Owned by the Users component, not the Signal Worker, not the Messenger and not a Channel.

**User**:
An entity that authenticates against the Users component, and may submit Messages and read their own Message log. Named by an opaque Gateway-issued id, never by email or any other scheme. Nothing removes one. See [ADR-0014](./docs/adr/0014-users-are-opaque-ids-and-authentication-is-pluggable.md) and [ADR-0029](./docs/adr/0029-users-are-a-part-of-their-own.md).
_Avoid_: account, member, client, party

**Attributes**:
Arbitrary JSON carried by a User, defined by the deployment rather than the framework. Where grouping lives, since there is no Party entity — and therefore where authorization lives.
_Avoid_: metadata, profile, claims, roles

**Token**:
What a User presents on every request after trading a password for one. Gateway-issued, always expiring, and revocable. The only request credential the framework has. See [ADR-0030](./docs/adr/0030-passwords-are-traded-for-bearer-tokens.md).
_Avoid_: session, JWT, API key, cookie

## Messaging

Owned by the Messenger, not the Signal Worker and not a Channel.

**Message**:
Something exchanged between the agent and exactly one User, in one direction or the other. Carries a **`text` string**, fixed by the Messenger rather than arbitrary JSON, and a `seq` that numbers it within that one User's log whichever direction it travelled. **Outbound** means agent to User; **inbound** means User to agent, and only a User can cause an inbound one. Never involves two Users, and never a group. Immutable once written, like a Signal, and nothing removes one. **It does not record which Channel it travelled by**, because one Channel per Messenger makes that column constant in every row; the day a second Channel is constructable, the column, the argument to `send` and the name in the Signal payload arrive together. See [ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md), [ADR-0034](./docs/adr/0034-the-http-messenger-is-an-opinionated-messenger.md) and [ADR-0035](./docs/adr/0035-a-users-messages-are-one-log-read-by-cursor.md).
_Avoid_: notification, reply, response, event, DM

**Message log**:
The Messenger's record of every Message in both directions. The **durable** record of what was said, and the reason the Messenger owns it rather than each Channel: a Session is a lossy cache of it, since compaction discards what it holds, and a record split by medium would be a worse record than one. One User's slice of it is a single sequence across both directions, read by cursor: that one read serves a client's first page, its scroll backwards and its poll forwards alike. The agent queries any User's; a User reads only their own. A Relay is never this, whatever it retains. See [ADR-0035](./docs/adr/0035-a-users-messages-are-one-log-read-by-cursor.md).
_Avoid_: history, transcript, archive, outbox

**Relay**:
A Nostr server the Nostr Channel connects to, and in this framework's deployments **one, run by the Operator**. A transport and never a store: nothing in the protocol obliges it to retain anything, and the Message log is the durable record regardless of what it keeps. Users are told which one to point their client at, which is why a single one is an onboarding step here rather than the reachability failure it would be for a public agent — and it is the one this agent's **Relay list** names, since there is only one to name. A Relay that is down is an outage and not a boot failure: nothing the Channel sends it is awaited by `start`. See [ADR-0049](./docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md).
_Avoid_: server, broker, hub, node, message queue

**Relay list**:
The only thing a Shared Agent publishes about itself on Nostr: one replaceable event naming the Relay at which it receives private direct messages, republished at every start of the Nostr Channel. It buys two narrow things and **not discoverability** — it stops a client that refuses to message a public key with no such list, and it steers a compliant sender to the right Relay — because only a client already connected to that Relay can read it, and Users were told which Relay to add out of band. Nothing else is published: no profile, no name, no picture, so the agent appears in a client as a bare public key. A Relay that refuses it is a warning on the log and a Channel that started anyway, so it is never a boot dependency. Not the Message log, not a directory, and not a claim about anything but where to write. See [ADR-0049](./docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md).
_Avoid_: profile, metadata, announcement, advertisement, presence, directory entry

## Scheduling

Owned by the Scheduler.

**Schedule**:
A named, persisted instruction to emit a Signal at one or more future times: either a recurring cron expression or a one-shot instant, in a named time zone. The `name` is its identity in one flat namespace shared by both creators, and creating a Schedule with a name that already exists updates it in place rather than adding a second, so both the agent's API and the Operator's boot-time code are safe to re-run. The name is the only identifier: it addresses the Schedule for reading and cancellation, and it is the reference carried in every Signal the Schedule emits. So a name reused for a fresh Schedule after cancellation is indistinguishable in fire history from an update of one continuous Schedule, which is accepted rather than guarded against. Missed fires, those that would have come due while the Gateway was down, are skipped rather than replayed: the next fire is always derived forward from now, so an occurrence in the past is never produced. A one-shot is spent once it fires; a recurring one runs until cancelled or until an optional end instant. Nothing removes a Schedule but an explicit cancellation, so a standing Schedule outlives the code or the Run that declared it.
_Avoid_: job, task, cron job, timer, alarm, reminder

## Signing

Owned by Signatures and Decisions, not the Signal Worker, except the Nostr identity, which is the Nostr Channel's and is here because the two identities are only understandable side by side. The first three terms after it are Signatures'; a Decision is Decisions'.

**Signing identity**:
The Ed25519 keypair a Shared Agent's **commitments** are checked against. The public half is what a verifier of a Decision uses; the Operator holds the private half **in trust**, which is the same trust [ADR-0001](./docs/adr/0001-the-gateway-is-trusted.md) already grants applied to one more asset. Never enters the Agent Container. **It is no longer the only keypair**: it once was, and this entry said "one Shared Agent, one keypair, and no second name for it", which [ADR-0050](./docs/adr/0050-the-shared-agent-has-a-nostr-identity-too.md) retired. Its audience is a third party who never touches the Gateway, and copying it forges commitments. See [ADR-0041](./docs/adr/0041-the-shared-agent-has-a-signing-identity.md).
_Avoid_: agent key, service key, signing credential, certificate, identity provider

**Nostr identity**:
The secp256k1 keypair a Shared Agent is **addressed and recognised by on Nostr**, held by the Nostr Channel and by nothing else. Not a second name for the Signing identity and unable to become one, the curves being incompatible in both directions. Its audience is the people talking to the agent, and copying it impersonates the agent to them rather than forging anything a third party relies on. Also an **address**, which is what makes it unrotatable in practice: every User's client holds the old public key. No component can answer "who is this agent" across both identities, and nothing tries to. See [ADR-0050](./docs/adr/0050-the-shared-agent-has-a-nostr-identity-too.md).
_Avoid_: nsec, npub (those are display encodings, not the thing), agent key, second signing identity

**Statement**:
The string a signature commits to. A plain string rather than arbitrary JSON, for the reason a Message carries a `text`: fixing the shape is what makes one verifier serve every deployment.
_Avoid_: message, claim, assertion, payload, content, body

**Signed Statement**:
A compact JWS over one Statement — `header.payload.signature`, base64url, one URL-safe string, and therefore literally a signed string. Carries a `typ` **the agent chooses**, which is its own signed claim about what kind of thing the artifact is and not something the framework guarantees. What a signature proves is that the Operator committed to this Statement on the Shared Agent's behalf, and nothing whatever about the agent's conduct. Never stored by Signatures. See [ADR-0042](./docs/adr/0042-a-signature-is-a-compact-jws.md).
_Avoid_: signature, token, JWT, attestation, certificate, receipt, proof

**Decision**:
A Signed Statement that Decisions numbered and kept. Immutable, addressed to nobody, and readable by every authenticated User — a commitment that is not public is not a commitment, and there is no addressee to scope one to anyway, Party not being in the data model ([ADR-0008](./docs/adr/0008-party-is-not-in-the-data-model.md)). **The JWS is the Decision**: the log is where Decisions are kept rather than what makes them real, so a verifier holding a valid one cannot conclude a row exists and does not need to. See [ADR-0043](./docs/adr/0043-decisions-are-one-global-log.md).
_Avoid_: ruling, resolution, verdict, minute, commitment, announcement, policy

## Properties

**Shielded**:
Of a Shared Agent: reachable only through the Gateway, with no direct path from any User to the Agent Implementation. A statement about topology, not a security guarantee — see [ADR-0003](./docs/adr/0003-prompt-injection-is-an-accepted-risk.md) and [ADR-0004](./docs/adr/0004-runtime-confinement-is-the-deployments-responsibility.md).
_Avoid_: protected, sandboxed, isolated, secured

## Rejected

**Component**:
No longer rejected, and kept here because it was. [ADR-0031](./docs/adr/0031-parts-that-run-are-components.md) reinstated it with a far narrower meaning than the one rejected: a lifecycle, and nothing else. [ADR-0037](./docs/adr/0037-the-gateway-is-a-record-of-components.md) then widened it to every entry in the Gateway's record, which is nearly the population the original rejection had in mind, and the rejection *still* holds for the reason it always did: there is no common contract that the Messenger, the Scheduler, an Authenticator and an Operator's own code all satisfy. Two methods is what survived that, and it is why widening the population cost nothing. "Service", "plugin", "module" and "extension" stay rejected as synonyms.

**Part**:
Retired as a defined term by [ADR-0037](./docs/adr/0037-the-gateway-is-a-record-of-components.md). It named the superset of Component, "anything the Gateway is assembled from, whether or not it runs", and once things that do not run became Components the set it named came down to the Runtime and the Agent Container it holds. A term whose extension is one branch of the design is not a term. Lowercase "part" survives as ordinary English and the glossary stops policing it; nothing replaced it, and a sentence wanting to say "anything the Gateway is assembled from" now says so in words.
_Also rejected as synonyms_: piece, element, unit

**Authenticator**:
Rejected, having been named in [ADR-0014](./docs/adr/0014-users-are-opaque-ids-and-authentication-is-pluggable.md) as the replaceable part that verifies a credential. Its own motivation was keeping authentication out of the core, and that is satisfied by Users being a separate part: a deployment replaces our authentication by constructing the Users component with no Public server ([ADR-0032](./docs/adr/0032-components-wire-themselves-at-construction.md)). Verification was also the wrong seam — an implementation of one still has to answer where the credential lives, so the useful extension point is **token issuance**, which is a public method and not an interface. See [ADR-0030](./docs/adr/0030-passwords-are-traded-for-bearer-tokens.md).
_Also rejected as synonyms_: identity provider, auth provider, IdP, credential verifier

**Submission**:
Rejected as a separate entity for what a User sends in. It is an **inbound Message**. A distinct entity would have made the agent's read of the Message log a union of two shapes, which is the one read it exists to serve. The verb "submit" is still the right word for the act.
_Also rejected as synonyms_: request, input, utterance, post

**Outbox**:
Rejected, having been the term for the outbound-only view of one User's Messages that the User fetched by cursor ([ADR-0015](./docs/adr/0015-outboxes-are-cursor-read-logs.md)). **Absorbed rather than dropped**: `seq` now numbers both directions, so the cursored read it named is the Message log's own read and the filter it consisted of is gone. Everything ADR-0015 argued about cursors survives under **Message log**; only the outbound-only scope fell. The stored read position went with it, and there is no term for one.
_Also rejected as synonyms_: queue, feed, inbox, notifications

**Chat**:
Rejected as a *framework* concept: it presumes free-text back-and-forth, is meaningless for a scheduled Signal, and overlaps both Session and Message log. A client renders a chat; what it renders is a Message log, and that is the domain term even now that the content is a string. If the Messenger ever needs to group Messages, the term is **Conversation**, and it lives there.

**Mandate**:
Named the agreed statement of what a Shared Agent is for. Real as a reason the framework exists, but with no operational role once agent configuration is opaque, and not needed to explain the framework either. See [ADR-0016](./docs/adr/0016-agent-configuration-is-opaque-to-the-framework.md).

**Signer**:
Rejected as the name of the Signatures Component, and the closer call of the two. It sat naturally among the `-er` names — Worker, Manager, Messenger, Scheduler, Producer — and lost on coverage: it names `POST /sign` and says nothing about verification or the public key, where **Signatures** names what all three routes are about. See [ADR-0044](./docs/adr/0044-components-are-named-for-what-they-own.md).
_Also rejected as synonyms_: Notary (a notary attests to somebody else's statement; here the agent is the author), Attestor (attestation implies vouching for an external fact), Seal, Identity (already this glossary's heading for Users and Tokens)

**Decision Log**:
Rejected as the name of the Decisions Component, having been the working name through its design. It read well against **Message log** — conversation there, commitment here — and the parallel is what killed it: a Message log is a thing the Messenger *holds*, distinct from the Component, whereas the append-only record is the whole of what Decisions is. A term with nothing of its own to name is not a term. See [ADR-0044](./docs/adr/0044-components-are-named-for-what-they-own.md).
_Also rejected as synonyms_: Decision Registry (the Gateway "is not a registry" is a line already defended), Decision Manager, ledger, bulletin

**Transport**:
Rejected as the name for a **Channel**, having been the working word through the design. Killed by an argument [ADR-0034](./docs/adr/0034-the-http-messenger-is-an-opinionated-messenger.md) had already made about the other half of the same name: *"The transport reading of the name would say nothing: every part of this framework is reached over HTTP, the agent included."* So "the HTTP Transport" is that tautology written down, where "the HTTP Channel" says the useful thing. **Channel** also names what a Message travels through, which is the column a second one would add. See [ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md).
_Also rejected as synonyms_: adapter, connector, driver, provider, bridge, gateway (ours)

**Notification**:
Rejected as a concept distinct from a Message, and previously only listed under Message's _Avoid_. What it would have named is something pushed to whoever can be pushed to, outside the Message log, and the design has no place for it: a Channel that pushes is pushing a Message, and choosing where to push is the Signal Handler's ([ADR-0006](./docs/adr/0006-session-routing-is-chosen-by-the-signal-handler.md)). Taking it would have added a second log-shaped concept and reopened ADR-0034's fixed content shape one layer up. The one thing that will travel over a Channel and stay out of the log is an authentication challenge, and that is the Authenticator's business rather than a new noun here.
_Also rejected as synonyms_: alert, push, ping

**Alias**:
Rejected, having been the proposed term for a name a User holds in somebody else's namespace: a Nostr public key, a Telegram user id, an MXID, a phone number, stored as `(scheme, value)` on Users so that a Channel and an Authenticator for the same scheme would read one row. Two arguments for it were sound and it still lost. It is genuinely identity rather than either part's private data, since a Nostr public key survives the removal of the Channel *or* the login; and three different things would write it (a Channel admitting a proven key, an enrolment route, the Operator out of band). What killed it: **a unique constraint buys uniqueness and not authenticity**, so the table would have been a trust root shared between messaging and authentication, and the whole prize was one row not written twice. Full separation was cheaper and is reversible in the direction that matters. So there is no term for it, each part keeps its own mapping, and the duplication is the recorded cost. See [ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md).
_Also rejected as synonyms_: Address (names reachability, and a login is not that), external identity, subject, handle (taken by `db.handle`)
