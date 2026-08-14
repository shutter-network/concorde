# Concorde

A framework for building AI agents that serve several parties at once, where no single party may control the agent or reach it privately.

## Components

**shared agent**:
An AI agent that acts for more than one party at the same time and is controlled by none of them individually. **The only lowercase entry in this glossary**, and deliberately: Concorde is the project's name, and this is the ordinary description of what it builds rather than a second name for it. What that costs is that this one term does not read as a defined term in running prose, where every term around it does. Capitalising it is the thing to refuse in review.
_Avoid_: multi-tenant agent, group agent, bot, Shared Agent

**Party**:
One of the entities a shared agent belongs to. Explains why this framework exists, and has no operational role: parties hold no privileges over the agent and are not represented in the data model.
_Avoid_: owner, tenant, stakeholder, principal

**Operator**:
Whoever runs and configures a shared agent. Trusted by every Party: holds the agent's configuration, writes its Signal Handlers, and has the only direct access to the Agent Implementation.
_Avoid_: builder, host, admin, provider, owner, integrator, implementor

**Developer**:
The coding half of an Operator: whoever writes the entry point, the Signal Handlers and the Prompt templates against the framework's public API. Not a separate party or a separate trust level, and never a role in the data model. The word exists because the API reference is written for exactly this reader, where the rest of an Operator's job (holding the signing key, running the stack, owning the database) is not what an API reference speaks to.
_Avoid_: user, consumer, integrator, client

**Gateway**:
The trusted application that mediates every interaction into and out of a shared agent. One deployable, and now a thing rather than only an assembly: a record of Components, started in the order of its keys and stopped in the reverse of it, and structurally a Component itself. It is still not a registry and not a plugin host, since it resolves nothing, injects nothing and cannot say what depends on what. The Operator's entry point still constructs and still holds. `createGateway` builds the irreducible infrastructure a deployment using our parts always needs (the Db, both self-describing servers and the Signal Worker) and hands it to the Operator's `extend`, where the components a deployment picks (Users, one or more Auths, Signatures, Decisions, the Messenger and its one Channel) are constructed by hand, each a one-liner, and only the ones a deployment wants. `createBareGateway` takes a record of anything.
_Avoid_: proxy, broker, shield, warden, sidecar

**Component**:
An entry in the Gateway's record: a `start`, a `stop`, and nothing else. **Not only things that run.** Users, the Messenger, the HTTP Channel, Password Auth, Signatures and Decisions have no work at either end and are Components anyway, because the record is the Gateway's directory of its own parts, and membership is what gives one a position before it needs one. Signatures and the HTTP Channel go further and have no tables either, which changes nothing: they are entries in the record like the rest. Both methods stay required, since with no `name` beside them a Component whose methods were optional would be the empty type. Not a plugin contract: nothing declares dependencies, routes or tables to the framework.
_Avoid_: service, plugin, module, extension

**Programmatic API**:
The methods a Component answers with, called in process by the Operator's own code and by a Signal Handler, as opposed to the routes that Component registers on a server. `Decisions.publish`, `Messenger.send` and `PasswordAuth.issueToken` are the programmatic API of their parts; `POST /decisions` is not. The distinction is a calling convention and not a permission boundary, though the two line up in practice: a capability that must not be reachable from the Agent server is offered here and given no route, which is how creating a User, setting Attributes, replacing a password and granting a public key all stay out of an injected prompt's reach. A Channel carries no programmatic API for messaging, since sending and reading are the Messenger's, but it may have one for the medium it speaks: the HTTP Channel answers with nothing an Operator calls, and the Nostr Channel answers with `recordPublicKey` and `publicKey`, which are about Nostr identity rather than about Messages.
_Avoid_: trusted API, in-process API, the acts no request can express, what trusted code holds, the methods no route has

**Signal Worker**:
The Component that owns the Signal queue, Signal Handler dispatch, Run execution, and the Agent server routes for Signals and Runs. Holds no identity and knows nothing about messaging. One Signal at a time, globally, which is what "worker" is there to say. Formerly the **Core**.
_Avoid_: core, engine, kernel, runner, signal processor, prompt worker

**Producer**:
Anything inside the Gateway that emits Signals into the Signal Worker's queue. A **role**, not a kind of thing: the Messenger and the Scheduler are Producers, and so is a loop the Operator writes. A Channel is **not** one, despite being where an inbound Message comes from: it hands the Message to the Messenger, which is what writes the Signal. Privileged, in that whatever it writes into a payload the Signal Worker takes as fact.
_Avoid_: source, ingress, adapter, connector

**Public server**:
The HTTP server exposed outside the Gateway. Named for its exposure rather than its audience, because some of its routes serve no authenticated User. Users reach the Users component, an Auth and the HTTP Channel through it, and reach nothing else. A Channel that is not HTTP does not appear on it at all: the Nostr Channel's inbound edge is a Relay subscription, not a route. **It is also where every Auth registers**, and it composes them into the one `requireUser` a protected route takes, which is the one thing it knows that no component does: which schemes this deployment accepts. The Agent server carries the same two members and nobody registers anything with them.
_Avoid_: user server, external API, frontend

**Agent server**:
The HTTP server only the Agent Implementation reaches, carrying the Signal Worker's Signal and Run routes plus whatever Producers expose to the agent. A mediation point, not a security boundary against the agent.
_Avoid_: internal API, private server, control plane

**Db**:
The Component everything else reaches PostgreSQL through: the pool, the schema-typed handle each one queries on, transactions and `LISTEN` registrations, and nothing else. Reached at `gateway.components.db`, like every other Component. **It applies no DDL and verifies none.** It once carried `migrate` and `registerMigrations` beside `start` and `stop`; migration ownership moved to the Operator, who lists the `/schema` subpaths of the parts they run and applies them with their own `drizzle-kit`, so `db.start()` opens the pool and says nothing about what tables are there. The agent cannot touch it directly, only through the Agent server. Contrast the Workspace, which the agent reads and writes as files. Formerly the **Store**, which named the persistent state rather than the client, and persistent state has no lifecycle to start and stop.
_Avoid_: store, datastore, persistence layer, repository

**Messenger**:
The Producer that owns the Message log: it records a Message in either direction, emits a Signal from an inbound one in the same transaction, holds the log the agent writes into and both sides read, and carries the agent's own routes on the Agent server. **It reaches nobody.** Getting a Message to a person is a Channel's job, and the Messenger knows only the one registered with it. It owns neither Users nor their authentication, being constructed with Users. The content is a `text` string, the Signal `kind` is fixed, and the log is one per User across both directions: three shapes fixed here rather than left to a Channel. A Component with a `start` and a `stop` that do nothing, keyed ahead of the Signal Worker so that it outlives the drain, because that is when a Signal Handler's post phase sends its failure notice.
_Avoid_: HTTP Messenger, message server, chat server, inbox service, message bus

**Channel**:
What reaches one person over one medium: the other half of messaging, and the Messenger's only outward edge. A `name`, a `send` the Messenger calls inside the caller's transaction, and a lifecycle. Nothing else, so it is no more a plugin contract than a Component is. It registers itself with the Messenger at construction and gets back a handle, which is the only way an inbound Message can be written, so no other code can write one and no Channel can claim to be another. **One per Messenger**, refused at registration rather than documented: which is why nothing yet records which Channel a Message travelled by, and why a deployment runs HTTP or Nostr and not both. Never a **Transport**: see Rejected. A PostgreSQL notification channel is always written as that, never as an unqualified Channel, the way a process signal is always `SIGTERM`.
_Avoid_: Transport, adapter, connector, provider, driver, bridge

**HTTP Channel**:
The Channel that serves Users over the Public server: a submission, and a cursored read of their own log. Named for its medium now that the freedoms it used to be named for belong to the Messenger. **It owns no tables and does nothing at either end**, and its `send` is a no-op, because HTTP delivery is the User asking. The second Component with no schema, after Signatures. Formerly the **HTTP Messenger**, which held the log as well.
_Avoid_: HTTP Messenger, web channel, REST channel, polling API

**Nostr Channel**:
The Channel that exchanges NIP-17 private direct messages with Users over one Relay the Operator runs. It holds the shared agent's Nostr identity, the Relay connection, and three tables of its own and no share of anyone else's: which public key it will write to, which envelopes it has already read, and which replies the Relay has not taken yet. Messaging and authentication stay fully separate, and now visibly so: **Nostr Auth maps public keys too, in a table this one never reads**, because "I will send to this key" and "this key may act as this User" are two grants with different cardinalities that happen to share a value. Its schema is `concorde_nostr_channel` and not `concorde_nostr`, naming the component rather than the protocol, because Nostr Auth speaks the protocol too. The first Channel with real work at either end, and the first part of the framework holding a long-lived connection it opened itself to something other than the Db. **It admits nobody**: a public key with no User is dropped and nothing is stored, because Users are preregistered. It announces exactly one thing about itself, a **Relay list**, and no profile. One Channel per Messenger means a deployment builds it **instead of** the HTTP Channel and never beside it, which is what `examples/03_nostr` is: the same Messenger and the same Message log as the two examples that build the HTTP Channel, and a Relay where those have two routes.
_Avoid_: Nostr Messenger, Nostr transport, relay client, DM bridge, npub adapter

**Users**:
The component that owns Users and nothing a User presents: the opaque id, the Attributes, and the reads of both. **It hashes no password, issues no Token and authenticates nobody**, all three having gone to Password Auth; what is left is identity, and every Auth is constructed with it. Its Agent server routes are read-only now that `POST /users` is gone, so the agent lists Users and creates none, and its one Public route is `GET /users/me`. It still owns Attributes, which is still where authorization lives. Not a Producer: it emits no Signals and holds no reference to the Signal Worker. A Component all the same, with a `start` and a `stop` that do nothing, because the Gateway's record holds every part and not only the ones that run. Write "the Users component" wherever the bare plural could be read as the people. **Two former names, and the history is the entry's value.** It was the **User Directory** first, the name every document used until the first rename swept them; the argument did not change, only the word. "Directory" was two words at once here, and the other one is a path the agent writes into: `agentDir` and `PI_CODING_AGENT_DIR` throughout. It also undersold a part that mostly writes, a directory being somewhere you look things up. It became the **User Manager** on this argument: **"Manager" was the vaguest word in this glossary, and it was taken knowing that**, since the other entries name what a thing is or does (a Signal Worker works Signals, a Mount Table is a table of mounts) where "manager" names a department, so it was declared the exception and not a precedent for the next entry. **User Registry** was the considered alternative and was dropped because it names registration, which is the one thing this part does not do, self-registration staying a Signal, and covers issuing and revoking no better than "Directory" did. The deciding argument was that "manager" is what this part reads as to the people who use it, so it was not a wart for a later reader to fix. No public name moved with that rename: it was prose that changed, and the component's identifiers already said Users. **That last sentence is why the wart was fixed after all**, and the component was renamed to **Users**: every identifier a consumer touches already said so and only the prose said Manager. **The rename has landed.** These documents, the doc comments, the OpenAPI descriptions and the test names all say Users now, and again no identifier moved, because there was none left to move. The ADRs keep the word they were written with, a dated record being wrong to rewrite.
_Avoid_: User Manager, User Directory, User Registry, auth service, identity provider, IdP, user store, account system, user module

**Auth**:
What owns one scheme's secret and turns a request carrying it into a User. A Component with one more member, `authenticate`, answering that the request is not its scheme's, or is and failed, or is and names this User. **Plural by design**, unlike a Channel: the Public server holds every registered Auth and composes them into the one `requireUser` a protected route takes. The seam is **who owns the secret**, not who verifies a credential, which is why an interface over verification alone was twice refused and this one is not: an Auth knows where its credential lives because it put it there. It registers itself with the server at construction, the way a Channel registers with the Messenger. It never names a Channel, which is what keeps the graph acyclic.
_Avoid_: Authenticator, auth provider, identity provider, IdP, credential verifier, auth strategy, guard

**Password Auth**:
The Auth a person logs into: it holds the scrypt hashes, mints and revokes Tokens, and carries the login and the three routes around it on the Public server. Named for the scheme rather than for either table, on the Messenger's argument rather than as an exception to the naming rule: it owns a hash table, a Token table, four routes and an `authenticate`, where *Passwords* would cover one of them. It runs no account recovery, which is the one claim about Users that has survived every rewrite.
_Avoid_: Passwords, password authenticator, login service, credential store

**Nostr Auth**:
The Auth that verifies a NIP-98 event on every request instead of issuing anything: no login route, no Token, and no route of any kind, so it is the second component of which that last is true. It grants public keys the right to act as a User, which is **not** the Nostr Channel's grant and not stored with it: that one says where to send, holds one key per User and is written to be reachable, where this one says who may act, holds as many keys per User as they have signers, and is written to be trusted. It records every admitted event so a captured header cannot be replayed, and prunes that record in the transaction that writes it.
_Avoid_: NIP-98 Authenticator, Nostr login, key auth, signature auth

**Signatures**:
The Component that holds the shared agent's Signing identity, and **only that one** now that a Nostr Channel holds a Nostr identity it could not use, and makes Signed Statements with it — signing on the Agent server, verification and the public key on the Public server. **Stores nothing**, so its subpath carries a constructor and nothing beside it; it was the only Component of which that was true until the HTTP Channel lost its tables to the Messenger. Not a Producer: it emits no Signals. Named for what it owns rather than as a *Signer*, which named one of its three routes.
_Avoid_: Signer, Notary, Attestor, Seal, signing service, key manager, KMS

**Decisions**:
The Component that owns the one global log of Decisions: it accepts the agent's statement, has Signatures sign it, numbers it and keeps it, and answers reads from the agent and from any authenticated User. Not a Producer — publishing emits no Signal, because a Decision is published *during* a Run and the worker is serial. Holds no Users and references none, so unlike the Messenger it imposes no construction order on the Users component.
_Avoid_: Decision Log, Decision Registry, Decision Manager, ledger, bulletin, minutes

**Scheduler**:
The Producer that owns Schedules: recurrence, one-shots, cancellation, next-fire computation, and time zones. It emits a Signal when a Schedule matures, and serves two creators of one shared model: the agent, through an API on the Agent server that both creates and manages Schedules, and the Operator, through a programmatic interface in code. Every matured Schedule emits the same fixed Signal `kind`, `scheduleFiredKind`, carrying the creator's opaque data beside the fire's metadata, so the Scheduler is a timer in front of the ordinary Signal dispatch and adds no new Handler concept. The agent's route is disableable, and that switch is the only guard on it: a self-waking agent can loop the single serial lane, and since the model has no per-creator scoping, the same switch is what keeps a prompt-injectable agent away from the Operator's Schedules. Opted into by the deployment like the Messenger rather than built by default.
_Avoid_: cron, timer, job queue

**Agent Implementation**:
The interchangeable agent program at the centre of the architecture. `pi` is the primary target; `openclaw` is the reference alternative. Formerly the **Agent Runtime**, the name used before the rename swept it. Renamed because "runtime" had come to mean three things at once, and this was the weakest of the three claims on it: `pi` is a program, and the word was wanted for what actually runs one. A fourth use of the word arrived later with the **Runtime Directory**, and it is not a fourth claim on the bare noun: it is a compound naming what a Runtime resolves its Mount Table against, which the rename is what made available. **Runtime** unqualified still means one thing.
_Avoid_: agent runtime, engine, backend, model, LLM

**Runtime**:
What the Signal Worker hands a Prompt to and gets an outcome back from, and the narrowest interface in the framework: one method. A construction option of the Worker's rather than a Component, and close to the only thing in the Gateway's design that is neither. It carries none of the Agent Implementation's own configuration, because what that reads on disk is the Operator's to place where it will look. Named for the Worker's own field, which has always been `runtime`. Formerly the **Runtime Adapter**; "adapter" is gone, since there is no longer a second kind of thing for it to adapt between. A Runtime that runs the agent in a container declares a **Runtime Directory** below and resolves its Mount Table against it, and writes in it nothing at all.
_Avoid_: runtime adapter, driver, plugin, connector, backend

**Agent Container**:
The declaration of the container one Run happens in: the image, the Mount Table, the networks, the environment, the entry point, and the flags the framework does not model. Inert and agent-agnostic: it creates nothing, checks no path and starts nothing, resolving to container arguments and no more. Only the image is required, and a Mount Table declared on it names the **Runtime Directory** below, on the host, which is the only namespace this declaration has a name for. This term names the directory `src/agent-container/` and the subpath `@shutter-network/concorde/agent-container`, which carries it and the Agent Container Runtime; `/runtime` was rejected for that subpath, since **Runtime** below is a different thing.
_Avoid_: sandbox, box, environment, runtime config, container spec

**Agent Container Runtime**:
The Runtime that runs an Agent Implementation as one fresh container per Run, generic over which one. It owns the whole of the container: the arguments, the confinement, the process, the redaction and the diagnosis of a failure. What an Agent Implementation adds to it is **one function**, which says what to put after the image, what to write on stdin, and how to read what comes back. `createPiRuntime` is that function plus two defaults.
_Avoid_: container adapter, executor, launcher, supervisor

**Mount Table**:
The declaration of which directories and files the agent's container sees, and where each one comes from. One entry is a **Mount**. The Workspace is one of them; so is any file the Operator wants the agent to be unable to change. Optional: an image carrying its own configuration and keeping nothing between Runs mounts nothing, and the cost of that is only that no Session survives the container. It used to carry the container's user as well, on the argument that what is shared and who shares it are two halves of one fact; the user is no longer configuration at all. Every entry is written against the **Runtime Directory** below.
_Avoid_: volume, bind, share, sandbox, mount config

**Runtime Directory**:
The directory a Runtime resolves its Mount Table against: one required host path, with every Mount written relative to it. Named on the host's side and nobody else's, because the container runtime's daemon is what resolves a bind source, so a Gateway that is itself in a container cannot in general reach this directory itself and must read anything it needs of its own from its image or from a path stated separately. `/` is a legal value, which is how a shared tree spanning more than one host mount is expressed. **The Runtime does not write there.** It creates nothing, checks nothing and opens nothing: the agent writes there, through the binds the Runtime declares, and the Operator creates the directories and places the files. Two of the four entries an example declares go the other way entirely, read-only files the Operator wrote for the agent to read and be unable to change. The fourth thing in this vocabulary with "runtime" in its name, which the **Agent Implementation** entry above accounts for. `RUNTIME_DIR_HOST` is the name an example gives the environment variable it reads this from, the suffix naming whose path to the directory it is.
_Avoid_: base dir, host root, shared tree, gateway path, mount root

**OpenClaw daemon**:
OpenClaw's own central process, which its own documentation calls "the Gateway". Always written as "the OpenClaw daemon" here — unqualified "Gateway" always means ours.

## Signals and Runs

**Signal**:
Something arriving from outside that may cause the agent to act. Emitted by a Producer, carrying a `kind` and an arbitrary JSON payload. Immutable but for its processing state. A process signal is always written as `SIGTERM` or `SIGINT` here, never as an unqualified "signal": unqualified Signal always means ours, so nothing of ours is ever named `onSignal`.
_Avoid_: trigger, event, request, stimulus

**Signal Handler**:
Arbitrary code, authored by the Operator, that accepts Signals of one `kind` and produces Prompts from them, declaring which Session each Prompt goes to. The framework's primary extension point, in the way an endpoint handler is a web framework's.
_Avoid_: trigger, processor, adapter, hook, listener

**Prompt**:
What a Signal Handler produces from a Signal, and the only form in which anything from outside reaches the agent. A Signal may yield none, one, or many. It names the Session it goes to, or writes `null` to ask for a fresh one — and *that* form of it reaches the Handler seam only: the Signal Worker answers the request before calling a Runtime, so a Prompt at the Runtime seam always names a Session and is a type of its own (`RunPrompt`) rather than the same type re-checked.

**Post phase**:
The Signal Handler's second entry point, for cleanup. Runs once after all Runs arising from a Signal have finished, receives a flag saying whether one failed, and cannot produce Prompts.
_Avoid_: post handler, teardown, finalizer, callback

**Session**:
The Agent Implementation's unit of conversational continuity. A Signal Handler routes each Prompt to a fresh or a named Session. Organises context; does not isolate it. A Handler asking for a fresh one is answered by the Signal Worker, which names it after the Run it belongs to before any Runtime sees it. So every Run records the Session it actually used, and no Runtime invents a naming convention of its own.
_Avoid_: chat, conversation, thread, context

**Run**:
One execution of the agent: a single Prompt, in one Session, producing whatever the agent emits.
_Avoid_: turn, job, invocation, task

**Workspace**:
The files and data that Signal Handlers and the agent share, as opposed to the Db, which the agent cannot touch directly. Global to a shared agent, not per Session.
_Avoid_: scratch, working directory, shared state

## Identity

Owned by the Users component, not the Signal Worker, not the Messenger and not a Channel.

**User**:
An entity that authenticates against the Users component, and may submit Messages and read their own Message log. Named by an opaque Gateway-issued id, never by email or any other scheme. Nothing removes one.
_Avoid_: account, member, client, party

**Attributes**:
Arbitrary JSON carried by a User, defined by the deployment rather than the framework. Where grouping lives, since there is no Party entity — and therefore where authorization lives.
_Avoid_: metadata, profile, claims, roles

**Token**:
What a User presents on every request after trading a password for one. Gateway-issued, always expiring, and revocable. **Password Auth's**, and not the framework's: it was the only request credential here until a second Auth arrived that issues nothing and takes a fresh signature on every request instead. There is no umbrella term for "the thing a request presents", deliberately, that being a general word rather than one of this framework's.
_Avoid_: session, JWT, API key, cookie

## Messaging

Owned by the Messenger, not the Signal Worker and not a Channel.

**Message**:
Something exchanged between the agent and exactly one User, in one direction or the other. Carries a **`text` string**, fixed by the Messenger rather than arbitrary JSON, and a `seq` that numbers it within that one User's log whichever direction it travelled. **Outbound** means agent to User; **inbound** means User to agent, and only a User can cause an inbound one. Never involves two Users, and never a group. Immutable once written, like a Signal, and nothing removes one. **It does not record which Channel it travelled by**, because one Channel per Messenger makes that column constant in every row; the day a second Channel is constructable, the column, the argument to `send` and the name in the Signal payload arrive together.
_Avoid_: notification, reply, response, event, DM

**Message log**:
The Messenger's record of every Message in both directions. The **durable** record of what was said, and the reason the Messenger owns it rather than each Channel: a Session is a lossy cache of it, since compaction discards what it holds, and a record split by medium would be a worse record than one. One User's slice of it is a single sequence across both directions, read by cursor: that one read serves a client's first page, its scroll backwards and its poll forwards alike. The agent queries any User's; a User reads only their own. A Relay is never this, whatever it retains.
_Avoid_: history, transcript, archive, outbox

**Relay**:
A Nostr server the Nostr Channel connects to, and in this framework's deployments **one, run by the Operator**. A transport and never a store: nothing in the protocol obliges it to retain anything, and the Message log is the durable record regardless of what it keeps. Users are told which one to point their client at, which is why a single one is an onboarding step here rather than the reachability failure it would be for a public agent — and it is the one this agent's **Relay list** names, since there is only one to name. A Relay that is down is an outage and not a boot failure: nothing the Channel sends it is awaited by `start`.
_Avoid_: server, broker, hub, node, message queue

**Relay list**:
The only thing a shared agent publishes about itself on Nostr: one replaceable event naming the Relay at which it receives private direct messages, republished at every start of the Nostr Channel. It buys two narrow things and **not discoverability** — it stops a client that refuses to message a public key with no such list, and it steers a compliant sender to the right Relay — because only a client already connected to that Relay can read it, and Users were told which Relay to add out of band. Nothing else is published: no profile, no name, no picture, so the agent appears in a client as a bare public key. A Relay that refuses it is a warning on the log and a Channel that started anyway, so it is never a boot dependency. Not the Message log, not a directory, and not a claim about anything but where to write.
_Avoid_: profile, metadata, announcement, advertisement, presence, directory entry

## Scheduling

Owned by the Scheduler.

**Schedule**:
A named, persisted instruction to emit a Signal at one or more future times: either a recurring cron expression or a one-shot instant, in a named time zone. The `name` is its identity in one flat namespace shared by both creators, and creating a Schedule with a name that already exists updates it in place rather than adding a second, so both the agent's API and the Operator's boot-time code are safe to re-run. The name is the only identifier: it addresses the Schedule for reading and cancellation, and it is the reference carried in every Signal the Schedule emits. So a name reused for a fresh Schedule after cancellation is indistinguishable in fire history from an update of one continuous Schedule, which is accepted rather than guarded against. Missed fires, those that would have come due while the Gateway was down, are skipped rather than replayed: the next fire is always derived forward from now, so an occurrence in the past is never produced. A one-shot is spent once it fires; a recurring one runs until cancelled or until an optional end instant. Nothing removes a Schedule but an explicit cancellation, so a standing Schedule outlives the code or the Run that declared it.
_Avoid_: job, task, cron job, timer, alarm, reminder

## Signing

Owned by Signatures and Decisions, not the Signal Worker, except the Nostr identity, which is the Nostr Channel's and is here because the two identities are only understandable side by side. The first three terms after it are Signatures'; a Decision is Decisions'.

**Signing identity**:
The Ed25519 keypair a shared agent's **commitments** are checked against. The public half is what a verifier of a Decision uses; the Operator holds the private half **in trust**, which is the same trust the Operator already holds, applied to one more asset. Never enters the Agent Container. **It is no longer the only keypair**: it once was, and this entry said "one shared agent, one keypair, and no second name for it", which the Nostr identity retired. Its audience is a third party who never touches the Gateway, and copying it forges commitments.
_Avoid_: agent key, service key, signing credential, certificate, identity provider

**Nostr identity**:
The secp256k1 keypair a shared agent is **addressed and recognised by on Nostr**, held by the Nostr Channel and by nothing else. Not a second name for the Signing identity and unable to become one, the curves being incompatible in both directions. Its audience is the people talking to the agent, and copying it impersonates the agent to them rather than forging anything a third party relies on. Also an **address**, which is what makes it unrotatable in practice: every User's client holds the old public key. No component can answer "who is this agent" across both identities, and nothing tries to.
_Avoid_: nsec, npub (those are display encodings, not the thing), agent key, second signing identity

**Statement**:
The string a signature commits to. A plain string rather than arbitrary JSON, for the reason a Message carries a `text`: fixing the shape is what makes one verifier serve every deployment.
_Avoid_: message, claim, assertion, payload, content, body

**Signed Statement**:
A compact JWS over one Statement — `header.payload.signature`, base64url, one URL-safe string, and therefore literally a signed string. Carries a `typ` **the agent chooses**, which is its own signed claim about what kind of thing the artifact is and not something the framework guarantees. What a signature proves is that the Operator committed to this Statement on the shared agent's behalf, and nothing whatever about the agent's conduct. Never stored by Signatures.
_Avoid_: signature, token, JWT, attestation, certificate, receipt, proof

**Decision**:
A Signed Statement that Decisions numbered and kept. Immutable, addressed to nobody, and readable by every authenticated User — a commitment that is not public is not a commitment, and there is no addressee to scope one to anyway, Party not being in the data model. **The JWS is the Decision**: the log is where Decisions are kept rather than what makes them real, so a verifier holding a valid one cannot conclude a row exists and does not need to.
_Avoid_: ruling, resolution, verdict, minute, commitment, announcement, policy

## Properties

**Shielded**:
Of a shared agent: reachable only through the Gateway, with no direct path from any User to the Agent Implementation. A statement about topology, not a security guarantee.
_Avoid_: protected, sandboxed, isolated, secured

## Rejected

**Authenticator**:
Rejected as the name for an **Auth**, which is the word to write. The reason is the seam: **verification is the wrong one**, because an implementation of `verify(request)` still has to answer where the credential lives, so what a part of this shape owns is *the secret* rather than the checking of it. An *Authenticator* names the checking. See the **Auth** entry above. Note that this list rejects *auth provider* by name while the glossary adopts *Auth*: what is refused is a borrowed vendor phrase for the whole concept, not the morpheme.
_Also rejected as synonyms_: identity provider, auth provider, IdP, credential verifier

**Submission**:
Rejected as a separate entity for what a User sends in. It is an **inbound Message**. A distinct entity would have made the agent's read of the Message log a union of two shapes, which is the one read it exists to serve. The verb "submit" is still the right word for the act.
_Also rejected as synonyms_: request, input, utterance, post

**Outbox**:
Rejected as a name for an outbound-only view of one User's Messages. `seq` numbers both directions, so there is no such view to name: the cursored read is the Message log's own. There is no stored read position either, and no term for one.
_Also rejected as synonyms_: queue, feed, inbox, notifications

**Chat**:
Rejected as a *framework* concept: it presumes free-text back-and-forth, is meaningless for a scheduled Signal, and overlaps both Session and Message log. A client renders a chat; what it renders is a Message log, and that is the domain term even now that the content is a string. If the Messenger ever needs to group Messages, the term is **Conversation**, and it lives there.

**Mandate**:
Named the agreed statement of what a shared agent is for. Real as a reason the framework exists, but with no operational role once agent configuration is opaque, and not needed to explain the framework either.

**Signer**:
Rejected as the name of the Signatures Component, and the closer call of the two. It sits naturally among the `-er` names — Worker, Messenger, Scheduler, Producer — and loses on coverage: it names `POST /sign` and says nothing about verification or the public key, where **Signatures** names what all three routes are about.
_Also rejected as synonyms_: Notary (a notary attests to somebody else's statement; here the agent is the author), Attestor (attestation implies vouching for an external fact), Seal, Identity (already this glossary's heading for Users and Tokens)

**Decision Log**:
Rejected as the name of the Decisions Component. It reads well against **Message log** — conversation there, commitment here — and the parallel is what killed it: a Message log is a thing the Messenger *holds*, distinct from the Component, whereas the append-only record is the whole of what Decisions is. A term with nothing of its own to name is not a term.
_Also rejected as synonyms_: Decision Registry (the Gateway "is not a registry" is a line already defended), Decision Manager, ledger, bulletin

**Transport**:
Rejected as the name for a **Channel**. Killed by an argument about the other half of the same name: the transport reading would say nothing, since every part of this framework is reached over HTTP, the agent included. So "the HTTP Transport" is that tautology written down, where "the HTTP Channel" says the useful thing. **Channel** also names what a Message travels through, which is the column a second one would add.
_Also rejected as synonyms_: adapter, connector, driver, provider, bridge, gateway (ours)

**Notification**:
Rejected as a concept distinct from a Message, and previously only listed under Message's _Avoid_. What it would have named is something pushed to whoever can be pushed to, outside the Message log, and the design has no place for it: a Channel that pushes is pushing a Message, and choosing where to push is the Signal Handler's. Taking it would have added a second log-shaped concept and reopened the Messenger's fixed content shape one layer up. The one thing that will travel over a Channel and stay out of the log is an authentication challenge, and that is an Auth's business rather than a new noun here.
_Also rejected as synonyms_: alert, push, ping

**Alias**:
Rejected as a term for a name a User holds in somebody else's namespace: a Nostr public key, a Telegram user id, an MXID, a phone number, stored as `(scheme, value)` on Users so that a Channel and an Auth for the same scheme would read one row. Two arguments for it are sound and it loses anyway. It is genuinely identity rather than either part's private data, since a Nostr public key survives the removal of the Channel *or* the login; and three different things would write it (a Channel admitting a proven key, an enrolment route, the Operator out of band). What kills it: **a unique constraint buys uniqueness and not authenticity**, so the table would be a trust root shared between messaging and authentication, and the whole prize is one row not written twice. Stronger still, the two mappings are not one fact stored twice: they are two grants with **different cardinalities**, one saying where to send and holding one key per User, one saying who may act and holding as many keys per User as they have signers. Unifying them is not available at any price. So there is no term for it, each part keeps its own mapping, and the cost is that two calls write them and nothing checks that they agree.
_Also rejected as synonyms_: Address (names reachability, and a login is not that), external identity, subject, handle (taken by `db.handle`)
