# Architecture

This page explains what the parts are and why they are separate. The [guide](./guide) builds a
deployment step by step. The [API reference](./reference/) gives exact signatures.

## The shape

A Shared Agent is one deployable application, assembled from parts. This is the path that one
message takes through it:

```text
   a person                                time
      |                                     |
      v                                     |
   Channel          one medium              |
      |                                     |
      v                                     v
   Messenger  --> Message log            Scheduler
      |                                     |
      |  emits a Signal                     |  emits a Signal
      +------------------+------------------+
                         |
                         v
                  Signal Worker            one Run at a time, globally
                         |
                         v
                  Signal Handler           your code
                         |
                         |  zero or more Prompts
                         v
                      Runtime
                         |
                         v
              Agent Implementation         in a container
                         |
                         |  calls back over HTTP
                         v
                   Agent server            no authentication
```

Those parts sit in three rings, from the inside out:

1. **The Agent Implementation** runs the model. It is `pi` by default, driven by a Runtime, and
   it runs in a container.
2. **The Signal Worker** owns the Signal queue, the dispatch to Handlers, and the Runs. It holds
   no identity and knows nothing about messaging.
3. **Producers** are trusted parts that emit Signals into the Worker. The Messenger and the
   Scheduler are the two that ship.

Only the Gateway connects a person to the agent. There is no other path.

## The loop

One message produces one pass through this loop:

1. A person sends a Message to a **Channel**.
2. The Channel hands it to the **Messenger**, which stores it and emits a **Signal**. Both
   happen in one transaction.
3. The **Signal Worker** takes the oldest pending Signal.
4. It dispatches on the Signal's `kind` to exactly one **Signal Handler**.
5. The Handler returns zero or more **Prompts**, each naming a **Session**.
6. For each Prompt the **Runtime** starts a **Run**.
7. During the Run the agent calls the Agent server. It reads Messages, sends Messages, and reads
   Users.
8. An outbound Message is written to the log and handed to the Channel.
9. The Handler's optional **post phase** runs, and is told whether any Run failed.

The person reads the answer by polling their own Message log, or receives it in their own client,
depending on the Channel.

## The Gateway

A **Gateway** is a record of Components, keyed by names you choose. It starts them in key order
and stops them in the reverse of that order. A failed start unwinds what already started.

A **Component** is a `start` and a `stop`, and nothing else. It has no name, declares no
dependency, and resolves nothing. The parts already hold each other, because you passed them to
each other.

This is not a plugin system and not a registry. A part handed a server registers its routes in
its own constructor.

### createGateway

`createGateway` builds the irreducible infrastructure that every deployment needs:

| Key | What it is |
| --- | --- |
| `db` | The PostgreSQL client. It owns the pool and the `LISTEN` connections. |
| `agentServer` | The server the Agent Implementation reaches. |
| `publicServer` | The server people reach. |
| `worker` | The serial Signal Worker. |

Your `extend` function receives those four and returns components of your own. Your `handlers`
function runs after `extend`, so a Handler can reach a component you built. The reverse is not
possible.

The four infrastructure keys are a type error in what `extend` returns. Otherwise a spread
overwrites one in silence.

`createBareGateway` takes a record of Components and is the escape one layer down. A deployment
whose infrastructure shape itself differs uses it.

### Start order

The Signal Worker is keyed last, so it stops first. Its `stop` is the only one that **waits on
work in flight**: it waits for the Run. That drain therefore runs while every server still
listens and the pool is still open.

Other stops release resources rather than wait. The Db closes its pool and its `LISTEN`
connections, each server closes itself, and the Nostr Channel closes its Relay connection.

Your own components are keyed ahead of the Worker. They start before it and stop after the drain.
That is correct for anything the drain uses, such as the Messenger a post phase calls.

## The two servers

The difference between the two servers is the trust boundary.

| | Public server | Agent server |
| --- | --- | --- |
| Who reaches it | People | The Agent Implementation |
| Authentication | Every registered Auth | **None** |
| Sees Signals | No | Yes |
| Reads any person's Message log | No | Yes |
| Can sign a Statement | No | Yes |
| Can create a User | No | **No** |
| Can set another person's password | No | No |

Neither server creates a User, and neither sets a password for somebody else. Both are methods
that only your own code can call.

Reaching the Agent server port is access to every route on it. Keeping that port unreachable is
the deployment's responsibility.

A person reaches Users, their Auth's own routes, a Channel, Decisions, and two of the three
Signature routes. Over HTTP with Password Auth, those Auth routes are a login, a logout, and a
change of their **own** password. People never see a Signal, and they never reach `POST /sign`.

Both servers describe themselves. Each registers OpenAPI generation **before** `extend` runs,
because route discovery is a hook that fires as each component registers. The document at
`/openapi.json` is therefore the truth about what a Gateway serves.

## The Runtime and the Agent Implementation

The **Runtime** is the narrowest interface in the framework:

```ts
type Runtime = {
  run(prompt: RunPrompt): Promise<RunOutcome>;
};
```

One method, one argument, one outcome. A second Agent Implementation is one function.

The Runtime is held by the Signal Worker and is never started. It is not a Component.

It is called one Run at a time, never concurrently. No implementation needs locking.

`createPiRuntime` runs `pi` in a container. The Prompt goes on standard input, never in the
argument list. Nothing about the model, the provider, or the session directory comes from the
framework: those come from a mounted settings file and from the image.

### The Agent Container

The container plumbing is separate from `pi`, on its own subpath, because a second Agent
Implementation needs it unchanged. It is what `docker run` takes, and what to do with the result.

A **Mount Table** declares what the container reaches on disk. It has one required
`runtimeDir`, which is a path on the **host**, and every entry is written relative to it. The
table verifies nothing about the filesystem, and it refuses four things that cannot mean what
they say:

- An `agentPath` that is not absolute.
- A leading slash on an entry's `path`.
- A `.` or `..` segment in a resolved path.
- Two entries that resolve to one target.

Every Run is `--rm` and `--interactive`, which holds stdin open and gives the container no TTY.
It runs as the Gateway process's own user and group, where the platform reports them. Env values
are redacted in the loggable copy of the command.

## Signals, Runs, and Handlers

A **Signal** is an arrival record, emitted by a trusted Producer. It carries a `kind`, an
arbitrary JSON `payload`, and a timestamp. There is **no user id column**: the Signal Worker
authenticates nobody, so attribution is not a fact it holds. The Messenger's payload carries the
User id, which is trustworthy because that component wrote it.

A **Run** is one Prompt executed in one Session. Its `session` is a plain name, not a foreign
key. Sessions live inside the Agent Implementation.

A **Signal Handler** is arbitrary code and is the primary extension point:

```ts
type SignalHandler<TPayload = unknown> = {
  handle(signal: Signal<TPayload>): readonly Prompt[] | Promise<readonly Prompt[]>;
  post?(signal: Signal<TPayload>, outcome: PostOutcome): void | Promise<void>;
};
```

`handle` receives the Signal and nothing else. There is no context object and no second argument.

Returning zero Prompts means the Signal is done and no Run happens. The arrival record stays, so
a refusal is auditable. Returning many Prompts fans out, and one failure does not stop the rest.

The **post phase** runs once, after every Run from that Signal has finished. It cannot produce
Prompts. It is the whole of the framework's failure handling, and it is how "that failed" reaches
the person who asked.

`templateHandler` is the common case. It renders a Handlebars template into one Prompt. The
template is source text, never a path, and it compiles when the Gateway is built. A template that
does not compile therefore fails construction rather than a Signal.

### At-most-once

A Signal that fails is never retried. A Signal left in `processing` by a stopped Worker is failed
at the next start. Nothing cancels, retries, reprioritizes, or removes a Signal.

This is why the post phase exists, and why a template compiles early.

## Core components

Every part a deployment assembles is a Component. A deployment builds only the ones it wants, and
each one below is a single `create*` call inside `extend`.

### Users

Users owns who exists, and their attributes. It owns no credential.

Creating a User and setting attributes are **methods, never routes**. An agent that can create a
User and give it a credential has made itself an account.

Nothing removes a User. Revoking their Tokens is the whole of it.

Users is not a Producer. A Signal for each login puts a Run behind every authentication, and the
Worker is serial.

### Auth

An **Auth** owns one scheme's secret, and turns a request carrying it into a User:

```ts
type Auth = Component & {
  readonly scheme: string;
  authenticate(request: FastifyRequest): Promise<AuthOutcome>;
};
```

An Auth answers with a User record rather than an id, because the server that walks the Auths can
resolve nothing itself.

The Public server aggregates them. It reads the registered Auths on each request, in registration
order. The first `authenticated` outcome assigns the User and continues. The first `refused`
outcome ends the request. Every 401 carries one challenge per registered **Auth**, so two Auths
that carry one scheme name it twice.

Two Auths ship:

- **Password Auth** owns scrypt hashes and Tokens. A password is traded for a bearer Token. The
  login derives against a fixed dummy digest when the User is unknown, so a miss costs what a hit
  costs.
- **Nostr Auth** verifies a NIP-98 event on every request and issues nothing. It records each
  admitted event, so a credential is spent once. Its freshness window applies in **both**
  directions, so an event stamped in the future is refused rather than valid forever.

Both own tables. An Auth is the component most likely to be assumed stateless, and what an Auth
owns is a secret. A secret is a row.

### The Messenger and Channels

Messaging is two parts.

**The Messenger owns the Message log and reaches nobody.** One table, one `text` per Message, and
one sequence per User across both directions. One cursored read therefore serves both polling and
rendering.

**A Channel is what reaches a person over one medium:**

```ts
type Channel = Component & {
  readonly name: string;
  send<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    message: MessageRecord,
  ): Promise<void>;
};
```

`send` receives an outbound Message inside the transaction that is writing it. The promise is
only that the Message is the Channel's now. Arrival is not something every medium can promise.

**A Channel must not perform the network act inside `send`.** A publish cannot be rolled back and
a transaction can. An implementation does everything knowable synchronously, throws for anything
wrong, and lets whatever must travel travel after the commit.

There is no public `receive`. Registration hands back a private handle, so no other code can put
words in a person's log.

One Channel per Messenger is refused at registration. A deployment runs one medium.

Two Channels ship:

- **The HTTP Channel** has no tables and no work at either end. Its `send` is a no-op, because
  HTTP delivery is the person asking. It serves a submission route and a cursored poll.
- **The Nostr Channel** exchanges NIP-17 private direct messages over one Relay. It owns three
  tables: which key is which User, which envelopes it has read, and which replies the Relay has
  not taken. It registers no route on either server.

The Nostr Channel is the counter-example that says a Channel is not a tableless kind of thing.

### Signatures and Decisions

**Signatures** holds the agent's signing identity and stores nothing at all. What it makes is a
**Signed Statement**: a compact JWS, verifiable by ordinary JOSE tooling in any language.

The deployment loads the key. The framework parses no PEM and generates no keypair. A deployment
brings its own identity or does not start.

**Decisions** is the log of commitments worth keeping. It is global, addressed to nobody, and
read by any authenticated person. It is the framework's only shared read: everyone sees the same
rows.

What a signature proves is narrow. It proves that the Operator committed to this Statement on the
agent's behalf. It proves nothing whatever about the agent's conduct.

Its audience is a party who never touches the Gateway and holds only a public key.

### The Scheduler

The Scheduler emits one fixed kind when a Schedule matures. It is a timer in front of the
ordinary dispatch, and it adds no Handler concept.

It supports recurrence, one-shots, cancellation, and time zones. A missed fire is never replayed:
every next fire is derived strictly forward from now.

Its agent-facing routes are optional. An agent that can wake itself can fill the one serial
Signal lane and never empty it.

### Two identities, held apart

A Shared Agent has two identities and no more.

| | Signing identity | Nostr identity |
| --- | --- | --- |
| Key | Ed25519, or P-256, P-384, P-521 | secp256k1 |
| Lives on | Signatures | The Nostr Channel |
| Answers to | A third party who never touches the Gateway | The people talking to the agent |
| Copying it | Forges the agent's commitments | Impersonates the agent to them |

Neither can be the other. Nostr requires secp256k1, and Signatures refuses that curve. Nothing in
the framework answers
"who is this agent" across both, and nothing tries.

## Data ownership

Each part owns one PostgreSQL schema, named for its subject rather than for the part. No table
references another part's, with six exceptions that all point one way.

Those six are foreign keys onto `saf_users.users.id`. The Messenger declares one, the Nostr
Channel declares two, Password Auth declares two, and Nostr Auth declares one. The Users
component references nobody back.

Half of them belong to an Auth. That is what "the seam is who owns the secret" costs in the
schema.

**The framework applies no DDL.** It ships schema definitions on a `/schema` subpath below each
component, and the Operator applies them with their own `drizzle-kit`. There is no migration
tracking table and no registration order.

Two components own no tables: Signatures, because a Signed Statement is never kept, and the HTTP
Channel, because the log is the Messenger's and HTTP delivery needs no queue.

## What you must provide yourself

Each of these is a deliberate decision, not an omission. Read the whole list before you deploy.

- **Confidentiality between parties.** The agent reads everything and decides what to send to
  whom.
- **Resistance to prompt injection.** This risk is accepted. Guidance to Handler authors is the
  only mitigation.
- **Confinement of the Agent Implementation.** The deployment confines it.
- **An unreachable Agent server.** There is no authentication on it. The bind address your entry
  point states is the whole of the protection.
- **Rate limiting.** The login route is unthrottled and no lockout exists. Rate limiting belongs
  at your edge, where it survives a second Gateway process.
- **Account recovery.** There is no email, no reset flow, and no security questions. A forgotten
  password is trusted code setting a new one.
- **Removal of a person.** Nothing removes or deactivates a User.
- **Key rotation, for either identity.** No record carries a key identifier.
- **Non-repudiation of the conversation.** No party can prove what the agent was told or replied.
  Signed Statements are not an exception to this.
- **Isolation of any kind.** A deployment that needs real isolation runs two Shared Agents.

## Known limits

- **One Run at a time, globally.** Throughput is roughly one Run per Run duration for the whole
  agent. A short question queues behind a long task.
- **Nothing is bounded by time.** There is no Run timeout and no Handler timeout. A wedged call
  halts every party until the Operator restarts the process.
- **At-most-once processing.** A failed Signal is dropped after partial effect.
- **A withheld Decision is undetectable.** A gap in the sequence means a rolled-back transaction,
  and the Operator owns the database.
- **Swapping the Agent Implementation means rewriting the agent's configuration.**

## Where the rationale lives

Every decision above was recorded when it was made, with the alternatives that were refused and
what each choice costs. Those records live in the repository, as numbered decision records under
`docs/adr/`.

This page states what is true. Those records state why.
