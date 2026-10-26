# Architecture

A Concorde application connects users to an AI agent through a gateway. The operator assembles
the gateway from components, runs the agent instance, and configures the network between them.

A shared agent serves several parties without giving any one party direct control. The gateway
mediates user access, exposes capabilities to the agent, and holds durable application records.
The agent instance performs the reasoning and tool use. This separation lets the operator keep
credentials, signing keys, and database access outside the agent instance.

This page explains the boundaries you work with when building an application. For a running
example, start with the [guide](./guide).

## Gateway and agent instance

The gateway holds the database connection, HTTP servers, signal worker, and the components your
application selects. The agent instance runs separately. The gateway reaches it through a
runtime; the agent calls back into the gateway through the agent server.

The two HTTP servers separate user access from agent capabilities. A user credential grants
access to protected public routes; the agent server exposes the operations the agent can perform.
The runtime connects the worker's runs to a particular agent implementation, so components do
not need to know that implementation's execution protocol.

![gateway infrastructure and optional messaging and authentication components, with the agent instance, user client, and relay outside the gateway.](/architecture.svg)

The diagram shows messaging and authentication options. A messenger accepts one channel in the
current implementation; the two channels shown are alternatives. The scheduler, signatures,
and decisions can also be added, although they are not drawn.

`createGateway` constructs four infrastructure components:

| Component | Responsibility |
| --- | --- |
| Db | Shared PostgreSQL access so component state changes can commit together |
| Agent server | HTTP capabilities the agent uses to read application data and act |
| Public server | HTTP endpoints for user clients, including authentication and message exchange |
| Signal worker | Durable queue that turns signals into agent runs, one signal at a time |

Your `extend` callback constructs additional components using this infrastructure. Dependencies
are explicit constructor arguments. The gateway does not discover dependencies or construct
optional components for you.

Explicit construction makes the capabilities installed in a deployment and their dependencies
visible in the application's entry point.

A component implements `start()` and `stop()`. Some components only register routes or provide
methods and have no resources to acquire; their lifecycle methods do nothing. Return every
component you want managed from `extend`. You can access them later through `gateway.components`.

Use `createBareGateway` if you need to supply the infrastructure yourself, including Fastify
instances with custom construction options.

## From a message to a run

Consider a user submitting a message through the HTTP channel:

1. The public server authenticates the request and identifies the user.
2. The channel passes the text to the messenger.
3. In one transaction, the messenger writes the inbound message and emits a signal of kind
   `messageReceivedKind`. The signal payload is the message record.
4. After commit, the signal worker selects the signal and calls its signal handler.
5. The handler returns zero or more prompts. Each prompt becomes a run.
6. The runtime executes each run against the agent instance.
7. To answer the user, the agent calls the agent server's messaging API. The messenger records
   the outbound message and passes it to the channel.

The agent's final model response is not automatically sent to the user. A run can finish
successfully without sending a message. Explain the gateway's messaging capability in your
agent instructions.

A run may inspect data, update a schedule, or communicate with several users. Sending through
the messaging API makes each recipient and message explicit and records the exchange in the
message log.

### Signals, prompts, and runs

A producer emits a signal with a `kind` and a JSON payload. Your handler map associates each
kind with a signal handler. An unrecognised kind fails the signal.

A signal records something that happened; the handler decides whether it warrants agent work
and what information the agent should receive. Messages and scheduled occurrences can therefore
share an execution path while application policy stays in operator-written code.

A handler can decline work by returning an empty array, produce one prompt, or fan out into
several prompts. Prompts execute in array order. One failed run does not prevent the remaining
runs for that signal from executing.

The optional `post` phase runs after the runs, including when `handle` failed. It receives a
failure flag and can perform application-specific cleanup or reporting. A failure in either
phase fails the signal; it does not stop processing subsequent signals.

Execution is serial across one signal worker, including the handler phases. Run exactly one
worker against a database. Multiple gateways sharing its queue do not preserve that guarantee.

Serial execution prevents runs from overlapping their use of shared conversational state and
gateway data. The tradeoff is that a slow run delays every subsequent signal, including signals
from other users.

### Failure and restart behavior

Signals and runs are recorded in PostgreSQL. Pending signals survive a restart. Signals left
in `processing`, and their unfinished runs, are marked failed when the next worker starts.
They are not replayed: the agent may already have sent messages or changed external state.

The worker does not retry failed handlers or runs. Application code can emit another signal
when appropriate, but it must account for effects of the previous attempt.

The framework imposes no timeout on a handler or runtime. A call that never resolves blocks the
queue and graceful shutdown. Provide appropriate limits in your own code or deployment.

## Sessions and run context

A session retains the agent's conversational state between runs. Your handler chooses the
session name on each prompt. You might use one session per user, one shared session, or a fresh
session for each run. `session: null` requests a fresh session named after the run.

Sessions do not restrict access. The agent can read gateway data across users and sessions
through the agent server. Session files may also be compacted by the agent implementation;
use the message log as the durable record of messages.

`Prompt.context` serves a separate purpose. It is application-defined JSON stored on the run
and attached to agent server requests as `request.concordeRun.context` while the runtime is
active. Your hooks can use it to enforce a policy for that run. Built-in routes do not interpret
it, and it is not sent to the model. Put information intended for the agent in the prompt text.

## Identity and authentication

Users stores user ids and application-defined attributes. It does not store credentials.
An auth owns a credential scheme and resolves a request to a user. Password auth accepts
bearer tokens; Nostr auth verifies signed NIP-98 requests.

Separating identity from credentials lets a user keep the same id, attributes, and message log
when authentication schemes change or several schemes are accepted.

Each auth registers with the public server during construction. A protected route uses
`publicServer.requireUser`. Auths are tried in registration order: an absent credential allows
the next scheme to try, an accepted credential sets `request.concordeUser`, and a refusal ends
the request with 401. Using this hook without any registered auth is a configuration error.

Creating users, replacing attributes, setting passwords, and granting Nostr keys are
programmatic API operations for trusted application code. They are not exposed to the agent
through built-in routes. Keep those operations outside capabilities available to the agent.

## Messenger and channels

The messenger supports communication between users and the agent. It owns one message log per
user, while a channel delivers messages over a particular medium. Keeping the log in the
messenger gives the application the same message records and inbound signals with either channel.

Inbound and outbound messages share a sequence, and records are immutable through the library
API. Cursors let clients read older messages or poll for new ones.

A messenger accepts one channel:

| Channel | Inbound path | Outbound path |
| --- | --- | --- |
| HTTP channel | Authenticated HTTP submission | Client polls the message log |
| Nostr channel | Encrypted direct messages from recorded public keys | Persisted envelope published to the configured relay |

The Nostr channel accepts messages only from keys previously recorded for existing users.
Its key mapping is separate from Nostr auth grants: permission to exchange messages does not
grant permission to authenticate HTTP requests, or vice versa.

The Nostr channel keeps outbound envelopes until relay acceptance or an explicit refusal.
Relay acceptance does not prove the recipient read the message. The relay is a delivery medium;
the gateway's message log remains the durable record.

## Scheduling and signing

The scheduler wakes the agent for work at a future time without requiring an incoming message.
It persists named schedules and emits `scheduleFiredKind` signals. Your handler chooses what
each occurrence does. A schedule can fire once or recur using a cron expression
and time zone. Scheduling an existing name replaces it. Missed occurrences during downtime
are skipped rather than replayed.

Signatures lets the agent produce statements that others can verify under the deployment's
signing identity. It creates compact JWS artifacts without storing them. Decisions adds an
immutable, numbered record of signed statements so users can consult the agent's commitments.
Every authenticated user can read decisions.
A signature authenticates a statement under the signing identity; it does not prove that the
agent followed its instructions or behaved fairly.

Keep the private signing key in the gateway. The Nostr channel uses a separate Nostr identity
for addressing and encrypted messaging. The two identities have different purposes and key types.

## Data ownership

Components publish Drizzle table definitions through `/schema` package subpaths. Each stores
its data in its own PostgreSQL schema. Your application selects the definitions it uses and
manages database changes; constructing or starting a gateway does not create tables.

Include `users/schema` whenever you include messenger, password auth, Nostr auth, or Nostr
channel tables, because their foreign keys reference users. HTTP channel and signatures have
no tables.

Use a shared `db.tx` when an application operation spans components. In particular, write a
signal in the same transaction as the state change that caused it. PostgreSQL delivers the
worker notification after commit, so rolled-back work cannot trigger a run.

## Start order

Constructing a gateway registers routes and builds the handler map. Calling `start()` connects
the db, starts the agent server and public server, starts extension components in returned key
order, then starts the signal worker. Return dependencies before the components that need them.

Shutdown reverses this order. The signal worker waits for its active signal to finish before
other components stop. Pending signals stay in the database. Give the process enough shutdown
time for the longest run you expect.

If startup fails, the gateway stops components whose startup completed. Shutdown attempts all
stops even if one fails, and reports collected failures.

## Deployment responsibilities

The operator controls the application, agent instructions, credentials, database, and network.
All parties must trust that operator. The gateway gives users a mediated path to the agent;
it does not constrain someone who controls the deployment.

The agent server and the agent instance's RPC listener are privileged, unauthenticated
endpoints. Restrict both to a private network. The agent must not be able to reach the database,
gateway secrets, or infrastructure controls unless your application explicitly needs that access.

Configure the agent instance's tools, workspace permissions, outbound access, and model
credentials according to the work it performs. The runtime connects to the instance; it does
not configure or confine it. The guide links to an [isolation example](./guide#prepare-for-deployment)
that keeps the model credential outside the agent container.

Concorde does not enforce confidentiality between users or prevent prompt injection. The agent
can disclose information it can read. Add application policy through handler logic and Agent
server hooks where you need restrictions, and avoid giving the agent unnecessary data or powers.
`quote` fences text from outside the gateway so the agent can tell it apart from your
instructions (see [the guide](./guide#define-how-the-agent-responds)). It makes injection harder,
not impossible.

Provide TLS, rate limiting, backups, secret management, and operational monitoring as part of
your deployment. Built-in login routes have no rate limiting.
