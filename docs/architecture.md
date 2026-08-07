# Architecture

Terminology is defined in [CONTEXT.md](../CONTEXT.md). Decisions and their rationale are in [docs/adr/](./adr/). This document is the map.

## Shape

The Gateway is one deployable application assembled from parts, several of which contribute routes to the Public server, the Agent server, or both. Three rings, from the inside out:

1. **Agent Implementation** — `pi` primarily, `openclaw` as the alternative, driven by a Runtime. In the reference deployment it runs inside a container.
2. **Signal Worker** — the Signal queue, Signal Handler dispatch, Run execution, and Agent server routes for Signals and Runs. Holds no identity and knows nothing about messaging.
3. **Producers** — trusted parts that emit Signals into the Signal Worker: the **Messenger** for messaging, and the **Scheduler** for time. An Operator picks the ones they want and writes their own where needed. Messaging is two parts, not one: the Messenger owns the Message log and **reaches nobody**, and a **Channel** is what gets a Message to a person over one medium. A Channel is not a Producer despite being where an inbound Message comes from — it hands the Message to the Messenger, which is what writes the Signal ([ADR-0048](./adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). The Messenger is still opinionated about the log itself: a `text` string, a fixed `kind`, one numbered sequence per User across both directions, and a deployment that wants those differently writes a second messaging Producer as a peer and pays for it in two Message logs the agent reads separately ([ADR-0034](./adr/0034-the-http-messenger-is-an-opinionated-messenger.md)). What it no longer decides is the medium, and that is the freedom a Channel is.

Not every part is a Producer. **Users** owns Users, their Attributes and their Tokens, and contributes routes to both servers, but emits no Signals at all — a Signal per login would put a Run behind every authentication, and the worker is serial ([ADR-0029](./adr/0029-users-are-a-part-of-their-own.md)). **Signatures** and **Decisions** are the same for the same arithmetic: a Decision is published *during* a Run, so emitting a Signal from it would have the agent queue work for itself on a serial worker, and the Handler it woke could publish again ([ADR-0043](./adr/0043-decisions-are-one-global-log.md)).

**Signatures** holds the Shared Agent's **Signing identity** and, since the HTTP Channel lost its tables to the Messenger, is one of two Components with no tables at all. The Operator holds the private half in trust, which is the trust [ADR-0001](./adr/0001-the-gateway-is-trusted.md) already grants applied to one more asset, and the key never enters the Agent Container ([ADR-0041](./adr/0041-the-shared-agent-has-a-signing-identity.md)). What it makes is a **Signed Statement**: a compact JWS, one URL-safe string, verifiable by off-the-shelf JOSE tooling in any language and built here with `jose`, which is a runtime dependency of this Component and of nothing else ([ADR-0042](./adr/0042-a-signature-is-a-compact-jws.md)). **Decisions** is the log of the ones worth keeping — global, addressed to nobody, published by the agent and read by any authenticated User, because a commitment that is not public is not a commitment.

**There are two identities, and they are held apart.** The Signing identity is Ed25519 and answers to a third party who never touches the Gateway; copying it forges the agent's commitments. The **Nostr identity** is secp256k1, lives on the Nostr Channel and nowhere else, and answers to the people talking to the agent; copying it impersonates the agent to them. Neither can be the other, the curves being incompatible in both directions, so the second one lives with the Channel that can use it rather than with Signatures, which could not use it for any of its three routes. Nothing in the framework can answer "who is this agent" across both, and nothing tries ([ADR-0050](./adr/0050-the-shared-agent-has-a-nostr-identity-too.md)).

What a signature proves is narrow and should be read as written: **that the Operator committed to this Statement on the Shared Agent's behalf, and nothing whatever about the agent's conduct.** Its audience is a party who never touches the Gateway's API and holds only a public key.

A **Gateway** is a record of Components keyed by the Operator's own words, which starts in key order, stops in the reverse of it, and unwinds a failed start; what `createBareGateway(record)` returns is itself a Component ([ADR-0037](./adr/0037-the-gateway-is-a-record-of-components.md)). It is still not a plugin system and still not a registry: a **Component** is a `start` and a `stop` and nothing else — no name, no declared dependency and nothing resolved — because the parts already hold each other, having been passed to each other ([ADR-0021](./adr/0021-the-framework-has-no-plugin-system.md)). The rest of the wiring is construction too: a part handed a server registers its routes on that server ([ADR-0032](./adr/0032-components-wire-themselves-at-construction.md)). Its tables are not wired that way and no longer arrive with the part at all — the framework ships schema definitions and applies nothing, so a component exposes its tables on its own subpath beside its constructor ([ADR-0047](./adr/0047-a-component-is-one-subpath.md)), the Operator barrels the components they run and applies the result with their own `drizzle-kit`, and `db.start()` checks nothing about what is there ([ADR-0046](./adr/0046-the-operator-owns-migrations.md)).

`createGateway` is the canonical path: one call builds the irreducible infrastructure every deployment needs (the Db, both self-describing servers and the Signal Worker) and hands it to the Operator's `extend`, where the components a deployment picks (Users, Signatures, Decisions, the Messenger, its one Channel and the Scheduler) are constructed by hand, each a one-line `create*` call wired from that infrastructure, and only the ones a deployment wants ([ADR-0045](./adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)). It keys them in the one order that works: the Signal Worker's `stop` is the only stop that does work, so the drain runs first, while every server is still listening, the Operator's own parts are still live and the pool is still open. An assembly is therefore two steps, construct and start, with the Operator's own migration step somewhere before the second; Users comes before the Messenger and the Channel, both of which take it as an argument, and the Messenger comes before the Channel, which registers itself with it. The ordering that can still be got wrong is which parts go into the barrel, since both the Messenger's foreign key and the Nostr Channel's need Users in it. An Operator whose infrastructure shape itself differs writes `createBareGateway` with a record of their own, which is the escape one layer down. Both calls, and `serverComponent` with them, are on `shared-agent-framework/gateway`: the package has thirteen subpaths and no root export, so every import an entry point writes names one of them ([ADR-0051](./adr/0051-the-package-root-exports-nothing.md)).

A User reaches the Users component, the HTTP Channel, Decisions and two of Signatures' three routes, and nothing else. A Channel that is not HTTP does not appear on the Public server at all: the Nostr Channel's inbound edge is a Relay subscription, so a deployment running it has a Public server carrying only the login route, Decisions and Signatures. Users never see a Signal, and they never reach `POST /sign` — minting is the agent's alone. The Agent Implementation never reaches a User except through the Agent server. That, and nothing more, is what **Shielded** means.

```mermaid
flowchart LR
    U[Users] <-->|log in| P[Public server]
    U <-->|post, read own log by cursor| P
    U <-->|read the Decision log by cursor| P
    U <-->|verify, fetch public key| P
    U <-.->|NIP-17 direct messages| RL[(Relay)]
    subgraph GW[Gateway]
      P --> US[Users]
      P --> HC[HTTP Channel]
      P --> D[Decisions]
      P --> SG[Signatures]
      HC -->|send, receive| M[Messenger]
      NC[Nostr Channel<br/>the other medium] -->|send, receive| M
      HC -.->|reads authenticated User| US
      M -.->|references its Users| US
      M -->|emit Signal| Q[(Signal queue)]
      S[Scheduler] -->|emit Signal| Q
      Q --> W[Serial worker]
      W -->|kind| H[Signal Handler]
      H -->|0..n Prompts| RA[Runtime]
      D -->|signs in process, never over HTTP| SG
      AS[Agent server]
      AS -->|send, read any log| M
      AS --> US
      AS -->|publish, read| D
      AS -->|sign anything| SG
      AS --> S
      AS --> Q
    end
    NC <-.->|one connection, the Operator's own| RL
    RA -->|one process per Run| AR[Agent Implementation]
    AR -->|HTTP| AS
    H <-->|files| WS[(Workspace)]
    AR <-->|files| WS
```

## Components

Every part a deployment is assembled from is a **Component**, and the eleven the framework ships are listed below. The first ten are in the order the reference deployment starts them, and they stop in the reverse of it. Five of those have nothing to run and say so with a `start` and a `stop` that do nothing, which is what buys them a key and a position before the day they need one ([ADR-0037](./adr/0037-the-gateway-is-a-record-of-components.md)). The eleventh, the Nostr Channel, is in no order because it is in no deployment of ours: one Channel per Messenger is refused at registration, so a deployment runs it **instead of** the HTTP Channel and in that Channel's position.

| Component | Key | Supplied by | Routes it contributes | Notes |
| --- | --- | --- | --- | --- |
| Db | `db` | framework | — | Signals, Runs, and whatever Producers keep. Owns the pool and the `LISTEN` connections, and no longer the migrations — the Operator applies those (ADR-0046). Starts first and stops last, because everything queries it and the drain queries it on the way down |
| Agent server | `agentServer` | framework, address from the Operator | — | reachable only by the Agent Implementation; a bare `Fastify()` wrapped in a `serverComponent` that holds its bind address until `start`, bound loopback in the reference deployment |
| Public server | `publicServer` | framework, address from the Operator | — | the one surface exposed outside; the second `Fastify()`, same wrapper. Grouped with the Agent server rather than stopped ahead of it, so both outlive the drain (ADR-0038) |
| Users | `users` | Operator, in `extend` | public: log in, log out, change password, read self — agent: create and read Users | Users, their Attributes, and their Tokens. Not a Producer (ADR-0029). Nothing to start and nothing to release, so both methods do nothing |
| Messenger | `messenger` | Operator, in `extend` | agent: send a Message, read any one User's Message log | one table, one `text` per Message, and a `seq` per User across both directions, so one cursored read serves polling and rendering (ADR-0035). Constructed with the Db, Users, the Signal Worker and the **Agent** server; owns no Users, and references theirs (ADR-0036). **Reaches nobody** — a Channel does that, and this holds the one registered with it, refusing a second at registration (ADR-0048). Both methods do nothing, and its position is what makes it outlive the drain a Handler's post phase sends through |
| HTTP Channel | `httpChannel` | Operator, in `extend` | public: post a Message, read own Message log by cursor | **no tables and no work at either end**, and its `send` is a no-op, because HTTP delivery is the User asking (ADR-0035, ADR-0048). Constructed with the Db, the Messenger it registers itself with, the Users component whose Tokens guard its routes, and the Public server. Formerly the HTTP Messenger, which held the log as well |
| Signatures | `signatures` | Operator, in `extend` | public: verify a Signed Statement, fetch the public key — agent: sign anything | holds the signing identity and **no tables at all**, the only Component with none. `signingKey` is a `crypto.KeyObject` the Operator loads however they like; `signingAlg` is derived from its JWK export (`EdDSA` for Ed25519, `ES256`/`ES384`/`ES512` for the NIST curves) and is required for an RSA key, which six algorithms are valid for. Any other key is refused as the Gateway is constructed, in a sentence naming what to pass. Stores nothing, so signing is unrecorded beyond a log line (ADR-0041, ADR-0042) |
| Decisions | `decisions` | Operator, in `extend` | public: read the log by cursor, read one by `seq` — agent: publish, and the same reads | one table, four columns, one global `seq`, and the framework's only **shared** read: every User sees the same rows. Constructed with the Db, Signatures and both servers; signs **in process** and never over HTTP. References no Users, so it imposes no construction order (ADR-0043) |
| Scheduler | `scheduler` | Operator, in `extend` | agent: create, read, list and cancel Schedules | one table; recurrence, one-shots, cancellation, next-fire and time zones. Emits one fixed `kind` when a Schedule matures, so it is a timer in front of the ordinary dispatch and adds no Handler concept. Constructed with the Db, the Signal Worker and — optionally — the Agent server, omitting which switches the agent's whole surface off while leaving the Operator's programmatic one (ADR-0018) |
| Signal Worker | `worker` | framework | agent: read prior Signals, read Runs | owns the serial worker; one Run at a time, globally. **The only `stop` that does work**: it waits for the Run in flight, which is why it is keyed last and therefore drains first (ADR-0038) |
| Nostr Channel | `nostrChannel` | Operator, in `extend`, **instead of** the HTTP Channel | none on either server | three tables of its own: which Nostr public key is which User, which envelopes it has read, and which replies the Relay has not taken. Holds the Nostr identity and one connection to one Relay the Operator runs, and exchanges NIP-17 private direct messages over it. **The only Component whose `start` and `stop` do real work besides the Db, the servers and the Worker**, and the only one that opens a long-lived connection of its own. It admits nobody: a public key no `pubkeys` row names is dropped and nothing is stored, and recording one is trusted code's alone with no route anywhere (ADR-0049, ADR-0050). Not in the reference deployment |

The components a deployment picks and an Operator's own Components alike go in the record through `extend`, keyed **ahead of** the Signal Worker, so they start before it and stop after the drain rather than before it (ADR-0045). That is right for a resource the drain uses, such as the Messenger a Handler's post phase calls — and for the Channel behind it, since that `send` runs into a Channel's own. A Producer, which should stop before the drain, is the case `extend` cannot express, and the answer is writing `createBareGateway` by hand. Nothing about the framework's own is privileged.

Three things in the design are **not** Components, and each is a different reason why.

| Not a Component | Kind | Supplied by | Notes |
| --- | --- | --- | --- |
| Runtime | seam | framework or Operator | narrow contract: Prompt + Session in, outcome out. Held *by* the Signal Worker and never started, which is what lets a second Agent Implementation be one function (ADR-0025, ADR-0033) |
| Signal Handler | seam | Operator | arbitrary code; the primary extension point. Receives only the Signal (ADR-0024) |
| Workspace | directory | Operator | files shared by handlers and agent; global, not per Session. Not a value the framework holds at all — it is a Mount Table entry and a path |

Anything else an Operator adds themselves: routes as Fastify plugins on either server, and background work as ordinary code that calls the Signal Worker's emit method.

## The loop

1. A Producer emits a Signal — usually the Messenger, which a Channel hands an inbound Message to, and which records it and emits the Signal in one transaction. Over HTTP the User is the one the Users component authenticated; over Nostr it is the one whose recorded public key sealed the message. The Signal is the same either way, and its payload names no Channel.
2. The worker takes the oldest pending Signal.
3. It dispatches on `kind` to exactly one Signal Handler, which returns zero or more Prompts, each naming a Session.
4. For each Prompt the Runtime starts a Run. Under `pi`, one fresh process against the named session.
5. During the Run the agent may call the Agent server: send Messages, read the Message log for any User, read Users, create a User with no Attributes, read prior Signals, **publish a Decision, read the Decision log, and have any string signed**. It may not grant a User privileges, re-credential one, mint a Token, or remove one (ADR-0029). It never holds the signing key (ADR-0041).
6. Outbound Messages are appended to the Message log, each numbered in the same per-User sequence as that User's inbound ones, and a send to a User who does not exist is refused (ADR-0035, ADR-0036). The Messenger then hands each to its Channel **inside the transaction writing it**, and a Channel that cannot take it throws, which rolls the Message back: nothing is recorded as sent that could not go out. The network act, where a medium has one, happens after that commit (ADR-0048).
7. The handler's post phase runs, told whether any Run failed. It may send a Message, which is how "that failed" reaches the person who asked (ADR-0017).
8. Over HTTP, Users poll their own Message log by cursor, and it is the same read that renders the conversation: both directions, one sequence, ascending, `?after=<seq>` to resume (ADR-0035). Over Nostr they poll nothing: the reply arrives in the client they already use, in the same conversation. They poll the **Decision log** the same way whichever medium they message on, and it is the same read for everyone — nothing notifies them, since Decisions emits no Signal (ADR-0043).
9. A User who wants a Decision checked either asks the Gateway, which is a convenience they have to believe, or fetches the public key and checks it themselves — and hands the artifact to a third party who does the same. That hand-off, out of band and outside the Gateway, is what the signature exists for (ADR-0042).

## Extension points

**Signal Handler**, **Runtime** and **Channel** — all three arbitrary code, none restricted. A Channel is the newest of them and the narrowest: a `name`, a `send` the Messenger calls inside the caller's transaction, and a lifecycle. It registers itself with the Messenger in its own constructor and is switched off by not being constructed, so a second medium is an ordinary Component an Operator writes and keys, with no plugin contract, registry or lifecycle protocol to learn ([ADR-0048](./adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md), [ADR-0021](./adr/0021-the-framework-has-no-plugin-system.md)). One per Messenger, refused at registration. **Users**, the **Messenger**, **Signatures**, **Decisions** and the **Scheduler** are replaceable by construction: don't build ours, build yours. Signatures is the one where that is likely to be wanted, since a deployment holding its identity in an HSM cannot use ours at all — a non-exportable hardware key has no `KeyObject`, and there is no signer-function seam to reach for (ADR-0042). Replacing Signatures alone means keeping Decisions, which holds it as a constructor argument and calls one method on it. Since both are built by hand in `extend` already ([ADR-0045](./adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)), that is constructing your own signer in `extend` and passing it to `createDecisions` in place of ours, with no assembly to leave. Two further qualifications, both messaging's. It is replaceable only *wholesale*: neither the Messenger nor the HTTP Channel exports a route plugin and neither prefix is configurable, so an Operator who wants these routes elsewhere or behind a hook of their own writes their own messaging Producer instead ([ADR-0034](./adr/0034-the-http-messenger-is-an-opinionated-messenger.md)) — which is a different escape from writing a Channel, since a Channel changes the medium and not the log. And a deployment that constructs the Messenger, or the Nostr Channel, is tied to *our* Users component at the schema level rather than the type level, because both declare a `user_id` foreign key onto `saf_users.users.id`: a replacement must own that table ([ADR-0036](./adr/0036-the-http-messengers-user-id-is-a-foreign-key.md), [ADR-0049](./adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)). Replacing only *how a User proves who they are*, while keeping our Tokens, is narrower still: write your own login route and call the Users component's token issuance. That is the seam, and there is no Authenticator interface ([ADR-0030](./adr/0030-passwords-are-traded-for-bearer-tokens.md)). Routes extend through Fastify's plugin system on either server, and further Producers are ordinary code calling the Signal Worker's emit method. There is deliberately no framework-level plugin contract ([ADR-0021](./adr/0021-the-framework-has-no-plugin-system.md)).

## What this framework provides

- No path from a User to the Agent Implementation except through the Gateway.
- Every Signal comes from a trusted Producer. What a Producer puts in a payload is its own contract — the Messenger's contract is the stored Message, whose User id it wrote itself, having got it from the Channel that resolved the sender.
- Every Message involves exactly one User, in one direction, and Users read only their own Message log. Only a User can cause an inbound one: there is no public `receive`, so only a registered Channel can write one and no trusted-code path writes in a User's name (ADR-0048). Over Nostr that holds against a forged envelope too: the seal's author and the rumor's author must agree, which is the whole of what authenticates a sender there (ADR-0049).
- No identifier or counter exposed to a User is influenced by another User's activity, **on a per-User surface**. The Decision log is deliberately shared and is the one exception (ADR-0043).
- A Shared Agent has two identities and no more, each private half never leaves the Gateway, and stopping the Gateway stops all signing and all messaging over Nostr alike. What the Signing identity buys is bounded and stated in ADR-0041 rather than implied; what the Nostr identity buys is stated in ADR-0050, and neither can stand in for the other.

## What it does not provide

Each is a deliberate decision, not an omission:

- **Confidentiality between Users.** The agent reads everything and decides what to send to whom (ADR-0002, ADR-0011).
- **Injection resistance.** Accepted risk, mitigated by guidance to handler authors (ADR-0003).
- **Agent Implementation confinement.** The deployment's responsibility (ADR-0004).
- **Non-repudiation of the conversation.** No party can prove what the agent was told or replied (ADR-0001). Signed Statements do not change this and are not an exception to it: a signature proves that the Operator committed to one string, not what any Party said, not what the agent was asked, and not that a Decision was reached honestly. **Nothing here is evidence about the agent's conduct** (ADR-0041).
- **Any guarantee that a Signed Statement was mediated.** The agent can have any string signed, with no row and no Signal, and nothing records it beyond a log line carrying a digest. An injected agent mints artifacts freely; what it cannot do is take the key with it (ADR-0003, ADR-0042).
- **Detection of a withheld Decision.** A gap in `seq` means a rolled-back transaction, and the Operator owns the database, so withholding is undetectable under any numbering. That needs a hash chain or a transparency log, which ADR-0001 rejected (ADR-0043).
- **Key rotation, for either identity.** No identifier on any record, and nothing generates or stores a key. Rotating the Signing identity leaves the Decision log verifiable only against a public key held out of band (ADR-0041); the Nostr identity is worse, being an address as well as an identity, so every User's client holds the old public key and rotating means telling every one of them (ADR-0050).
- **Isolation of any kind.** A deployment needing real isolation runs two Shared Agents.
- **Protection against a bad Producer.** Producers are trusted by construction (ADR-0020).
- **Availability under a hostile User.** With no timeouts and a serial worker, a User who steers the agent into an unbounded tool loop halts it for every Party until an Operator restarts (ADR-0017).
- **Authentication on the Agent server.** There is none, and reaching the port is access — so keeping it unreachable is the deployment's job, through the bind address its entry point states when it asks for that server (ADR-0004, ADR-0010).
- **Any limit on password guessing.** The login route is unthrottled and no lockout exists. Rate limiting belongs to the deployment's edge, where it survives a second Gateway process; per-User lockout was refused because it hands an attacker a cheaper attack than it prevents (ADR-0030).
- **Account recovery.** No email, no reset flow, no security questions. A forgotten password is trusted code setting a new one (ADR-0014, ADR-0030).
- **Removal of a User.** Nothing deletes or deactivates one. Revoking their Tokens is the whole of it (ADR-0029).

## Known limits

- **One Run at a time, globally.** Throughput is roughly one Run per Run-duration for the whole agent, and a short question queues behind a long task (ADR-0012).
- **Nothing is bounded by time.** No Run timeout, no handler timeout. A hung `bash` call or a wedged handler halts every Party until an Operator restarts the process (ADR-0017).
- **At-most-once processing.** A failed Signal is dropped after partial effect and never re-run.
- **Swapping Agent Implementation means rewriting the agent's configuration** (ADR-0016).
- **The read-side blast radius of a successful injection is everything the agent-facing API exposes** (ADR-0011).

## Open

- Why `pi` was chosen over `openclaw`, which already provides much of this (ADR-0005).
- Whether Users, the Messenger and the Scheduler stay parts of one deployable or become peer services later (ADR-0020). The foreign keys onto `saf_users.users.id` — the Messenger's and the Nostr Channel's — are an argument for one deployable (ADR-0036, ADR-0049).
- Whether removal of a User ever returns, and in what form (ADR-0029).
- Whether a signer-function seam returns for HSM and KMS keys, which the `KeyObject` option cannot express (ADR-0042).
- Whether a `key_id` on a Decision, or key rotation at all, is worth its machinery. The cost of not having it is recorded and unmitigated (ADR-0041).
