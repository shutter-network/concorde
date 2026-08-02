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

**Gateway**:
The trusted application that mediates every interaction into and out of a Shared Agent. One deployable, and an assembly rather than a thing: a Signal Worker that runs Signals, Producers that face outward, and the Public and Agent servers they register routes on. Nothing represents the Gateway itself, and the Operator's entry point *is* the assembly. See [ADR-0020](./docs/adr/0020-producers-are-trusted-components-of-the-gateway.md) and [ADR-0031](./docs/adr/0031-parts-that-run-are-components.md).
_Avoid_: proxy, broker, shield, warden, sidecar

**Part**:
Anything the Gateway is assembled from, whether or not it runs. The general word, and the superset: every Component is a Part, and most Parts are not Components.

**Component**:
A Part with a lifecycle: a `name`, a `start` and a `stop`, ordered by the Operator's entry point. Only Parts that run are Components, which today means the Db, the Signal Worker and the two servers. Not a plugin contract: nothing declares dependencies, routes or tables to the framework. See [ADR-0031](./docs/adr/0031-parts-that-run-are-components.md) and [ADR-0032](./docs/adr/0032-components-wire-themselves-at-construction.md).
_Avoid_: service, plugin, module, extension

**Signal Worker**:
The Component that owns the Signal queue, Signal Handler dispatch, Run execution, and the Agent server routes for Signals and Runs. Holds no identity and knows nothing about messaging. One Signal at a time, globally, which is what "worker" is there to say. Formerly the **Core**, the name every ADR up to [ADR-0030](./docs/adr/0030-passwords-are-traded-for-bearer-tokens.md) uses. See [ADR-0012](./docs/adr/0012-the-gateway-is-a-serial-signal-worker.md).
_Avoid_: core, engine, kernel, runner, signal processor, prompt worker

**Producer**:
Anything inside the Gateway that emits Signals into the Signal Worker's queue. A **role**, not a kind of thing: the Messenger and the Scheduler are Producers, and so is a loop the Operator writes. Privileged, in that whatever it writes into a payload the Signal Worker takes as fact.
_Avoid_: source, ingress, adapter, connector

**Public server**:
The HTTP server exposed outside the Gateway. Named for its exposure rather than its audience, because some of its routes serve no authenticated User. Users reach the User Directory and the Messenger through it, and reach nothing else.
_Avoid_: user server, external API, frontend

**Agent server**:
The HTTP server only the Agent Implementation reaches, carrying the Signal Worker's Signal and Run routes plus whatever Producers expose to the agent. A mediation point, not a security boundary against the agent. See [ADR-0010](./docs/adr/0010-the-agent-reaches-the-gateway-over-http.md).
_Avoid_: internal API, private server, control plane

**Db**:
The Component every other Part reaches PostgreSQL through: the pool, the schema-typed handle each Part queries on, transactions, `LISTEN` registrations, and migrations. The agent cannot touch it directly, only through the Agent server. Contrast the Workspace, which the agent reads and writes as files. Formerly the **Store**, which named the persistent state rather than the client, and persistent state has no lifecycle to start and stop. See [ADR-0022](./docs/adr/0022-the-store-is-postgresql-through-drizzle.md).
_Avoid_: store, datastore, persistence layer, repository

**Messenger**:
The Producer that owns messaging — accepting Users' submissions, holding Outboxes, and any higher-level messaging concepts a deployment needs. Owns neither Users nor their authentication: it is constructed with the User Directory and reads an already-authenticated User off the request. See [ADR-0029](./docs/adr/0029-users-are-a-part-of-their-own.md).
_Avoid_: message server, chat server, inbox service

**User Directory**:
The part that owns Users and their credentials — management on the Agent server, authentication on the Public server. Not a Producer: it emits no Signals and holds no reference to the Signal Worker. Not a Component either, having nothing to start or stop. See [ADR-0029](./docs/adr/0029-users-are-a-part-of-their-own.md) and [ADR-0030](./docs/adr/0030-passwords-are-traded-for-bearer-tokens.md).
_Avoid_: auth service, identity provider, IdP, user store, account system, user module

**Scheduler**:
The Producer that owns recurrence, cancellation, and next-fire computation, and emits a Signal when a schedule matures. See [ADR-0018](./docs/adr/0018-scheduling-is-a-separate-component.md).
_Avoid_: cron, timer, job queue

**Agent Implementation**:
The interchangeable agent program at the centre of the architecture. `pi` is the primary target; `openclaw` is the reference alternative. Formerly the **Agent Runtime**, the name ADR-0005 was recorded under and every ADR up to [ADR-0032](./docs/adr/0032-components-wire-themselves-at-construction.md) used before the rename swept them. Renamed because "runtime" had come to mean three things at once, and this was the weakest of the three claims on it: `pi` is a program, and the word was wanted for what actually runs one. See [ADR-0005](./docs/adr/0005-pi-is-the-primary-agent-runtime.md) and [ADR-0033](./docs/adr/0033-an-agent-is-a-container-and-one-function.md).
_Avoid_: agent runtime, engine, backend, model, LLM

**Runtime**:
The Part the Signal Worker hands a Prompt to and gets an outcome back from, and the narrowest interface in the framework: one method. It carries none of the Agent Implementation's own configuration, because what that reads on disk is the Operator's to place where it will look. Named for the Worker's own field, which has always been `runtime`. Formerly the **Runtime Adapter**; "adapter" is gone, since there is no longer a second kind of thing for it to adapt between. See [ADR-0016](./docs/adr/0016-agent-configuration-is-opaque-to-the-framework.md) and [ADR-0033](./docs/adr/0033-an-agent-is-a-container-and-one-function.md).
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

Owned by the User Directory, not the Signal Worker and not the Messenger.

**User**:
An entity that authenticates against the User Directory, and may submit Messages and hold an Outbox. Named by an opaque Gateway-issued id, never by email or any other scheme. Nothing removes one. See [ADR-0014](./docs/adr/0014-users-are-opaque-ids-and-authentication-is-pluggable.md) and [ADR-0029](./docs/adr/0029-users-are-a-part-of-their-own.md).
_Avoid_: account, member, client, party

**Attributes**:
Arbitrary JSON carried by a User, defined by the deployment rather than the framework. Where grouping lives, since there is no Party entity — and therefore where authorization lives.
_Avoid_: metadata, profile, claims, roles

**Token**:
What a User presents on every request after trading a password for one. Gateway-issued, always expiring, and revocable. The only request credential the framework has. See [ADR-0030](./docs/adr/0030-passwords-are-traded-for-bearer-tokens.md).
_Avoid_: session, JWT, API key, cookie

## Messaging

Owned by the Messenger, not the Signal Worker.

**Message**:
Something exchanged between the agent and exactly one User, in one direction or the other. Carries an arbitrary JSON payload. **Outbound** means agent to User; **inbound** means User to agent. Never involves two Users, and never a group. See [ADR-0007](./docs/adr/0007-messages-carry-arbitrary-json-payloads.md).
_Avoid_: notification, reply, response, event

**Message log**:
The Messenger's record of every Message in both directions. The **durable** record of what was said — a Session is a lossy cache of it, since compaction discards what it holds, and what another User said was never in a given Session at all. The agent queries it; Users see only their own.
_Avoid_: history, transcript, archive

**Outbox**:
The append-only log of **outbound** Messages to one User, which that User fetches by cursor. Retained after reading and numbered per User. A view over the Message log rather than a separate store — a User polling it never receives their own inbound Messages back. See [ADR-0015](./docs/adr/0015-outboxes-are-cursor-read-logs.md).
_Avoid_: queue, feed, inbox, notifications

## Properties

**Shielded**:
Of a Shared Agent: reachable only through the Gateway, with no direct path from any User to the Agent Implementation. A statement about topology, not a security guarantee — see [ADR-0003](./docs/adr/0003-prompt-injection-is-an-accepted-risk.md) and [ADR-0004](./docs/adr/0004-runtime-confinement-is-the-deployments-responsibility.md).
_Avoid_: protected, sandboxed, isolated, secured

## Rejected

**Component**:
No longer rejected, and kept here because it was. [ADR-0031](./docs/adr/0031-parts-that-run-are-components.md) reinstates it with a far narrower meaning than the one rejected: a lifecycle, and nothing else. What was rejected still is, and it is precisely why the interface is two methods and not a plugin system: there is no common contract that the Messenger, the Scheduler, an Authenticator and an Operator's own code all satisfy. "Service", "plugin", "module" and "extension" stay rejected as synonyms.

**Authenticator**:
Rejected, having been named in [ADR-0014](./docs/adr/0014-users-are-opaque-ids-and-authentication-is-pluggable.md) as the replaceable part that verifies a credential. Its own motivation was keeping authentication out of the core, and that is satisfied by the User Directory being a separate part: a deployment replaces our authentication by constructing the User Directory with no Public server ([ADR-0032](./docs/adr/0032-components-wire-themselves-at-construction.md)). Verification was also the wrong seam — an implementation of one still has to answer where the credential lives, so the useful extension point is **token issuance**, which is a public method and not an interface. See [ADR-0030](./docs/adr/0030-passwords-are-traded-for-bearer-tokens.md).
_Also rejected as synonyms_: identity provider, auth provider, IdP, credential verifier

**Submission**:
Rejected as a separate entity for what a User sends in. It is an **inbound Message**. A distinct entity would have made the agent's read of the Message log a union of two shapes, which is the one read it exists to serve. The verb "submit" is still the right word for the act.
_Also rejected as synonyms_: request, input, utterance, post

**Chat**:
Rejected as a *framework* concept: it presumes free-text back-and-forth, is meaningless for a scheduled Signal, and overlaps both Session and Outbox. If the Messenger needs one, the term is **Conversation**, and it lives there.

**Mandate**:
Named the agreed statement of what a Shared Agent is for. Real as a reason the framework exists, but with no operational role once agent configuration is opaque, and not needed to explain the framework either. See [ADR-0016](./docs/adr/0016-agent-configuration-is-opaque-to-the-framework.md).
