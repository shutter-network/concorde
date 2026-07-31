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
Whoever runs and configures a Shared Agent. Trusted by every Party: holds the agent's configuration, writes its Signal Handlers, and has the only direct access to the Agent Runtime. See [ADR-0001](./docs/adr/0001-the-gateway-is-trusted.md).
_Avoid_: builder, host, admin, provider, owner, integrator, implementor

**Gateway**:
The trusted application that mediates every interaction into and out of a Shared Agent. One deployable, and an assembly rather than a thing: a Core that runs Signals, Producers that face outward, and the Public and Agent servers they contribute routes to. Nothing represents the Gateway itself — the Operator's entry point *is* the assembly. See [ADR-0020](./docs/adr/0020-producers-are-trusted-components-of-the-gateway.md) and [ADR-0021](./docs/adr/0021-the-framework-has-no-plugin-system.md).
_Avoid_: proxy, broker, shield, warden, sidecar

**Core**:
The part of the Gateway that owns the Signal queue, Signal Handler dispatch, Run execution, and the Agent server routes for Signals and Runs. Holds no identity and knows nothing about messaging.
_Avoid_: engine, kernel, runner

**Producer**:
Anything inside the Gateway that emits Signals into the Core's queue. A **role**, not a kind of thing: the Messenger and the Scheduler are Producers, and so is a loop the Operator writes. Privileged — whatever it writes into a payload the Core takes as fact.
_Avoid_: source, ingress, adapter, connector

**Public server**:
The HTTP server exposed outside the Gateway. Named for its exposure rather than its audience, because some of its routes serve no authenticated User. Users reach the Messenger through it and reach nothing else.
_Avoid_: user server, external API, frontend

**Agent server**:
The HTTP server only the Agent Runtime reaches, carrying the Core's Signal and Run routes plus whatever Producers expose to the agent. A mediation point, not a security boundary against the agent. See [ADR-0010](./docs/adr/0010-the-agent-reaches-the-gateway-over-http.md).
_Avoid_: internal API, private server, control plane

**Store**:
The Gateway's own persistent state — Signals, Runs, and whatever the Producers keep. The agent cannot touch it directly, only through the Agent server. Contrast the Workspace, which the agent reads and writes as files.
_Avoid_: database, persistence layer, repository

**Messenger**:
The Producer that owns everything Users touch — authenticating them, accepting their submissions, holding Outboxes, and any higher-level messaging concepts a deployment needs. Users talk to it and to nothing else.
_Avoid_: message server, chat server, inbox service

**Scheduler**:
The Producer that owns recurrence, cancellation, and next-fire computation, and emits a Signal when a schedule matures. See [ADR-0018](./docs/adr/0018-scheduling-is-a-separate-component.md).
_Avoid_: cron, timer, job queue

**Agent Runtime**:
The interchangeable agent implementation at the centre of the architecture. `pi` is the primary target; `openclaw` is the reference alternative. See [ADR-0005](./docs/adr/0005-pi-is-the-primary-agent-runtime.md).
_Avoid_: engine, backend, model, LLM

**Runtime Adapter**:
The part that drives one kind of Agent Runtime on the Core's behalf. Its contract is narrow: start a Run against a Session with a Prompt, collect the output, report completion or failure. It passes the agent's configuration through without interpreting it. See [ADR-0016](./docs/adr/0016-agent-configuration-is-opaque-to-the-framework.md).
_Avoid_: driver, plugin, connector, backend

**OpenClaw daemon**:
OpenClaw's own central process, which its own documentation calls "the Gateway". Always written as "the OpenClaw daemon" here — unqualified "Gateway" always means ours.

## Signals and Runs

**Signal**:
Something arriving from outside that may cause the agent to act. Emitted by a Producer, carrying a `kind` and an arbitrary JSON payload. Immutable but for its processing state.
_Avoid_: trigger, event, request, stimulus

**Signal Handler**:
Arbitrary code, authored by the Operator, that accepts Signals of one `kind` and produces Prompts from them, declaring which Session each Prompt goes to. The framework's primary extension point, in the way an endpoint handler is a web framework's. See [ADR-0006](./docs/adr/0006-session-routing-is-chosen-by-the-signal-handler.md) and [ADR-0009](./docs/adr/0009-signal-handlers-are-arbitrary-code.md).
_Avoid_: trigger, processor, adapter, hook, listener

**Prompt**:
What a Signal Handler produces from a Signal, and the only form in which anything from outside reaches the agent. A Signal may yield none, one, or many.

**Post phase**:
The Signal Handler's second entry point, for cleanup. Runs once after all Runs arising from a Signal have finished, receives a flag saying whether one failed, and cannot produce Prompts. See [ADR-0017](./docs/adr/0017-failed-runs-are-not-retried.md).
_Avoid_: post handler, teardown, finalizer, callback

**Session**:
The Agent Runtime's unit of conversational continuity. A Signal Handler routes each Prompt to a fresh or a named Session. Organises context; does not isolate it.
_Avoid_: chat, conversation, thread, context

**Run**:
One execution of the agent: a single Prompt, in one Session, producing whatever the agent emits.
_Avoid_: turn, job, invocation, task

**Workspace**:
The files and data that Signal Handlers and the agent share, as opposed to the Store, which the agent cannot touch directly. Global to a Shared Agent, not per Session.
_Avoid_: scratch, working directory, shared state

## Messaging

Owned by the Messenger, not the core.

**User**:
An entity that authenticates against the Messenger, submits messages, and has an Outbox. Named by an opaque Messenger-issued id, never by email or any other scheme. See [ADR-0014](./docs/adr/0014-users-are-opaque-ids-and-authentication-is-pluggable.md).
_Avoid_: account, member, client, party

**Attributes**:
Arbitrary JSON carried by a User, defined by the deployment rather than the framework. Where grouping lives, since there is no Party entity.
_Avoid_: metadata, profile, claims, roles

**Authenticator**:
The replaceable part that verifies a User's credential. Gateway-issued bearer tokens are the default; a deployment may substitute anything.
_Avoid_: identity provider, auth provider, IdP

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
Of a Shared Agent: reachable only through the Gateway, with no direct path from any User to the Agent Runtime. A statement about topology, not a security guarantee — see [ADR-0003](./docs/adr/0003-prompt-injection-is-an-accepted-risk.md) and [ADR-0004](./docs/adr/0004-runtime-confinement-is-the-deployments-responsibility.md).
_Avoid_: protected, sandboxed, isolated, secured

## Rejected

**Component**:
Rejected as a framework concept. There is no common contract that the Messenger, the Scheduler, an Authenticator and an Operator's own code all satisfy, and inventing one bought nothing that direct interfaces did not. Each part of the Gateway is customised on its own terms; HTTP routes extend through Fastify's plugin system rather than ours. "Part" is the informal word when one is needed. See [ADR-0021](./docs/adr/0021-the-framework-has-no-plugin-system.md).
_Also rejected as synonyms_: service, plugin, module, extension

**Submission**:
Rejected as a separate entity for what a User sends in. It is an **inbound Message**. A distinct entity would have made the agent's read of the Message log a union of two shapes, which is the one read it exists to serve. The verb "submit" is still the right word for the act.
_Also rejected as synonyms_: request, input, utterance, post

**Chat**:
Rejected as a *core* concept: it presumes free-text back-and-forth, is meaningless for a scheduled Signal, and overlaps both Session and Outbox. If the Messenger needs one, the term is **Conversation**, and it lives there.

**Mandate**:
Named the agreed statement of what a Shared Agent is for. Real as a reason the framework exists, but with no operational role once agent configuration is opaque, and not needed to explain the framework either. See [ADR-0016](./docs/adr/0016-agent-configuration-is-opaque-to-the-framework.md).
