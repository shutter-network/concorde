# Architecture

Terminology is defined in [CONTEXT.md](../CONTEXT.md). Decisions and their rationale are in [docs/adr/](./adr/). This document is the map.

## Shape

The Gateway is one deployable application assembled from parts, several of which contribute routes to the Public server, the Agent server, or both. Three rings, from the inside out:

1. **Agent Runtime** — `pi` primarily, `openclaw` as the alternative, driven by a Runtime Adapter. In the reference deployment it runs inside a container.
2. **Core** — the Signal queue, Signal Handler dispatch, Run execution, and Agent server routes for Signals and Runs. Holds no identity and knows nothing about messaging.
3. **Producers** — trusted parts that emit Signals into the Core: the **Messenger** for everything Users touch, and the **Scheduler** for time. An Operator picks the ones they want and writes their own where needed. **v1 ships only the Messenger**; the Scheduler is designed and deferred ([ADR-0018](./adr/0018-scheduling-is-a-separate-component.md)).

Nothing represents the Gateway itself. There is no plugin system and no registry of parts: the Operator's entry point constructs the Store, the two servers, the Core, and whichever Producers the deployment wants, wiring them by passing them to each other ([ADR-0021](./adr/0021-the-framework-has-no-plugin-system.md)).

Users talk to the Messenger and to nothing else. They never see a Signal. The Agent Runtime never reaches a User except through the Agent server. That, and nothing more, is what **Shielded** means.

```mermaid
flowchart LR
    U[Users] <-->|submit, poll Outbox| P[Public server]
    subgraph GW[Gateway]
      P --> M[Messenger]
      M -->|emit Signal| Q[(Signal queue)]
      S[Scheduler<br/>deferred] -.->|emit Signal| Q
      Q --> W[Serial worker]
      W -->|kind| H[Signal Handler]
      H -->|0..n Prompts| RA[Runtime Adapter]
      AS[Agent server]
      AS --> M
      AS -.-> S
      AS --> Q
    end
    RA -->|one process per Run| AR[Agent Runtime]
    AR -->|HTTP| AS
    H <-->|files| WS[(Workspace)]
    AR <-->|files| WS
```

## Parts

Two kinds of row below, and the distinction matters. **Objects** are things the entry point constructs. **Seams** are things supplied *to* an object — a function or a narrow interface, with no lifecycle and no routes of its own.

| Part | Kind | Supplied by | Routes it contributes | Notes |
| --- | --- | --- | --- | --- |
| Store | object | framework | — | Signals, Runs, and whatever Producers keep |
| Public server | object | Operator | — | the one surface exposed outside; a `Fastify()` the entry point constructs and states a bind address for |
| Agent server | object | Operator | — | reachable only by the Agent Runtime; a second `Fastify()`, bound loopback in the reference deployment |
| Core | object | framework | agent: read prior Signals, read Runs | owns the serial worker; one Run at a time, globally |
| Messenger | object, replaceable | framework | public: authenticate, submit, poll Outbox — agent: send Message, read the Message log, read and create Users | Users, the Message log in both directions, Outboxes as a view over it, optional Conversations |
| Scheduler | object, replaceable | framework | agent: schedule future work | recurrence, cancellation, next-fire. **Deferred, not in v1** (ADR-0018) |
| Runtime Adapter | seam | framework or Operator | — | narrow contract: Prompt + Session in, outcome out. The `pi` one spawns a confined process per Run (ADR-0025) |
| Signal Handler | seam | Operator | — | arbitrary code; the primary extension point |
| Authenticator | seam | Operator | — | inside the Messenger; bearer tokens by default |
| Workspace | directory | Operator | — | files shared by handlers and agent; global, not per Session |

Anything not in this table an Operator adds themselves: routes as Fastify plugins on either server, and background work as ordinary code that calls the Core's emit method.

## The loop

1. A Producer emits a Signal — in v1, the Messenger, which authenticates the User, records an inbound Message, and emits the Signal in one transaction.
2. The worker takes the oldest pending Signal.
3. It dispatches on `kind` to exactly one Signal Handler, which returns zero or more Prompts, each naming a Session.
4. For each Prompt the Runtime Adapter starts a Run. Under `pi`, one fresh process against the named session.
5. During the Run the agent may call the Agent server: send Messages, read the Message log for any User, read or create Users, read prior Signals.
6. Outbound Messages are appended to the Message log and become visible in that User's Outbox.
7. The handler's post phase runs, told whether any Run failed.
8. Users poll their Outbox by cursor.

## Extension points

**Signal Handler**, **Authenticator**, **Runtime Adapter** — all arbitrary code, none restricted. The **Messenger** and **Scheduler** are replaceable by construction: don't build ours, build yours. Routes extend through Fastify's plugin system on either server, and further Producers are ordinary code calling the Core's emit method. There is deliberately no framework-level plugin contract ([ADR-0021](./adr/0021-the-framework-has-no-plugin-system.md)).

## What this framework provides

- No path from a User to the Agent Runtime except through the Gateway.
- Every Signal comes from a trusted Producer. What a Producer puts in a payload is its own contract — the Messenger's contract includes the submitting User's id.
- Every Message involves exactly one User, in one direction, and Users read only their own Outbox.
- No identifier or counter exposed to a User is influenced by another User's activity.

## What it does not provide

Each is a deliberate decision, not an omission:

- **Confidentiality between Users.** The agent reads everything and decides what to send to whom (ADR-0002, ADR-0011).
- **Injection resistance.** Accepted risk, mitigated by guidance to handler authors (ADR-0003).
- **Runtime confinement.** The deployment's responsibility (ADR-0004).
- **Non-repudiation.** No party can prove what the agent was told or replied (ADR-0001).
- **Isolation of any kind.** A deployment needing real isolation runs two Shared Agents.
- **Protection against a bad Producer.** Producers are trusted by construction (ADR-0020).
- **Availability under a hostile User.** With no timeouts and a serial worker, a User who steers the agent into an unbounded tool loop halts it for every Party until an Operator restarts (ADR-0017).
- **Authentication on the Agent server.** There is none, and reaching the port is access — so keeping it unreachable is the deployment's job, through the bind address its entry point states on `listen` (ADR-0004, ADR-0010).

## Known limits

- **One Run at a time, globally.** Throughput is roughly one Run per Run-duration for the whole agent, and a short question queues behind a long task (ADR-0012).
- **Nothing is bounded by time.** No Run timeout, no handler timeout. A hung `bash` call or a wedged handler halts every Party until an Operator restarts the process (ADR-0017).
- **At-most-once processing.** A failed Signal is dropped after partial effect and never re-run.
- **Swapping Agent Runtime means rewriting the agent's configuration** (ADR-0016).
- **The read-side blast radius of a successful injection is everything the agent-facing API exposes** (ADR-0011).

## Open

- Why `pi` was chosen over `openclaw`, which already provides much of this (ADR-0005).
- Whether the Messenger and Scheduler stay modules or become peer services later (ADR-0020).
