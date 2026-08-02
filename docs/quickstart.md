# Quickstart

From a fresh clone to a conversation with the agent, on one machine, in five commands and
four requests.

Everything here is self-contained: you do not need to read an architecture document or
a decision record to get this working. Links to those exist where you might want the
reasoning, and every one of them is optional.

What you will end up with is a **Gateway**: one process that owns a queue of things that
arrived from outside, turns each of them into a Prompt, and runs an AI agent against
that Prompt inside a container. The vocabulary is in [`../CONTEXT.md`](../CONTEXT.md);
the six words you need before you start are:

| Word | Meaning |
| --- | --- |
| **Message** | one thing said, in one direction: a person to the agent, or the agent to them |
| **Signal** | something that arrived from outside and may cause the agent to act |
| **Signal Handler** | your code, which turns a Signal into zero, one, or many Prompts |
| **Run** | one execution of the agent: one Prompt, in one Session |
| **Workspace** | a directory your Handlers and the agent both read and write |
| **Agent Container** | the container a Run happens in: an image, and what it sees on disk |

## Before you start

- **Docker**, running. The agent executes in a container, one fresh container per Run,
  and the Gateway starts them itself.
- **[mise](https://mise.jdx.dev)**, which provisions the pinned Node version. Anything
  else that gives you Node 24 also works.
- **A model API key.** The reference deployment is written for Anthropic and reads
  `ANTHROPIC_API_KEY` from your environment. Any provider `pi` supports works — what
  changes is the variable's name in the entry point and two lines of
  [`../example/settings.json`](../example/settings.json), which is a file you write and
  the framework has never read. See ["Choosing a model is a file you
  mount"](#choosing-a-model-is-a-file-you-mount) below.

## Five commands

```sh
mise install                                          # Node 24
npm ci                                                # dependencies
npm run build                                         # the example imports the package by name
docker compose -f example/compose.yaml up -d --build   # PostgreSQL, the agent image, the networks
ANTHROPIC_API_KEY=sk-ant-... node example/gateway.ts
```

**The last command prints nothing at all**, and that is what a healthy Gateway looks like.
Nothing announces that either server started. One call binds both ports, opens the pool
and starts the worker, and it says nothing about any of it — the framework logs no
startup line anywhere, and any line you want about one is yours to write next to that
call.

Nothing else happens either, and that is the other half of the silence. This deployment's
only Producer is the **HTTP Messenger**, so the first Signal this Gateway ever sees is a
Message somebody posted, and until somebody posts one there is nothing to claim and nothing
to run. `gateway.ts` takes no arguments, because there is nothing left to say to it from a
shell: a person logs in over the Public server, posts a Message, and reads the agent's
answer back, which is [the next section](#a-conversation-in-four-requests).

`Ctrl-C` stops it — after the Run in flight has finished, which is not instant and is
[the part of shutdown nothing can fix for you](#shutdown-is-two-lines-and-the-policy-is-yours). It
keeps running because a Gateway is a server, and you want it up for the four requests below.

### Why `npm run build` is in that list

`example/gateway.ts` imports `shared-agent-framework` **by name**, exactly as your own
entry point in your own repository would. Inside this repository that name resolves to
`dist/`, which is generated and not committed — so the build has to have happened once.
It is in the list rather than hidden in a script because the alternative was an example
that reaches into `src/`, and then the reference for how to write an entry point would
not look like an entry point.

### What the one Docker command did

Four things: built the agent image from
[`../example/agent/Dockerfile`](../example/agent/Dockerfile), started PostgreSQL on
**port 5433**, created two networks, and ran the agent image once so you can see that
`pi` is really in it:

```sh
docker compose -f example/compose.yaml ps -a       # postgres healthy; agent-image Exited (0)
docker compose -f example/compose.yaml logs agent-image   # 0.83.0
```

That `Exited (0)` container is meant to be there. Real agent containers are started by
the Gateway, one per Run, and are never services in this file.

**5433, not 5432**, so that this deployment and the `saf-pg` container the test suite
wants can be up at the same time. Set `DATABASE_URL` to override it.

Notice what is *not* in that compose file: **the Gateway**. It runs on your host as an
ordinary Node process. That is deliberate — see
["Why the Gateway is not in the compose file"](#why-the-gateway-is-not-in-the-compose-file).

## A conversation, in four requests

The Gateway is up and nothing has arrived, so nothing has happened. Four requests take it
from a silent process to an answer, and each one below is followed by what it really
answered.

**One: a User**, created out of band on the **Agent** server. `POST /users` takes a password
and nothing else, and the id it answers with is the one thing you have to keep, because a
User has no natural key: no email, no username, nothing to match on later.

```sh
curl -s -XPOST localhost:7411/users -H 'content-type: application/json' \
  -d '{"password":"correct horse battery staple"}'
```

```json
{"id":"3a577cbb-da46-44d1-8032-e2549fcd1507","attributes":{},"createdAt":"2026-08-02T16:37:09.756Z"}
```

**Two: a Token**, bought with that password on the **Public** server. This is the only
response that will ever carry its plaintext:

```sh
curl -s -XPOST localhost:8080/auth/tokens -H 'content-type: application/json' \
  -d '{"user":"3a577cbb-da46-44d1-8032-e2549fcd1507","password":"correct horse battery staple"}'
```

```json
{"token":"saf_qEfrXGS-ld51ieI3atp3E6sG6cwzQHk4Csj5iPhUfGY",
 "expiresAt":"2026-09-01T16:37:15.517Z",
 "user":{"id":"3a577cbb-…","attributes":{},"createdAt":"2026-08-02T16:37:09.756Z"}}
```

**Three: a Message**, posted with that Token. `POST /messages` on the Public server is the
whole of a person's way in. The body is `{ "text": … }` and it takes nothing else: the sender
is the User the Token named, so there is no field a client could put a person in and
therefore nothing to guard.

```sh
TOKEN=saf_qEfrXGS-ld51ieI3atp3E6sG6cwzQHk4Csj5iPhUfGY
curl -s -XPOST localhost:8080/messages -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"text":"Is anything waiting for me?"}'
```

A **201**, carrying the Message as it was stored, which is the same record shape every other
surface of this part answers with:

```json
{"id":"50c52d4d-d1b2-4ef5-bfe2-da1bc8247bc5","userId":"3a577cbb-…","direction":"inbound",
 "seq":1,"text":"Is anything waiting for me?","createdAt":"2026-08-02T16:37:20.172Z"}
```

By the time that response reaches you the Signal is already queued. The Message row and the
Signal that wakes the worker for it are **one transaction**, so what somebody said and the
fact that anybody was told about it commit together or neither does, and now the Gateway has
something to say, one JSON line at a time:

```
Signal claimed     {"signalId":"641c2f87-…","kind":"message.received"}
Run started        {"runId":"7f1a08a4-…","session":"user_3a577cbb-da46-44d1-8032-e2549fcd1507"}
Run finished       {"runId":"7f1a08a4-…","session":"user_3a577cbb-da46-44d1-8032-e2549fcd1507"}
Signal finished    {"signalId":"641c2f87-…","state":"done"}
```

The `kind` is the constant the Messenger exports, `message.received`, and it is the only one
this deployment has a Handler for. The Session name is the deployment's own choice, made by
that Handler in `gateway.ts`: `user_<the User's id>`, which is why everything one person says
goes to one Session and the agent remembers them between Messages.

**Four: the answer**, read back with `after=` the last `seq` you have seen:

```sh
curl -s "localhost:8080/messages?after=1" -H "authorization: Bearer $TOKEN"
```

```json
{"messages":[{"id":"a0804873-…","userId":"3a577cbb-…","direction":"outbound","seq":2,
  "text":"Nothing is waiting, and I have written it down for you.",
  "createdAt":"2026-08-02T16:37:21.538Z"}]}
```

That Message was written by the agent, from inside its container, with `curl` against the
Agent server. `POST /messages` there is the only thing in this deployment that reaches a
person at all, and both the Prompt and
[`../example/AGENTS.md`](../example/AGENTS.md) tell it so: a Run records that it finished and
not what the agent said, so an answer written into its own conversation or into a file in the
Workspace arrives nowhere. Until it makes that call your poll answers `{"messages":[]}`, and
[a client keeps asking](#three-things-about-messages-and-none-of-them-is-a-bug).

### Three motions, and no fourth

One route serves the whole conversation, both directions, and every page comes back
**ascending by `seq`**, so a client concatenates pages without reversing anything:

| Request | What a client is doing with it |
| --- | --- |
| `GET /messages` | opening: the newest `limit` Messages, which is the end of the conversation |
| `GET /messages?before=N` | scrolling up: the newest `limit` strictly below `seq` N |
| `GET /messages?after=N` | polling: everything above `seq` N, oldest first, capped at `limit` |

Ask five more times and there is a log to page through. Against twelve Messages, with
`limit=3` so the paging is visible at all:

```sh
curl -s "localhost:8080/messages?limit=3"           -H "authorization: Bearer $TOKEN"   # seq 10, 11, 12
curl -s "localhost:8080/messages?before=10&limit=3" -H "authorization: Bearer $TOKEN"   # seq  7,  8,  9
curl -s "localhost:8080/messages?before=7&limit=3"  -H "authorization: Bearer $TOKEN"   # seq  4,  5,  6
curl -s "localhost:8080/messages?after=10"          -H "authorization: Bearer $TOKEN"   # seq 11, 12
```

The first line is what a client asks on open, the next two are one scroll continued upwards by
passing the lowest `seq` of the page it already has, and the last is the poll it repeats
forever. Both cursors are strict, so the two directions from one number partition the log
around it and neither returns the Message it names: paging up and then polling forward
reconstructs a conversation exactly once, with nothing dropped and nothing repeated.

Seven things about that surface, and most of them are refusals:

- **`seq` is one person's own numbering**, from 1, across both directions. Nothing about how
  busy the agent is with anybody else is legible in it, and the pair `(user, seq)` is unique,
  which is what enforces that rather than a convention.
- **Both cursors at once is a 400.** `after` and `before` describe two different windows, so
  neither quietly wins: *"pass after to walk forwards, before to walk backwards, or neither
  for the newest page."*
- **An unknown query parameter is a 400**, not a request answered with everything: *"A
  Message log is read by cursor and cannot be searched or filtered."* There is no text
  matching, no field matching, and no `direction` parameter either. A client that wants one
  side of the conversation filters the page it already has.
- **No Token is a 401**, and it is the User Directory's own single refusal rather than
  anything of the Messenger's: both Public routes take `users.requireUser` as one option and
  this part authenticates nobody.
- **An empty `text` is a 400**, so a stray keypress does not start a Run. There is no maximum
  and there will not be one: Fastify's 1 MB `bodyLimit` is already the bound and it is yours
  to raise on the server you constructed.
- **`after=0` asks for the log from its beginning**, oldest first, which no other spelling
  expresses: no cursor at all means the *newest* page, and `after=1` would skip the first
  Message.
- **`limit` defaults to 50 and caps at 200**, and there is no `hasMore` in the envelope
  because `messages.length === limit` says it.

## Seeing what happened

The Gateway's own record lives in PostgreSQL, and the agent reads it over HTTP. So can
you:

```sh
curl -s http://127.0.0.1:7411/signals | jq
curl -s http://127.0.0.1:7411/runs | jq
curl -s "http://127.0.0.1:7411/messages?user=3a577cbb-…" | jq
```

A Run row carries the exact Prompt the agent was given, its Session, its state, its
timings, and — if it failed — why, in the provider's own words. That `error` column is
the first place to look when something goes wrong, and usually the only place you need.

The third of those is the same log the person read in step four, from the side the agent
reads it. Every route on this server is unauthenticated and unscoped, so it needs no Token to
see somebody's conversation, and `user` is nonetheless **required** on it: `seq` is per
person, so there is no such thing as a page of everybody's Messages at once.

The Run also leaves things on disk, under `example/state/`:

```
example/state/workspace/            the Workspace: your Handlers and the agent share it
example/state/agent/                the agent's own directory: credentials, trust, tooling,
                                    and the Session transcripts
```

Those two directories are **the entry point's**, `mkdir`ed by `gateway.ts` itself a few
lines before it opens the Db. The framework creates no directory anywhere, so creating
what your mounts point at is the deployment's job rather than a courtesy —
[a mount source that is not there](#four-things-nothing-checks) is what happens when one
is missing. What ends up inside them is the agent's, written as your own uid.

Two, not three. There is no Session root: the framework passes no `--session-dir` and
names no path inside `pi`, so Sessions live wherever `pi` puts them, which is under the
agent directory you mounted. Ask a second question in the same Session and the agent
remembers the first — because that one mount survived the container, and for no other
reason.

### Where the transcripts go, and what it costs

`pi` chooses, and what it chooses is one directory. With no `--session-dir` it falls back
to `<agent directory>/sessions`, and the one thing that shards that shards it by the
*working directory* — one subdirectory named after the path, `--workspace--` for
`/workspace`, with one `.jsonl` per Session inside it. Your image declares one `WORKDIR`,
so that is **one directory for the whole deployment**:

```
example/state/agent/sessions/--workspace--/2026-08-02T16-37-21-400Z_user_3a577cbb-….jsonl
example/state/agent/sessions/--workspace--/2026-08-02T17-02-44-901Z_run_51b54b31-….jsonl
```

The number that matters is what a Run reads: resolving `--session-id` calls
`SessionManager.list`, which **reads and parses every `.jsonl` in that directory**,
including each file's entire message text (verified in `pi@0.83.0`). So every Run parses
every transcript the deployment has ever accumulated, on the hot path, growing without
bound, and nothing prunes.

**You cannot avoid it.** A `sessionDir` in your `settings.json` moves the directory;
nothing shards it. This is the price of the framework naming no path inside a program it
does not depend on, and
[ADR-0025](./adr/0025-the-pi-adapter-spawns-one-confined-process-per-run.md) accepts it
rather than mitigating it — every fix means carrying a `pi` path through the framework
again. If your deployment accumulates Sessions faster than you expected, archiving old
`.jsonl` files out of that directory is the whole of the remedy, and it is yours.

### Two files in there are not what they look like

After the first Run you will find an **empty `example/state/workspace/AGENTS.md`** and an
**empty `example/state/agent/settings.json`**, and neither is the file the agent read. A
mount's *target* is created by the daemon when it is not already there, and the real files
are `example/AGENTS.md` and `example/settings.json`, mounted over those paths read-only on
every Run. Editing the empty ones changes nothing and deleting them changes nothing; the
files to edit are the committed ones.

## What the framework is told about the agent

One value, with one required field. An **Agent Container** is the container a Run happens
in — an image, and what the container running it sees — and it is inert: it creates no
directory, checks no path and starts nothing, resolving to container arguments and no
more. The whole of the reference deployment's is one call:

```ts
const runtime = createPiRuntime({
  image: "saf-agent:0.83.0",
  env: { ANTHROPIC_API_KEY: apiKey },
  networks: ["saf_agent"],
  mounts: {
    entries: [
      { containerPath: "/workspace", gatewayPath: workspace },
      { containerPath: "/home/agent/.pi/agent", gatewayPath: agentDir },
      {
        containerPath: "/workspace/AGENTS.md",
        gatewayPath: path.join(import.meta.dirname, "AGENTS.md"),
        readOnly: true,
      },
      {
        containerPath: "/home/agent/.pi/agent/settings.json",
        gatewayPath: path.join(import.meta.dirname, "settings.json"),
        readOnly: true,
      },
    ],
  },
});
```

Eight fields, and seven of them are optional — a default, or a fact most deployments do
not have:

| Field | |
| --- | --- |
| `image` | **the only required field**, and the only one this deployment could not have left out |
| `mounts` | the **Mount Table**: what the container sees on disk. Optional — an image that bakes in its own configuration and keeps nothing between Runs mounts nothing |
| `entrypoint` | what to run inside the image, overriding its own `ENTRYPOINT`. `pi` defaults it to `["pi"]` |
| `networks` | one `--network` each, plural because a container can join several. **No default**: say nothing and you get the container runtime's shared bridge |
| `env` | the whole of the agent's environment. This process's own is deliberately **not** inherited, which is much of why the agent is in a container at all |
| `extraArgs` | container flags the framework does not model, spliced **last**, so one here also overrides one the framework set |
| `containerCommand` | `["docker"]`; `["podman"]` works |
| `logger` | yours, if you want [the line that diagnoses a mount](#the-line-you-need-to-diagnose-a-mount-or-a-network-is-off-by-default) |

The Mount Table is a **field of it**, not a peer. One entry is one `--mount type=bind`: a
`containerPath`, the `gatewayPath` it comes from on this machine, and `readOnly` if the
agent must be unable to change it. An entry may name a directory or a single file, and the
declaration does not say which, because nothing in the Mount Table looks. Who the
container runs as is not in the table and is not configuration at all — always this
process's own `uid:gid`
([ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)).

Notice what is **not** in any of it: no model, no provider, no working directory, no agent
directory, no Session root. Nothing in an Agent Container is `pi`-shaped, so reading one
tells you about containers and not about an agent. The model and the provider are now
[a file you mount](#choosing-a-model-is-a-file-you-mount); the working directory and the
agent directory are [two lines of your Dockerfile](#no-agent-image-is-published); and the
Session root is simply gone, because `pi` resolves its own.

`createPiRuntime` turns that declaration into a **Runtime**: the single thing the Signal
Worker is handed, with a single method on it, `run(prompt)`. Almost all of what it returns
is generic — an **Agent Container Runtime**, which owns the argument assembly, the
confinement flags, the process, the redaction and the diagnosis of a failure — and what
`pi` contributes to it is [one function](#a-second-agent-implementation-is-one-function).

## Telling the agent about the Agent server

The framework does not tell the agent anything. It writes no file, passes no system
prompt, and holds no text about itself — so an agent nobody tells about the Agent server
never calls it. Telling it is yours, and **this section is what you copy from.**

The mechanism is `pi`'s own: it looks for `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` or
`CLAUDE.MD` in its working directory and that directory's ancestors, and its working
directory is the `WORKDIR` your image declares. So you point a mount at that path and put
a file in it, and it is found. The reference deployment commits
[`../example/AGENTS.md`](../example/AGENTS.md) and mounts it there, **read-only**, as the
third entry of its Mount Table:

```ts
{
  containerPath: "/workspace/AGENTS.md",
  gatewayPath: path.join(import.meta.dirname, "AGENTS.md"),
  readOnly: true,
}
```

Read-only, and a single **file** entry rather than a directory, is the whole shape. The
Workspace around it stays writable, so `pi`'s own tooling and your Handlers are
unaffected, while a Run that is talked into rewriting the agent's instructions gets
`EROFS` instead. That property used to be held by the framework rewriting the file before
every single Run; the container runtime holds it by construction now, and holds it even
for a Run that never finishes.

### The routes

All JSON, all on the Agent server, and **all unscoped**. Which of them exist is a
consequence of which parts your entry point handed that server to: the first four are the
Signal Worker's, the next three are there because the reference deployment hands the Agent
server to the User Directory as well, and the last two because it hands it to the HTTP
Messenger.

| Route | Answers |
| --- | --- |
| `GET /signals?limit=&kind=` | `{ "signals": [ … ] }`, newest first |
| `GET /signals/<id>` | one Signal, or 404 |
| `GET /runs?limit=&signalId=` | `{ "runs": [ … ] }`, newest first |
| `GET /runs/<id>` | one Run, or 404 |
| `GET /users?limit=` | `{ "users": [ … ] }`, newest first |
| `GET /users/<id>` | one User, or 404 |
| `POST /users` | the User it created |
| `GET /messages?user=&after=&before=&limit=` | `{ "messages": [ … ] }`, ascending by `seq` |
| `POST /messages` | the Message it sent to one User, or 404 |

A **Signal** is `{ id, kind, payload, emittedAt, state, error }`. `payload` is arbitrary
JSON, exactly as the Producer wrote it. `emittedAt` is an ISO 8601 string, because JSON
has no date. `state` is one of `pending`, `processing`, `done`, `failed`, and `error` is a
string or `null`.

A **Run** is `{ id, signalId, session, prompt, state, error, startedAt, endedAt }`.
`session` is a plain name: a Handler asking for a fresh Session writes `null`, and the
Signal Worker names it `run_<the Run's id>` before the Run starts, so every Run recorded
by this version has one. It is still typed `string | null`, because a Run recorded before
the Worker did that reads back the way it was written. `state`
is one of `pending`, `running`, `done`, `failed`. The timings are ISO 8601 strings, or
`null` for a Run that has not reached that point. The Run executing right now is in there,
and so is its Signal.

A **User** is `{ id, attributes, createdAt }`. `attributes` is arbitrary JSON that the
deployment's own code put there and is the whole of what anything means by authorization.

A **Message** is `{ id, userId, direction, seq, text, createdAt }`, where `direction` is
`inbound` (from the person) or `outbound` (from the agent) and `seq` numbers one person's
Messages from 1 across both directions. In this deployment a Signal's `payload` **is** one of
these, so a Signal the agent reads is something somebody said with the person it came from
attached. What those two routes mean to an agent, and the four things the API will not let it
do with them, are stated where the agent actually reads them: *Reaching a person* in
[`../example/AGENTS.md`](../example/AGENTS.md). They are deliberately not restated here,
because two copies of one paragraph drift.

Four facts about the surface that an agent's instructions should carry, because each of
them is a request that would otherwise be written and quietly misunderstood:

- **There is no credential.** Reaching the port is access. Nothing to send, nothing to
  obtain, nothing to rotate.
- **Reads are not scoped.** Every Signal, every Run, every User and any person's Message log,
  whatever Session the Run asking is in. There is no `session` parameter anywhere, and an
  unknown query parameter is a **400** rather than a request answered with everything — so a
  deployment that believed it was scoping something finds out at once. The Message log's
  required `user` is the one apparent exception and is not one: it narrows nothing the agent
  could otherwise have seen, and it is required because `seq` is per person and cannot cursor
  an interleaved result.
- **`limit` defaults to 50 and caps at 200.** Asking for more is refused rather than
  quietly reduced. The Message log is the only thing here with a cursor at all, so records
  past the cap are otherwise reached by narrowing with `kind` or `signalId` and not by
  paging.
- **Two things here write, and neither is a lever.** `POST /users` takes a password and no
  attributes, so an agent talked into creating a User cannot make it a privileged one.
  `POST /messages` addresses exactly one User and is always `outbound`, decided by the server
  it arrived on, so no instruction the agent is given can broadcast or put words in somebody's
  mouth. Everything else is immutable: a Signal but for the state the worker gives it, a Run
  which is the worker's record of its own work, and a Message once written. Setting
  attributes, replacing a password, issuing a Token and revoking one are methods on the User
  Directory and no route at all.

`pi` ships no HTTP client, so the agent calls this with its shell tool and `curl` — which
is why `curl` is one of the [three things the agent's image
needs](#no-agent-image-is-published):

```sh
curl -s "http://host.docker.internal:7411/signals?limit=5"
```

That host name is the reference deployment's, and it is
[not derivable from where the server binds](#where-the-agent-reaches-you-is-not-derivable-from-where-the-server-binds).

### This copy can go stale

The routes and the field shapes above are the framework's; the file in your Workspace is a
**copy** of them, made by hand. Nothing keeps the two in sync — the framework does not
write that file, does not read it, and cannot see that it has drifted. So check it against
this page when you upgrade.

The failure mode is worth knowing because it is quiet: a stale copy does not produce an
error, it produces an agent that asks for something that is not there, gets a 400 or a
404, and stops asking. That reads as a model being unhelpful rather than as a deployment
being out of date.

## What the entry point actually does

Read [`../example/gateway.ts`](../example/gateway.ts) — ninety-one lines of code under
three hundred and ninety-seven with the comments, and the best documentation this project
has. Eighteen of those lines are imports; the rest are the Agent Container above, the two
directories it creates, the parts themselves, and the one thing at the bottom the
framework does not ship. Nothing in the framework represents the Gateway: there is no
object to construct, no registry to add parts to and no plugin system. The file *is* the
Gateway, and every line of it is a part being constructed and handed to another part.

Three things in it are the framework's to describe and **yours to do**, and all three are
near the top. It `mkdir`s `state/workspace` and `state/agent`, because it is about to
declare both as mounts and nothing else will create them. An `AGENTS.md` sits committed
beside it — not written by anything at runtime, just a file in the repository — which the
Mount Table's third entry mounts into the Workspace read-only, and which is the only thing
that tells the agent the Agent server exists. And a `settings.json` sits beside *that*,
mounted the same way, which is the only thing that tells the agent which model to use. The
framework creates no directory and writes no file, ever
([ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)).

The whole of an assembly is four steps — **construct, migrate, order, start** — and the
third of them is the one thing about that file that is not arbitrary.

One word before them. A **Component** is a part with something to run: a `name`, a
`start` and a `stop`, and nothing else at all. Four things here are Components — the Db,
the two servers and the Signal Worker — and two parts deliberately are not: the User
Directory and the HTTP Messenger, neither of which has anything to start or anything to
release. It is not a plugin contract: nothing declares a dependency, nothing is resolved,
and parts still hold each other because you passed them to each other.

1. **Construct.** The Db from one PostgreSQL URL, two `Fastify()` instances as Components,
   the Runtime, the User Directory, the Signal Worker with its Handler map and the HTTP
   Messenger, each handed what it needs as an ordinary constructor option. Construction is
   also the whole of the wiring: a part handed a server registers its routes on that server,
   and a part with tables of its own registers its migration descriptor with the Db, so there is
   no third item on a checklist for you to forget
   ([ADR-0032](./adr/0032-components-wire-themselves-at-construction.md)). Nothing here
   touches the network. Constructing the Runtime does settle the Agent Container on the
   spot, as a pure function of what you wrote: a missing image, a relative path on either
   side of a mount entry, or an entry no `hostPaths` prefix covers is refused **at this
   line** rather than at the first Signal. Those three are the whole of what can be — see
   [what nothing checks](#four-things-nothing-checks).
2. **Migrate.** `await db.migrate()`, which takes no arguments and applies whatever
   registered — so it comes *after* the constructing, because constructing is what
   registers. It is never a side effect of opening the Db and never a side effect of
   starting one, which is what lets it also be
   [a deploy step of its own](#migrations-as-a-separate-step) — and with more than one
   replica it has to be.
3. **Order.** `components([db, agentServer, worker, publicServer])`: a list you write,
   started in that order and stopped in the reverse of it. Every position is a claim about
   what must still be working while the thing after it shuts down, the reasoning for each
   is in the comment above the list, and **nothing checks any of it**. The framework
   cannot: whether the agent calls the Agent server mid-Run is the model's choice, not
   something a test can produce
   ([ADR-0031](./adr/0031-parts-that-run-are-components.md)). The listen-before-register
   rule imposes nothing on this list, because registration already happened in step 1.
4. **Start.** `await gateway.start()`. One call opens the pool, refuses to serve if any
   registered schema is behind the migration folder shipped beside it, starts the worker
   and binds the two ports. A part that throws stops everything that had already started,
   in reverse, and then rethrows that part's own error — so a Gateway that could not boot
   holds no pool open and tells you which part failed. Both bind addresses are stated back
   in step 1 with no framework default behind either — see
   ["Where each server binds is yours to state"](#where-each-server-binds-is-yours-to-state).

Then the one thing the framework does not do for you, at the bottom of the file:
**shutdown**. Emitting Signals used to be the second of two, and the last line of the file
used to be a loop that made up a user id because nothing there could hold a real person. The
HTTP Messenger is the Producer now.

### The HTTP Messenger is one more object, with one placement that matters

Messaging is one call and five options, and every one of them is required:

```ts
const messenger = createHttpMessenger({ db, users, worker, publicServer, agentServer });
```

That call registers its own migration descriptor with the Db and its two route groups at
`/messages`, the Public pair behind the Directory's `requireUser` and the Agent pair behind
no credential at all, which is the whole of the wiring. Nothing here is a capability to leave
out, unlike the User Directory's servers: a Messenger with no Public server cannot be reached
by the people it exists for, and one with no Agent server cannot be answered, so each is a
broken Messenger rather than a smaller one and both are unconstructable instead of documented.
No route plugin is exported and no prefix is configurable either, which is this part's one
stated departure from the door-out pattern every other part follows: these routes are half of
a contract whose other half is the Signal `kind`, the record shape and a client written
against both, so an Operator who needs them somewhere else wants a messaging part of their own
([ADR-0034](./adr/0034-the-http-messenger-is-an-opinionated-messenger.md),
[ADR-0021](./adr/0021-the-framework-has-no-plugin-system.md)).

Two more things are exported beside the constructor, and they are the Signal contract a
Handler is written against: **`messageReceivedKind`**, so that a Handler map is not a string
literal that can drift, and **`MessageRecord`**, because the payload *is* the Message record
flat, so `templateHandler<MessageRecord>` type-checks a template's data function against the
same shape every surface of this part answers with. Registering no Handler for that `kind` is
a 201 followed by a permanently failed Signal: the Message is stored and readable, the agent
never sees it, and the failure is visible only on the Signal row. That is not guarded, and it
is the one thing to check first if Messages arrive and nothing runs.

Two things about where that line goes, and only one of them is a matter of taste.

**It is in no start order.** The Messenger is not a Component: no timers, no connection of its
own, nothing to start and nothing to release, so a place in that list would imply its position
mattered when it does not
([ADR-0031](./adr/0031-parts-that-run-are-components.md)). The day delivery stops being
polling it becomes one, with a `LISTEN` registration and a `stop` that closes open responses.

**It is constructed after the User Directory, and that one is load-bearing.**
`messages.user_id` is a foreign key onto `saf_users.users.id`
([ADR-0036](./adr/0036-the-http-messengers-user-id-is-a-foreign-key.md)), `db.migrate()`
applies descriptors in registration order, and registration order is construction order, so
the other way round fails on this part's first migration with `schema "saf_users" does not
exist`. In *this* file the wrong order cannot be written at all, and by nothing clever: the
Directory is an argument to the call, so putting it first is a TypeScript error about a
variable used before its declaration. That is the whole of the check, and it is a property of
taking the object rather than something the framework does. Where descriptors are registered
by hand instead, as [a migration job of its own](#migrations-as-a-separate-step) does, there
is no such argument and no such error, and the failure at `migrate` is the only thing that
says so.

What the object itself carries, once the wiring has happened, is the two things no request can
express. `send(tx, userId, text)` writes an outbound Message from inside a transaction of
yours, so answering somebody and recording in your own tables why cannot come apart, and it
returns the record because `history` takes no transaction and therefore cannot see your own
uncommitted write. `history(userId, options?)` reads any person's whole log, with the same
cursor the routes take, so a Handler can build a Prompt from more than the one Message that
woke it. There is deliberately no method that writes an **inbound** Message: `direction` is
decided by the server a request arrived on, and trusted code gets no path that puts words in a
User's mouth. The reference deployment holds the object for the first of the two, and for one
purpose: its Handler's `post` phase tells the person when the Run failed, which is otherwise
the one event nothing in a Gateway can report, since a failed Run is never retried and
somebody is waiting. A deployment whose Handlers neither send nor read may call
`createHttpMessenger` and drop the result.

## Things that will bite you

These are not edge cases. Every one of them is something you meet on day one.

### Where each server binds is yours to state

The framework has no opinion about either bind address, and supplies no default for
either. Both are arguments to the `serverComponent` calls near the top of your own entry
point, where the reference deployment writes them next to each other:

```ts
const publicServer = serverComponent("public server", Fastify(), { port: 8080, host: "0.0.0.0" });
const agentServer = serverComponent("agent server", Fastify(), { port: 7411, host: "localhost" });
```

`serverComponent` constructs nothing and defaults nothing. You call `Fastify()` with your
own options and hold the instance; it holds the address until `start`, because `Fastify()`
takes none and `listen` is the call a `start` has to make. That third argument is
Fastify's own `listen` options object, handed over unread.

The asymmetry is the reason there are two servers. The Public server is the one meant to
be reached, and a Public server on loopback inside a container answers nobody — a
deployment that looks healthy and serves no User. The Agent server is the opposite: it
has no authentication, so **reaching the port is access**, and loopback is what keeps
that true. Moving it should be something you did on purpose, which is why it is written
out rather than inherited.

Two details worth knowing. `localhost` and `127.0.0.1` are not the same instruction to
Fastify — `localhost` binds both loopback addresses, IPv4 and IPv6, and `127.0.0.1` binds
only the first, so `localhost` is the one to write. And `localhost` is also Fastify's own
default, so an options object that says nothing about `host` is already on loopback; the
reference deployment states it anyway, because the most consequential value in a
deployment should not be one you have to know a library's defaults to find.

### Where the agent reaches you is not derivable from where the server binds

Where the Agent server's socket **binds** and how the agent's container **reaches** it
are two separate values, and nothing can compute either from the other. The framework
holds neither. The first is the `host` and `port` you hand `serverComponent`; the
second is a **string in your own `AGENTS.md`**, and there is nowhere else for it to be —
the Agent Container has no field for it, nothing has ever read it, and the Runtime never
sees that address at all.

The reference deployment uses `http://host.docker.internal:7411` with a loopback bind,
and that works **on Docker Desktop**, which routes that name to the host including its
loopback interface.

**On a plain Linux daemon it does not.** There, you need both of:

- `--add-host=host.docker.internal:host-gateway` in the Agent Container's `extraArgs`,
  because the name does not otherwise exist; and
- the Agent server bound somewhere the bridge can reach — so `host: "0.0.0.0"` or the
  bridge address, which means it is **no longer on loopback** and the warning in
  ["the Agent server is unauthenticated"](#the-agent-server-is-unauthenticated) now
  applies to you.

On a shared Compose network where the Gateway is itself a service, neither is needed: the
address is `http://<service-name>:7411` and the bind stays inside the network.

If you get this wrong the symptom is at least legible: the agent's `curl` fails and the
agent says so. The two values are in two files that sit next to each other — the
`serverComponent` call in `gateway.ts`, and the URL in `AGENTS.md` beside it. Read them
together; nothing else has to be consulted, and changing one always means changing the
other, which is why the reference deployment's `AGENTS.md` says so in its own last
section.

### The agent's container runs as *your* uid

With bind mounts, files the agent writes are owned by whoever the container runs as. So
the container always runs as the Gateway process's own `uid:gid` — otherwise your Signal
Handlers cannot read what the agent left in the Workspace, and the agent cannot read what
they left for it. There is no field for it: it used to be the Mount Table's and is no
longer configuration at all
([ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)). To
countermand it, put `--user` in `extraArgs`, which is spliced last and so wins.

The consequence: **the mounted directories must be writable by that uid.** In the
reference deployment they are, trivially, because the Gateway runs as you on your own
machine and the directories are under `example/state/`. In a deployment where those
directories come from somewhere else — a volume, a provisioned path, another
container — making them writable by that uid is your job.

Nothing checks it for you. The framework verifies no mount and starts no container at
boot, so an unwritable directory is something the agent meets during a Run — with the
consequence in the next section.

### Four things nothing checks

This is the whole bill for the framework carrying no model, no provider and no path inside
the agent, and it is collected in one place because the person reading it is the person
who pays it.

**Three things are refused where you wrote them**, at construction, as a pure function of
the value: a missing `image`, a relative path on **either** side of a mount entry, and a
`gatewayPath` no `hostPaths` prefix covers. That is the complete list. Everything below is
a file the framework does not read, at a path it was told about rather than chose, for a
program it does not depend on — so it cannot refuse any of it
([ADR-0033](./adr/0033-an-agent-is-a-container-and-one-function.md)).

| What you got wrong | What it looks like |
| --- | --- |
| **No usable model.** `settings.json` missing, not mounted where `pi` looks, or naming a model your key cannot reach | a **permanently failed first Run**, carrying the provider's own message |
| **An agent directory `pi` will not look in.** Your mount's `containerPath` and the image's `PI_CODING_AGENT_DIR` disagree | a **permanently failed first Run**: the mounted `settings.json` is inside that directory too, so `pi` reads no model — and if nothing declares the variable at all, `HOME=/` makes the default `/.pi/agent`, which the agent cannot create |
| **A mount source that is not there.** A typo, or a directory you did not create | a **permanently failed first Run**, refused by the daemon before the agent starts |
| **No mounts at all.** A legitimate deployment, and also what you get by deleting one entry too many | **no failure whatsoever.** Every Run succeeds and the agent quietly forgets: nothing survives a `--rm` container, so every Session is empty every time, and no log line anywhere says so |

The first three all arrive the same way, and the way is the expensive part. A failed Run is
never retried ([ADR-0017](./adr/0017-failed-runs-are-not-retried.md)), so **the Signal that
found your mistake is dead permanently**: fixing it and restarting does not bring that one
back, and if it was a user's question, the user is owed a new one.

Three things soften those three. The message is in the Run's `error` column verbatim, with
the container's stderr appended and its exit code too when that was non-zero, so the first
place you look is the place it is. There is nothing timing-dependent about which Runs fail:
what is wrong is wrong for every Run, so the first Signal after a deploy tells you exactly
what the hundredth would.
And mounts are emitted as `--mount type=bind` and never as `-v`, which is what makes a
missing source a refusal that names the path rather than a `root`-owned empty directory the
daemon invented and the agent then read perfectly happily:

```
docker: Error response from daemon: invalid mount config for type "bind":
bind source path does not exist: /srv/saf/wokspace
```

The fourth softens into nothing, and that is why it is worth reading twice. An empty Mount
Table is deliberately allowed — an image that bakes in its own configuration and keeps
nothing between Runs is the smallest deployment this framework can describe, so the rule
that used to refuse one is gone rather than moved
([ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)). The price
is that the same shape reached by accident produces no signal at all: every Run answers,
every Run is a first Run, and the only symptom is a model that seems to have amnesia.

That symptom has one other cause worth knowing, and it is the second row above with its
teeth pulled. The second row fails loudly only because the reference deployment keeps
`settings.json` **inside** the agent directory, so a directory `pi` does not look in is
also a model it never reads. Bake your settings into the image instead and the same
mismatch stops failing and starts forgetting. So if the agent has amnesia: check that your
mount's `containerPath` is exactly the image's `PI_CODING_AGENT_DIR`, then look for the
`.jsonl` transcripts under it on disk.

### The line you need to diagnose a mount or a network is off by default

The Runtime logs the whole composed container invocation — every flag, every
`--mount`, the image, the network, and `pi`'s own arguments — so that diagnosing a mount
or a network problem never means reading framework source. Since nothing is verified any
more, this line is the whole of what the framework offers for that, which makes it worth
turning on before you need it rather than after. It logs at **`debug`**, and the logger
every part falls back to when you supply none runs at `info`. So by default you do not see
it.

Supply your own logger to get it. Every part takes one, and the seam is structural — four
methods, `debug`/`info`/`warn`/`error`, each taking fields then a message — so anything
your system already logs through satisfies it without wrapping:

```ts
const logger = pino({ level: "debug" });          // or your own object with those four
const runtime = createPiRuntime({ image: "saf-agent:0.83.0", mounts, logger });
const worker = createSignalWorker({ db, runtime, handlers, logger });
```

A second line follows every Run, carrying the two things nothing else records: the
container's exit status, which is *not* the outcome, and its stderr, where a first Run in a
named Session often warns.

Safe to keep in a log file: **every** environment value on that line is replaced, with no
exceptions list, because a list of what is safe to log would have to be right about every
provider's key name forever. The names survive and the values do not. What that costs is
the one value a mount problem used to be diagnosed from — `PI_CODING_AGENT_DIR` is no
longer readable there either, and you read it back out of your own Dockerfile instead.

The line also no longer says where the Session's transcript landed on your own disk, and
nothing does: the framework passes no `--session-dir` and holds no path inside `pi`, so the
reverse lookup that produced it is gone along with the Session root
([ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)). For "the
agent has forgotten everything", the place to look is
[under the agent directory you mounted](#where-the-transcripts-go-and-what-it-costs).

### The agent's network isolates less than it looks like

`compose.yaml` puts the agent on `saf_agent` and PostgreSQL on `saf_db`, and the Agent
Container's `networks: ["saf_agent"]` is what puts the agent there. So the agent **cannot
resolve `postgres`**, which is the point: the Db holds the Gateway's own state and the
agent is supposed to reach it only through the Agent server's read-only routes.

What that does *not* do, and you should know it before you rely on it: a separate bridge
network stops **service-name discovery**, not **host access**. The Gateway is on your host
and the agent has to be able to reach it, so on Docker Desktop — where
`host.docker.internal` reaches the host's loopback interface, which is the whole reason
the Agent server works on `127.0.0.1` — the agent can reach *anything* bound there,
PostgreSQL on 5433 included. What stands between the agent and the Db on this machine
is the password, not the network. (Under a plain Linux daemon a loopback-bound port is
genuinely out of reach, which is the one way that platform is the stricter of the two.)

Two things follow. The credentials in `compose.yaml` are `saf:saf` because this is a local
demo; a real deployment supplies its own through `DATABASE_URL` and does not publish
PostgreSQL's port at all. And the agent's network is worth having as one layer, not as the
boundary.

### Three things about Messages, and none of them is a bug

Each of these is a consequence of a decision rather than something unfinished, and each is
cheaper to read here than to meet in production.

**Nothing deletes a Message.** No route, no TTL, no sweeper, and nothing to configure: the
`messages` table grows forever, exactly as `tokens` does. An Operator who needs it bounded
writes the delete themselves, and should write it knowing what they are deleting. A Session is
a **lossy cache** of this log and not a second copy of it, so history removed here is history
the agent can no longer recover: the transcript it drops when it compacts is the copy that was
never durable. That is also why there is nothing to configure. A retention default would be a
number the framework picked for a log whose value it cannot see.

**A retried POST is a second Message, a second Signal and a second Run**, and nothing in the
Gateway notices. There is no request id, no deduplication and no window. Because a Run can act,
a duplicate here can act twice, which is a different cost from a duplicate row. So a client
should not blind-retry a POST: a submission whose response was lost is one to show a person and
let them decide about, not one to send again on a timer. An `Idempotency-Key` **header** stays
addable later at no cost to the fixed body shape, which is exactly why this is a note rather
than a feature today.

**Delivery is polling.** `?after=<seq>` is the whole of the resume mechanism, so a chat with a
two-second poll is a chat with up to a two-second delay. That is usually invisible next to a
Run: the worker is serial globally, one Run at a time for the whole Gateway, and *that* is the
real latency story. It is nonetheless the first thing an Operator will want to change, and the
answer today is the poll interval, because SSE or long-polling means the Messenger becoming a
Component with a `LISTEN` registration and a `stop` that closes open responses
([ADR-0035](./adr/0035-a-users-messages-are-one-log-read-by-cursor.md)). Nothing about the
data model has to change on the day that arrives, which is why it is deferred rather than
designed around.

### Shutdown is two lines, and the policy is yours

The framework ships **no signal handling at all**: no `SIGINT` handler, no `SIGTERM`
handler, no timeout on the drain and no exit code. What it does ship is the ordering, and
that is what `components` is for — `gateway.stop()` stops in the exact reverse of the list
you started. So the whole of shutdown in the entry point is this:

```ts
for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
```

**Both signal names, and `SIGTERM` is the one that matters.** `SIGINT` is Ctrl-C, but
`docker stop`, systemd and a Kubernetes eviction all send `SIGTERM` — so a Gateway that
handles only the first never drains in the one situation the drain was written for, and a
Signal left `processing` fails permanently on the next boot.

**There is no `process.exit`, deliberately.** Once `stop` has returned, the pool is
closed, the `LISTEN` connection is closed, the sweep interval is cleared and both servers
are shut, so nothing holds the event loop open and the process ends by itself. An exit
call would only be a way to cut the drain short.

Two things follow from `once` rather than `on`. A *different* second signal — Ctrl-C and
then a `docker stop` — calls `stop` again, which is harmless: it pops what it stopped, so
the second call finds nothing to do. A *repeated* signal finds no listener left and gets
Node's default, which kills the process mid-drain. That is an escalation policy, it is
this file's choice, and `process.on` is how you decline it.

The ordering the list encodes, from the reference deployment's
`[db, agentServer, worker, publicServer]`: the **Public server** stops first, so it is
first to stop accepting submissions. The **Signal Worker** next, draining the Run in
flight. The **Agent server** after that, and it is placed before the worker in the start
list precisely so that it closes after the drain — the agent calls its API during a Run,
so closing it earlier refuses the agent its own API mid-Run. The **Db** last, because
everything queries it and the drain queries it on the way down; closing it earlier pulls
the `LISTEN` connection out from under a running Signal Worker, which then logs a dropped
connection and retries forever.

And the part no ordering fixes: **a Run in flight when the signal arrives.** The worker's
`stop` waits for it, which can be minutes, and `gateway.stop()` does not return until it
has. Killing the process instead leaves that Signal marked `processing`; the next start
marks it `failed` and never re-runs it, because it may already have written the Workspace
or made external calls, and replaying it would do all of that twice. Whether that is acceptable, and what to do about it, is a decision every
deployment makes for itself.

### Nothing is bounded by time

**There are no timeouts anywhere.** Not on a Run, not on a Signal Handler, not on a tool
call the agent makes. And the worker is serial *globally* — one Run at a time for the
whole Gateway, whatever the Session — which is the only reason a Workspace shared between
your Handlers and the agent is safe at all.

Put together: **one hung tool call or one wedged Handler halts the Gateway for everybody
until somebody restarts the process.** A user who steers the agent into an unbounded loop
denies service to every other party. This is an accepted risk rather than an oversight —
a number the framework picked would be wrong for every deployment — but it is a real one,
and the mitigation is operational: watch how long Runs take, and be able to restart.

Related, and the same decision: **a failed Run is never retried.** A Signal whose Handler
threw, whose template had a hole in it, or whose `kind` has no Handler at all, is recorded
as `failed` with a reason and is finished. Nothing re-drives it. The Handler's optional
`post` phase runs either way, and is told whether anything failed — that is where
notification and cleanup go.

### The Agent server is unauthenticated

There is no credential on it. **Reaching the port is access**, and what it exposes is
every Signal, every Run and — in the reference deployment, which hands it to the User
Directory too — every User, unscoped by Session or by User.

That is deliberate: a credential is no boundary against the agent, which is the only
party meant to reach it at all. What follows is that keeping the port unreachable is
your whole defence, and that defence is the `host` you hand `serverComponent` and nothing
else. Nothing checks it and nothing warns about it: the framework never sees the address,
and where a server binds is the deployment's to decide and this page's to explain.

The specific trap worth knowing: **publishing a container port inserts firewall rules
that bypass your host's own.** A `ports:` entry that looks like it is behind `ufw` or
`firewalld` is not. If this server ever ends up published, the consequence is not a leak
of some records — the agent-facing surface is the Gateway's whole read side, and anything
that can reach it can also reach whatever else you mounted there.

### Nothing limits password guessing

The reference deployment's Public server carries `POST /auth/tokens`, and it can be
hammered. There is no rate limit, no backoff, and no lockout after failed attempts, and
none is coming from us.

Two reasons, and the second is the load-bearing one. A limiter in this process is the
wrong layer: its counters live in memory, so a second Gateway process doubles every
allowance, and it sits behind whatever proxy is already terminating your TLS and already
able to do this properly. And per-User lockout is worse than nothing — anyone who can
reach the login route could lock a User out on purpose, which is a cheaper attack than the
one it prevents.

So this is the deployment's, at the edge, the same way the Agent server's reachability is.
What we do instead is refuse to help: every failure answers with the same status and the
same body whether the password was wrong or the User does not exist, and a miss still runs
the key derivation against a dummy hash so the response time does not answer the question
either. Guessing is possible; learning who exists is not.

Worth pairing with the cost: password verification is memory-hard *on purpose*, so a flood
of wrong passwords is also a load problem, not only a security one.

## Migrations as a separate step

`gateway.ts` migrates at boot, and **one process on one machine can get away with that.
More than one cannot.** Drizzle's PostgreSQL migrator takes no advisory lock: it reads the
newest row of the tracking table, then opens a transaction and applies everything newer.
Two replicas booting together both decide to apply the same DDL, and all but one die of a
duplicate relation. A rolling deploy is exactly that situation.

So applying migrations is an **explicit call**, never a side effect of opening the Db and
never a side effect of starting one. For more than one replica, run it as a step of its
own and delete the `db.migrate()` line from your entry point:

```sh
node example/migrate.ts       # against the new schema, before anything serves new code
```

Same call, no Gateway involved, and — importantly — no model credential and no agent
image. Each part with tables of its own exports a *migration descriptor*: inert data
naming a folder, a PostgreSQL schema and a tracking table. Constructing a part registers
its descriptor with the Db, and `db.migrate()` applies everything registered, so
`gateway.ts` passes no arguments at all. A migration job constructs no parts, so it
registers the descriptors by hand instead, through the same call the constructors use:

```ts
db.registerMigrations(signalsMigrations, usersMigrations, httpMessagesMigrations);
await db.migrate();
```

The identical descriptor registered twice is one registration. Two *different* folders
naming one tracking table still throw, because that is the failure where Drizzle silently
skips the older folder's migrations and reports success.

**The order of that list is load-bearing, and it is the one thing here that nothing checks.**
Descriptors are applied in registration order, and the HTTP Messenger's first migration adds a
foreign key onto `saf_users.users`, so the User Directory's descriptor comes before it or the
migration fails with `schema "saf_users" does not exist`. In `gateway.ts` that order comes for
free, out of the Messenger taking the Directory as a constructor argument; here they are three
values in a list, and there is nothing in a list that could hold them in order.

**Nothing goes unnoticed if you forget the step.** `db.start()` compares, for every
registered descriptor, the newest migration in the folder shipped beside it against the
newest row of that descriptor's tracking table, and refuses to start if the table is
missing or the database is older — naming the schema. A missed migration is therefore a
startup error you can read rather than a `relation does not exist` from the first request
that happens to touch it. A database that is *ahead* of the code starts normally, because
that is what a rollback looks like.

You never run a schema generation tool. The SQL ships inside the package.

## Making it yours

Seven things you will want, in the order you will want them.

**Your own Signal Handler.** A Handler is a plain object with a `handle` that takes a
Signal and returns Prompts. There is no base class, no context object, and no registration
call — it receives only the Signal, and everything else it needs it closes over from the
entry point, which already holds every object in the Gateway:

```ts
function summarising(workspace: string): SignalHandler<{ file: string }> {
  return {
    handle: (signal) => [{ session: null, text: `Summarise ${workspace}/${signal.payload.file}.` }],
    post: (signal, { failed }) => log.info({ signal: signal.id, failed }, "done with it"),
  };
}
```

`createSignalWorker({ db, runtime, handlers: { "file.arrived": summarising("/workspace") } })`
puts it to work. The Handler map is a **construction option**, not an argument to `start`,
so a Signal Worker with no Handlers is not something you can construct, let alone run.

`session: null` asks for a fresh Session; a string continues a named one. One Session per
user, one per Run, one for the whole agent, or a hybrid — all four are things you just
write, and the framework prefers none of them. It also checks nothing: your name reaches
the Agent Implementation exactly as you wrote it, and one it will not accept fails that
Prompt's Run with its own complaint in the Run's `error` and your name in its `session`.

`templateHandler`, which the reference deployment uses, is one of these and not a special
case. It re-reads its `.hbs` file every Run, so you can edit wording without restarting.
Two things about it to know before you rely on it: substituted values reach the agent
**byte for byte** (no HTML escaping — a Prompt is not a web page), and a reference to a
variable you did not supply **throws** rather than rendering empty. That second one fails
the Signal permanently, which is the trade: a Prompt with a silent hole in it misleads the
agent invisibly, and a failed Signal is in the log with a reason.

**Your own routes.** `publicServer.fastify.register(plugin, { prefix })`, on either
Component. `.fastify` is exactly the instance your own `Fastify()` returned, so its plugin
system is the extension mechanism and there is no contract of ours to satisfy. Register
before `gateway.start()`: Fastify refuses a route registration once a server is listening,
and `start` is what listens.

**Users and authentication.** The reference deployment already does this: it constructs
the **User Directory** and hands it both servers, which is the whole of the wiring. There
is no separate registration call and no descriptor to remember, because handing a part a
server *is* how its routes get registered:

```ts
const users = createUsers({
  db,
  tokenTtl: 30 * 24 * 60 * 60 * 1000,
  agentServer,      // `POST /users` and the two reads, at `/users`
  publicServer,     // logging in, logging out, reading and replacing your own credential, at `/auth`
});
```

**Omitting a server is how you switch that group off.** Leave `agentServer` out and the
agent cannot create a User — there is no flag and no route to guard. Leave both out and
you still have `users` in hand for your own routes.

The prefixes are defaults rather than policy, and the way out of them is the exported
plugins, which are ordinary Fastify plugins with no prefix of their own:

```ts
await publicServer.fastify.register(users.publicRoutes, { prefix: "/login" });
```

That is the escape hatch for a prefix of your own, for registering inside your own
encapsulated plugin, or for putting a hook in front of the group. Do one or the other for
a given group, not both, or the routes exist twice.

A User logs in with `POST /auth/tokens` and gets a bearer Token back; every route of yours
that should require one takes `users.requireUser` as a `preHandler` and reads
`request.safUser`:

```ts
publicServer.fastify.post("/ask", { preHandler: users.requireUser }, async (request) => {
  const user = request.safUser;
  await db.tx((tx) => worker.emit(tx, { kind: "ask", payload: { user: user.id, text: "…" } }));
  return { accepted: true };
});
```

That is the whole integration surface, and it is the same one the HTTP Messenger's own Public
routes use: `requireUser` as one option, `request.safUser` in the handler, and no
authentication of its own anywhere in that part. Four things about it are decisions rather than
omissions, and are cheaper to learn now than to discover:

- **Seeding the first User is yours, and it happens once.** A User has no natural key — no
  email, no username, nothing to match on — so "create this User if absent" cannot be
  written. Create one out of band against the Agent server and keep the id it returns, which
  is [step one of the walkthrough](#a-conversation-in-four-requests):
  `curl -XPOST localhost:7411/users -H 'content-type: application/json' -d '{"password":"…"}'`.
  Do not put it in your entry point, where it would run again on every boot.
- **The agent can create Users but can give them nothing.** `POST /users` on the Agent
  server takes a password and takes no attributes, so an agent talked into creating a User
  cannot make it a privileged one. Setting attributes, replacing a password, and issuing a
  Token are methods on `users` — reachable from your Handlers, which are trusted code, and
  from no HTTP route the agent can reach.
- **There is no way to remove a User.** Not a delete, not a deactivate. Revoke their Tokens
  and that is the whole of it.
- **Nothing prunes expired Tokens.** The table grows by a row per login, forever. If that
  matters to you, run this on a schedule of your own:
  `delete from saf_users.tokens where expires_at < now()`.

**Your own Producer.** Anything that calls `worker.emit(tx, { kind, payload })`. A webhook
route, a poller, a loop. Note the transaction: `emit` takes yours rather than finding one,
so recording something in your own tables and telling the agent about it either both
happen or neither does — and a rollback wakes nobody. The HTTP Messenger is a Producer of
exactly that kind and holds no privilege for being ours: it inserts a Message and emits
`message.received` in one transaction, and a Producer of yours beside it is a peer.

**Your own Component.** Anything with a `name`, a `start` and a `stop` goes in the list
and starts and stops with everything else — a poller, a queue consumer, a metrics
endpoint of your own. There is no base class and nothing to register:

```ts
let timer: ReturnType<typeof setInterval> | undefined;

const sweeper: Component = {
  name: "token sweeper",
  start: async () => { timer = setInterval(sweep, HOUR); },
  stop: async () => { clearInterval(timer); },
};

const gateway = components([db, agentServer, worker, sweeper, publicServer]);
```

Both methods are required, which is the rule that keeps the list to parts that actually
run: a part with nothing to start and nothing to release stays out of it rather than
carrying two empty methods. The User Directory is the worked example of that — it is not
a Component and has no position in the order.

**Your own tables.** `db.handle(yourSchema)` gives you a typed Drizzle handle through
the same call the framework's own parts use, and `db.tx(cb)` a transaction you can pass
into `worker.emit`. No privileged access and no special case. Give your part its own
PostgreSQL schema and its own migration tracking table, and register the descriptor with
`db.registerMigrations(yourMigrations)` — after which `db.migrate()` applies yours with
ours and `db.start()` refuses to serve if your schema is behind, on exactly the same terms.

**Your own mount.** One more thing for the agent to see is one more entry in
`mounts.entries`, and that is the whole of it — no framework change, no new field, and no
privileged position for the Workspace, which is an ordinary entry like the rest:

```ts
{ containerPath: "/reference", gatewayPath: "/srv/handbook", readOnly: true }
```

Both paths are absolute — a relative one on either side is refused where you wrote it — and
`containerPath` is POSIX however your own platform spells a path. Create the source
yourself before the first Run: nothing else will, and the daemon refuses what is not there.

## Choosing a model is a file you mount

There is no `model` field and no `provider` field. The framework carries neither, because
`pi` reads both out of a `settings.json` in its own directory, and that directory is one
you already mount — so a value the framework would only have handed back is a value it does
not hold ([ADR-0016](./adr/0016-agent-configuration-is-opaque-to-the-framework.md),
[ADR-0025](./adr/0025-the-pi-adapter-spawns-one-confined-process-per-run.md)).

The whole of [`../example/settings.json`](../example/settings.json):

```json
{
  "defaultModel": "claude-sonnet-4-5",
  "defaultProvider": "anthropic"
}
```

It goes at **`<the agent directory>/settings.json`** inside the container — for the
reference deployment `/home/agent/.pi/agent/settings.json`, which is
`PI_CODING_AGENT_DIR` plus a file name, and is the fourth entry of the Mount Table above.
`pi` falls back to those two whenever no `--model` flag names one, and the framework passes
no such flag (verified in `pi@0.83.0`: `SettingsManager` exposes `defaultModel` and
`defaultProvider`, and `main.js` falls back to the saved default).

So switching provider is two lines of that file plus the variable name in your entry
point's `env` — and `env` is the whole of what the agent's container gets, since this
process's own environment is deliberately not inherited. For a local OpenAI-compatible
server, drop `defaultProvider` and put a `models.json` beside `settings.json` describing
it. The framework has no field for any of that and will not carry it: writing out JSON it
never reads is pass-through with a file write attached.

The credential can move into that directory too, and this is worth knowing because it
survives restarts and keeps a secret out of the file you paste into an issue: the agent's
directory persists between Runs, so an `auth.json` you put there is picked up, and `pi`'s
own documentation says a credential there takes priority over the environment. Credentials
the agent refreshes mid-Run persist the same way — which is the point of that directory,
and the reason nothing of ours writes into it.

### Mount `settings.json` read-only, and mount the file rather than the directory

Everything in the agent's directory persists, including whatever the agent did to its own
settings. If you want a file the agent cannot durably change, the answer is a **read-only
single-file entry** in the Mount Table, the same shape `AGENTS.md` uses; the framework no
longer holds that property by rewriting anything. Two facts about doing it to
`settings.json` in particular, both checked against `pi@0.83.0` rather than assumed: it must
be the **file** that is read-only and not the directory, because `pi` takes a lock beside
that file even to read it, and a write it is refused is recorded rather than thrown, so the
Run survives being denied and the agent's own `/model` switch is dropped rather than
persisted.

### What a bad key looks like

Nothing refuses a deployment with no usable model — that is the first row of
[the four things nothing checks](#four-things-nothing-checks). The Gateway still starts,
the container still runs, and the Run is recorded as **failed** carrying the provider's own
message, which is worth seeing once because it is also what a real model error looks like:

```
"error": "Session user_3a577cbb-… settled with stopReason \"error\" and exited successfully
          anyway: 401 {\"type\":\"error\", ... \"message\":\"invalid x-api-key\"} ...
          Its stderr said: ..."
```

The person who asked is told, and by this deployment rather than by the framework: the
Handler's `post` phase sends them a Message saying it went wrong and that nothing will retry
it. That is what the `post` phase is for, and the whole of what it can say, since a Run reports
`ok` or an error string and none of the agent's output.

Two things in that string are deliberate. It names the **Session**, because the outcome
reader is built per Run and closes over it, and that name is what tells you which
transcript to open. And "exited successfully anyway": `pi`'s machine-readable mode exits
zero on model and API errors, so the outcome is read out of the event stream and never from
the exit code — which is also why no exit code appears in that message, since the framework
only appends one when it is non-zero. You do not have to do anything about that; it is here
because seeing a successful exit next to a failed Run is otherwise alarming.

## A second Agent Implementation is one function

Everything above is generic. An Agent Container knows nothing about `pi`, and neither does
the **Agent Container Runtime** built from one: the argument assembly, `--rm --interactive
--user`, the networks, the environment, the entry point, spawning, stdin, draining stderr,
the exit status and the diagnosis appended to a failure are all shared. What an **Agent
Implementation** adds is one function — given a Prompt, what to put after the image name,
what to write on stdin, and how to read what comes back:

```ts
import {
  createAgentContainerRuntime,
  type RunPlan,
  type RunPrompt,
} from "shared-agent-framework";

function clawRun(prompt: RunPrompt): RunPlan {
  return {
    args: ["--json", "--thread", prompt.session],
    stdin: prompt.text,
    outcome: async (stdout) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stdout) chunks.push(chunk);
      const said = Buffer.concat(chunks).toString("utf8");
      return said.includes(`"refused"`)
        ? { ok: false, error: `Session ${prompt.session} was refused: ${said}` }
        : { ok: true };
    },
  };
}

const runtime = createAgentContainerRuntime({
  container: { image: "openclaw:1", networks: ["saf_agent"], mounts },
  run: clawRun,
});
```

That `runtime` is a Runtime, so it goes straight into `createSignalWorker({ db, runtime,
handlers })` and nothing else in the entry point changes. `createPiRuntime` is that same
call with two defaults spread beneath the Operator's own, and it is under ten lines: the
whole of the `pi` Agent Implementation is
[`../src/pi/runtime.ts`](../src/pi/runtime.ts), which is that constructor and `piRun`, plus
[`../src/pi/output.ts`](../src/pi/output.ts), which is the reader `piRun` hands back.

Four things about the shape, each of which is a decision rather than an accident:

- **`{ container, run }`, contained rather than flattened.** The declaration an Operator
  writes and the behaviour you supply stay visibly apart, your defaults visibly apply to
  the container, and a field written in the wrong half is a type error.
- **Your defaults spread beneath the Operator's**, which is the entire extension mechanism
  — no registration, no base class, no lifecycle. `pi` contributes exactly two,
  `entrypoint: ["pi"]` and `PI_OFFLINE`, and an Operator who states either gets theirs:
  `{ entrypoint: ["pi"], ...container, env: { PI_OFFLINE: "1", ...container.env } }`.
- **`outcome` is produced per Run**, which is the only reason this is one function and not
  two: it closes over the Session, so a failure can say `Session run_x produced no output
  at all` instead of just "something produced no output". Your `run` is called once per
  Run and its result used for both the command line and the reader, so an impure one
  cannot be asked twice and disagree with itself.
- **`commandFor(prompt)` is on what comes back**, giving you the composed command line —
  and the redacted copy — without starting a container. That is what makes your argument
  tests pure, and it is the seam to test on: composing argv from the parts instead means
  restating the Runtime's own defaults, so a test could not observe the default it exists
  to check.

The Prompt arrives as a `RunPrompt`, whose `session` is a `string` and never `null`: the
Signal Worker resolved a Handler's request for a fresh Session against the Run row before
calling you, so there is no naming convention for you to invent
([ADR-0033](./adr/0033-an-agent-is-a-container-and-one-function.md)).

## Why the Gateway is not in the compose file

It runs on your host, and containerising it would cost more than it buys.

The Gateway starts a container per Run, so a containerised Gateway needs a container
runtime socket — which is root on the host, a far bigger hole than the one it closes.
Running on the host also makes the file-ownership story true by construction: the agent's
container runs as the Gateway process's uid, and the directories under `example/state/`
belong to that user already.

### If you containerise it anyway: `hostPaths`

A Mount Table entry is two values — where a directory or file appears **to the agent**,
and where it is **as this process sees it** — and the second is what the container
runtime's daemon resolves, **on the host**. Three processes are naming the same directory
and only two of the names are in that entry. They are the same string while the Gateway
runs on the host, which is the case this deployment is, so the third name never comes up.

It comes up the moment the Gateway is itself in a container, and then it is **one fact
about your deployment** rather than a property of each mount. State it once, on the table:

```ts
mounts: {
  entries: [
    { containerPath: "/workspace", gatewayPath: "/srv/state/workspace" },
    { containerPath: "/home/agent/.pi/agent", gatewayPath: "/srv/state/agent" },
  ],
  // this container's /srv/state is the host's /var/lib/saf
  hostPaths: { "/srv/state": "/var/lib/saf" },
}
```

Keys are matched **longest prefix first**, so a general mapping and a specific exception
coexist. Leave `hostPaths` out and every entry is its own source, which is what every
example on this page has been doing.

Once you write one it is **exhaustive**. An entry whose `gatewayPath` falls under no key
is refused when you construct the Runtime, with a message naming the path and listing the
prefixes you declared. It deliberately does not fall back to identity: a fallback is what
turns forgetting the third of three mappings into a deployment that starts, serves, and
has one silently empty directory in it. And because resolution is a pure function of what
you wrote, you find out with no daemon, no image and no container.

A key matched **exactly** contributes its value whole, with nothing appended, and that is
how a named volume is expressed — no runtime will mount a *subpath* of one, so a composed
source would look right and be wrong. The value is handed to the daemon unread; nothing
here knows what a volume is, and a volume stays a value rather than becoming a framework
concept. One sharp edge follows from mounts being emitted as `type=bind`, whose source a
daemon resolves as a path: under Docker the value has to be **where the volume lives on
the host**, `/var/lib/docker/volumes/saf-workspace/_data` and not `saf-workspace`, which
is refused as a non-absolute source.

**Nothing discovers this mapping for you, and that is a deferral rather than an
omission.** Two mechanisms would work — `/proc/self/mountinfo`, and `docker inspect` on
the Gateway's own container — and
[ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md) records
both, along with the constraint on whoever adds one: it must be an **exact** mechanism and
not a heuristic. A heuristic used to be affordable because a round trip at startup would
have caught a bad guess, and that round trip is exactly what has been removed.
`mountinfo` returns a confident wrong path whenever the directory sits on a separate
filesystem, a btrfs subvolume, or a Docker Desktop VM; a confident wrong path is worse
than no path at all, because the wrong one is not refused.

## No agent image is published

There is no official `pi` image; every deployment builds one.
[`../example/agent/Dockerfile`](../example/agent/Dockerfile) is the reference, and it is
six instructions under a page of comments. Three things any image you substitute has to
have, and two lines it has to declare.

The three:

1. **A POSIX shell** — the agent's own shell tool needs one.
2. **`curl`** — `pi` ships no HTTP client, so the agent reaching the Agent server is its
   shell plus `curl`.
3. **No dependence on a passwd entry** — the container runs as a uid the image has never
   heard of, so nothing may need `/etc/passwd` or `$HOME` to name it.

`pi` as the `ENTRYPOINT` used to be a fourth. It is not: `entrypoint` is a field of the
Agent Container and `pi` defaults it to `["pi"]`, so an image that starts something else
is a value rather than a workaround.

The two lines are where the container paths went:

```dockerfile
WORKDIR /workspace
ENV PI_CODING_AGENT_DIR=/home/agent/.pi/agent
```

They are in the image rather than in your entry point because **a path the framework does
not carry is a path it cannot get wrong** — it would have taken both from you and handed
both straight back, one as `--workdir` and one as an environment variable, which is
pass-through with a chance to mistype. A path in the image is one **you** can still get
wrong, silently, and that trade is the second row of
[the four things nothing checks](#four-things-nothing-checks). Neither line is a
convenience: `WORKDIR` is where `pi` runs and therefore where it looks for `AGENTS.md`, and
`PI_CODING_AGENT_DIR` has to be stated because `pi`'s own default joins `.pi/agent` onto
the home directory, and a container running as a uid with no passwd entry gets `HOME=/`, so
the default resolves to `/.pi/agent`, which the agent cannot create. It is a default that
never works rather than one that usually does. Both must agree with your Mount Table, and
nothing checks that they do.

The model, the key, the Workspace, and the agent's instructions are deliberately not in
the image. The key is passed in per Run and the other three are mounted, so changing any of
them is an edit to your entry point, or to a file beside it, rather than an image rebuild.
Nothing is *written* into the image or into a mount by the framework; the reason the
instructions and the settings are mounted rather than baked in is that a mount can be
read-only and can change without a rebuild.

## Tearing it down

```sh
docker compose -f example/compose.yaml down -v   # containers, networks, and the database volume
rm -rf example/state                             # the Workspace and the agent's directory
```

`example/state/` is gitignored. It holds credentials the agent wrote, so do not commit it.

## What is not here

So you do not go looking:

- **Anything about a Message beyond one `text` string.** No attachments, no reactions, no
  typing indicators, no read state, no unread count, no receipts, no editing, and no
  conversation as a thing with a name: one implicit conversation per person, and no table,
  column or field for it. A deployment that needs any of that writes a messaging Producer of
  its own beside this one, which is
  [the extension mechanism the framework has](#making-it-yours) rather than a gap.
- **Push delivery, deduplication and deletion** on that log. All three refused today, with
  [the reasons and what each costs](#three-things-about-messages-and-none-of-them-is-a-bug).
- **Any way to remove a User**, any account-recovery flow, and any limit on password
  guessing. All three refused, with the reasoning above and in the ADRs.
- **The Scheduler** — recurrence and future work. Designed, not built.
- **Timeouts, cancellation, and retry.** Refused, with the consequences spelled out
  above.
- **Authentication on the Agent server.** Refused, with the consequences spelled out
  above.
- **Any check on what you mounted, or on what the agent reads.** Refused, with the whole
  cost in [four things nothing checks](#four-things-nothing-checks). The container runtime
  refuses a source that is not there, and that is the whole of it.
- **Any file the framework writes.** It writes none, anywhere, ever — not the agent's
  settings, not its instructions, not a directory to put them in.
- **POSIX signal handling.** The framework installs none. `components` gives you the
  ordering; the exit code, any timeout on the drain and what a second signal does are
  yours.
- **Any Agent Implementation but `pi`.** Writing one is
  [a function and a call](#a-second-agent-implementation-is-one-function), which is the
  point of the contract being this narrow; none is written.
- **Retention.** Session transcripts accumulate in one directory that
  [every Run parses in full](#where-the-transcripts-go-and-what-it-costs), and nothing
  prunes them.

The reasoning for each is in [`../docs/adr/`](./adr/), and the map of how the parts fit
together is [`architecture.md`](./architecture.md). Neither is required reading to run
what you just ran.
