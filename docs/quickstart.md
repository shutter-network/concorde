# Quickstart

From a fresh clone to a conversation with the agent, on one machine, in one command and
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

- **Docker**, running, with the default socket available. Everything below is containers,
  including the Gateway itself, and the Gateway starts one more container per Run. On
  Docker Desktop, "Allow the default Docker socket to be used" must be on; it is by
  default.
- **A machine whose root you are relaxed about.** The Gateway is handed the host's Docker
  socket, which is root on the host. That is a real cost, taken deliberately for a demo
  stack and explained in ["The Gateway holds your Docker
  socket"](#the-gateway-holds-your-docker-socket).
- **A model API key.** The reference deployment is written for Anthropic and reads
  `ANTHROPIC_API_KEY` from your environment. Any provider `pi` supports works — what
  changes is the variable's name in the entry point and two lines of
  [`../example/settings.json`](../example/settings.json), which is a file you write and
  the framework has never read. See ["Choosing a model is a file you
  mount"](#choosing-a-model-is-a-file-you-mount) below.

You do **not** need Node, `mise`, or `npm` on your machine. The Gateway's image compiles
the framework from source during the build.

## One command

```sh
cd example
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up -d --build
```

**Run it from `example/`, not from the repository root.** Compose resolves `./state`
against the compose file's own directory, while `${PWD}` is wherever you invoked the
command, and the stack needs the two to be the same place. Running `docker compose -f
example/compose.yml up` from the root starts a Gateway that works and hands the agent a
Workspace nobody is looking at. This is the single sharpest edge in the whole file, and it
comes from a mechanism that [does not exist yet](#if-you-containerise-your-own-gateway-hostroot).

The forgotten key fails immediately and says so, before anything starts:

```
error while interpolating services.gateway.environment.ANTHROPIC_API_KEY:
required variable ANTHROPIC_API_KEY is missing a value: set it in your shell; the agent's model needs it
```

**A healthy Gateway then prints nothing at all.** `docker compose logs gateway` is empty
after a successful start, and that is correct: nothing announces that either server
started. One call binds both ports, opens the pool and starts the worker, and it says
nothing about any of it — the framework logs no startup line anywhere, and any line you
want about one is yours to write next to that call.

Nothing else happens either, and that is the other half of the silence. This deployment's
only Producer is the **HTTP Messenger**, so the first Signal this Gateway ever sees is a
Message somebody posted, and until somebody posts one there is nothing to claim and nothing
to run. A person logs in over the Public server, posts a Message, and reads the agent's
answer back, which is [the next section](#a-conversation-in-four-requests).

### What that command did

Five things: **built the Gateway image** from
[`../example/gateway/Dockerfile`](../example/gateway/Dockerfile), which compiles this
framework from source; built the agent image from
[`../example/agent/Dockerfile`](../example/agent/Dockerfile) and ran it once so you can see
that `pi` is really in it; started PostgreSQL; **applied this deployment's schema** with a
one-shot `migrate` container, which the Gateway waited for before it started; and created
two networks.

```sh
docker compose ps -a             # gateway and postgres up; agent-image and migrate Exited (0)
docker compose logs agent-image  # 0.83.0
docker compose logs migrate      # Changes applied
```

Those two `Exited (0)` containers are meant to be there. Real agent containers are started
by the Gateway, one per Run, and are never services in this file; the `migrate` container
has one job and is finished before the Gateway opens a connection.

**The framework applied none of that schema.** This deployment owns its database, so this
deployment owns its migrations: `example/schema.ts` is the barrel of the parts it runs,
`example/drizzle.config.ts` points at it, and `example/migrate/Dockerfile` runs
`drizzle-kit push` against it
([ADR-0046](./adr/0046-the-operator-owns-migrations.md)). `push` because this database is a
volume you throw away; a production deployment runs `generate` at build time and `migrate`
at deploy time against a folder it reviewed and committed, with the same compose wiring.
Nothing in the Gateway checks that any of it happened — a missing table is a PostgreSQL
error on the first query that needs it, and confirming the schema applied is yours.

**Only one port is published: 8080, on loopback.** PostgreSQL publishes nothing, and
neither does the Agent server. That is not tidiness, it is the network boundary the
[agent's isolation](#the-agents-network-which-is-a-boundary-now) actually rests on
now.

### Editing anything means rebuilding

`docker compose up -d --build` again. The `npm ci` layer is cached, so a change under
`src/` or to `example/main.ts` rebuilds in seconds rather than a minute. There is no
supported way to run `example/main.ts` on your host: it reads `BASE_DIR_GATEWAY` and
`BASE_DIR_HOST` from compose and refuses to start without them, and supporting both would
put three conditionals into the shortest honest deployment this repository has
([ADR-0039](./adr/0039-the-reference-deployment-runs-in-a-compose-stack.md)).

Two files are the exception, and they are the two the *agent* reads: `example/AGENTS.md`
and `example/settings.json` are mounted into the agent's container from your checkout, so
editing either takes effect on the very next Run with no rebuild at all. The reason is in
["Two files are not in the Gateway's image"](#two-files-are-not-in-the-gateways-image).

## A conversation, in four requests

The Gateway is up and nothing has arrived, so nothing has happened. Four requests take it
from a silent process to an answer, and each one below is followed by what it really
answered.

**One: a User**, created out of band on the **Agent** server. `POST /users` takes a password
and nothing else, and the id it answers with is the one thing you have to keep, because a
User has no natural key: no email, no username, nothing to match on later.

That server is not published to your host, so this request is made from inside the
Gateway's own container. `wget` is BusyBox's, already in the image, and there is no `curl`
in there to use instead:

```sh
docker compose exec gateway wget -qO- \
  --header='content-type: application/json' \
  --post-data='{"password":"correct horse battery staple"}' \
  http://127.0.0.1:7411/users
```

**`127.0.0.1`, not `localhost`.** The Agent server binds `0.0.0.0`, which is IPv4 only,
while `localhost` inside that container may resolve to `::1` first and be refused. It is the
one place in this document where the distinction bites.

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
something to say, one JSON line at a time, in `docker compose logs -f gateway`:

```
Signal claimed     {"signalId":"641c2f87-…","kind":"message.received"}
Run started        {"runId":"7f1a08a4-…","session":"user_3a577cbb-da46-44d1-8032-e2549fcd1507"}
Run finished       {"runId":"7f1a08a4-…","session":"user_3a577cbb-da46-44d1-8032-e2549fcd1507"}
Signal finished    {"signalId":"641c2f87-…","state":"done"}
```

The `kind` is the constant the Messenger exports, `message.received`, and it is the only one
this deployment has a Handler for. The Session name is the deployment's own choice, made by
that Handler in `main.ts`: `user_<the User's id>`, which is why everything one person says
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

**Those four requests are a walkthrough and not the specification.** The Public server
describes itself the same way the Agent server does: `localhost:8080/openapi.json` is an
OpenAPI document of every route you just used, what each takes, the exact shape of an
issued Token and of a Message, which routes want a bearer Token, and every status each can
answer; `localhost:8080/docs` is the same thing as a page, grouped rather than as one flat
list ([ADR-0040](./adr/0040-the-gateway-describes-its-own-http-api.md)). Write a client
against that. What follows below is the reasoning behind it, which a document has no room
for.

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
- **No Token is a 401**, and it is the User Manager's own single refusal rather than
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

## Generating a key

The stack in front of you already has a signing identity. `main.ts` loaded a PEM private key at
boot, Signatures derived the public half from it, and the agent can now put the Shared Agent's name
to a string. That key is **`example/insecure-example-only-signing-key.pem`**, a throwaway keypair
committed to this repository, mounted read-only, and named by `SIGNING_KEY_FILE` in
[`../example/compose.yml`](../example/compose.yml). It is public and worthless: it is in the clone
you just made, so anyone who read this repository can forge signatures under it, and it signs nothing
anybody should ever verify. **A real deployment generates its own key and never commits it.** The
decoy is here for one reason only, that a fresh clone comes up with one command and nothing to set up
by hand first.

The framework will not generate one for you, and that is deliberate rather than unfinished. A key it
minted at boot would be a new identity on every restart, and every Decision published under the last
one would become unverifiable with nothing anywhere saying so, which is the one failure a signing
identity exists to prevent. So the Operator brings the key, and generating a real one is a single
command:

```sh
openssl genpkey -algorithm ed25519 -out signing-key.pem
```

Ed25519 is what the reference deployment uses, and it is the easy case: the key type fixes the
algorithm with no choice to make, so `main.ts` passes no `signingAlg` and Signatures reads `EdDSA`
straight off the key. Point `SIGNING_KEY_FILE` at your own file, mount it where `compose.yml` mounts
the decoy, and the identity is yours rather than the example's. `main.ts` reads it with
`createPrivateKey(readFileSync(...))` and hands the framework a `KeyObject`; the framework parses no
PEM, opens no file and generates nothing, so where the key came from is the entry point's business
and nobody else's.

## A Decision, published and read

A **Decision** is a commitment the agent makes to everybody at once, on the record, signed with that
key. Unlike a Message it is addressed to nobody in particular, and every authenticated User reads the
whole log of them. Publishing is a route on the **Agent** server, `POST /decisions`, so during a Run
the agent commits by calling it and can quote the number back to a person in the same answer.

You can make one appear the same way you created a User in step one, over the Agent server from
inside the Gateway's container, and it takes only a statement. This is the identical route a Run
calls, so nothing here is a shortcut around the real path, and it needs no model:

```sh
docker compose exec gateway wget -qO- \
  --header='content-type: application/json' \
  --post-data='{"statement":"We will ship the release on Friday."}' \
  http://127.0.0.1:7411/decisions
```

A **201**, carrying the Decision as it was stored, the first in the log so its `seq` is 1:

```json
{"seq":1,"statement":"We will ship the release on Friday.",
 "jws":"eyJhbGciOiJFZERTQSIsInR5cCI6InNhZi1kZWNpc2lvbitqd3MifQ.eyJzZXEiOjEs...","createdAt":"2026-08-06T09:14:02.318Z"}
```

That `jws` field **is** the Decision. It is a compact JWS, `header.payload.signature`, one URL-safe
string, and everything else in the record (the number, the timestamp, the statement) can be read
back out of it by anybody holding the public key. The log row is where the Decision is kept, not what
makes it real: a verifier holding a valid `jws` needs no row, and no row anyone could show them would
change the answer.

Now read it back the way a **User** does, over the **Public** server, with the Token you bought in
step two. The log wants a Token because it is not a public bulletin board for whoever finds the port:

```sh
curl -s "localhost:8080/decisions/1" -H "authorization: Bearer $TOKEN"
```

The same record comes back. `GET /decisions` returns the whole log, ascending by `seq`, paged by the
same cursor the Message log uses; `GET /decisions/1` is the one numbered 1. With no Token the answer
is the User Manager's single **401**, the same refusal every Public read behind it gives.

## Verifying it without us

This is the beat the whole feature exists for, and the one place in this walkthrough where you stop
trusting the Gateway. A Decision is worth showing to somebody who does not trust the Operator only if
they can check it holding nothing but the agent's public key, asking this Gateway nothing.

First fetch the key set. It is served without a Token, because a public key is public:

```sh
curl -s localhost:8080/jwks.json
```

```json
{"keys":[{"kty":"OKP","crv":"Ed25519","x":"k6sRtxRWFpk748b-LbivLfty0nO9Tn68HnvDslVTOm0"}]}
```

One key, in RFC 7517's JWK Set container so any JOSE library consumes the URL with no glue, and **no
`d` member**: this is the public half, and the private scalar is not in it. Keep the two things you
have now, the key set and the artifact, in two shell variables, taking the `jws` out of the Decision
you just read:

```sh
KEYS=$(curl -s localhost:8080/jwks.json)
JWS=eyJhbGciOiJFZERTQSIsInR5cCI6InNhZi1kZWNpc2lvbitqd3MifQ.eyJzZXEiOjEs...   # the jws field above, in full
```

Then check the signature yourself. The Gateway's image has Node, so you need none of your own, and
this uses only `node:crypto` and no JOSE library at all: split the artifact on `.`, and verify that
the key signed the `header.payload` bytes exactly as they were emitted:

```sh
docker compose exec gateway node -e '
  const { createPublicKey, verify } = require("node:crypto");
  const jwk = JSON.parse(process.argv[1]).keys[0];
  const [header, payload, signature] = process.argv[2].split(".");
  const ok = verify(
    null,
    Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
  console.log(ok ? "verified" : "FORGED");
' "$KEYS" "$JWS"
```

```
verified
```

Now tamper with it. Change one character of the artifact and run the very same check, and the
signature no longer matches the bytes it covers:

```sh
docker compose exec gateway node -e '
  const { createPublicKey, verify } = require("node:crypto");
  const jwk = JSON.parse(process.argv[1]).keys[0];
  const [header, payload, signature] = process.argv[2].split(".");
  const flipped = payload.slice(0, -1) + (payload.slice(-1) === "A" ? "B" : "A");
  const ok = verify(
    null,
    Buffer.from(`${header}.${flipped}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
  console.log(ok ? "verified" : "FORGED");
' "$KEYS" "$JWS"
```

```
FORGED
```

One flipped character in the payload and the artifact is dead. That is what makes it worth handing to
a third party: they run this check, not you, and a Gateway that lied about what the agent committed
to would be caught by anybody who kept the key. The header is signed too, so swapping the `typ` to
pass a receipt off as a Decision fails the very same way.

**There is a shortcut, and it is a convenience rather than the point.** `POST /verify` on the Public
server takes an artifact and answers whether it is ours, so a User who trusts the Operator already
and only wants a quick confirmation can ask rather than embed a crypto library. It is mentioned
second on purpose: to the third party the identity exists for, a Gateway-supplied verdict is
worthless, because a dishonest Gateway says `true` to anything. The offline check above is the real
verification, and the route is the shortcut for when the offline check is more than the moment needs.

And be exact about what you just proved, because it is easy to over-read. A valid signature proves
**that the Operator committed to this string on the Shared Agent's behalf, and nothing about the
agent's conduct.** It does not prove the agent reasoned well, behaved, or was not talked into
publishing it: an injected agent can obtain a perfectly valid Decision. What the cryptography rules
out is denial alone, that this identity put its name to this exact string, and it rules that out
without the Gateway's help.

## Seeing what happened

The Gateway's own record lives in PostgreSQL, and the agent reads it over HTTP. So can
you, from inside the Gateway's container, since that server is published to nobody:

```sh
docker compose exec gateway wget -qO- http://127.0.0.1:7411/signals
docker compose exec gateway wget -qO- http://127.0.0.1:7411/runs
docker compose exec gateway wget -qO- "http://127.0.0.1:7411/messages?user=3a577cbb-…"
```

Or in SQL, which is often easier to read for the one column that matters most:

```sh
docker compose exec postgres psql -U saf saf -c \
  'select state, session, error from saf_signals.runs order by started_at desc limit 5'
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

Those two directories are **Compose's**, created because `compose.yml` bind-mounts them
into the Gateway and Compose creates a missing bind source. The framework creates no
directory anywhere, and `main.ts` does not either: creating what your mounts point at is the
deployment's job rather than a courtesy, and
[a mount source that is not there](#four-things-nothing-checks) is what happens when one is
missing. What ends up inside them is the agent's, written as the uid the Gateway container
runs as, which [is root](#the-agents-container-runs-as-the-gateways-uid-which-is-root).

They are mounted into the Gateway as well as declared to the agent, and both halves earn
their keep: the mount is what creates the directory and what lets a Signal Handler read what
the agent wrote, and the declaration is what the agent gets. This deployment's one Handler
reads nothing, so here it is the creating that matters.

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

### Two files are not in the Gateway's image

Those same two, and this is why editing them needs no rebuild while editing `main.ts` does.

A bind mount's source is resolved **by the daemon, on the host**. The daemon cannot see
inside the Gateway's container, so anything the agent receives as a mount has to exist on
your host, and a copy baked into the Gateway image could never be the copy anybody reads.
`example/gateway/Dockerfile` therefore does not copy them in at all, and the Mount Table
names two paths that do not exist in the Gateway's own filesystem. That is legal because
[resolving a Mount Table performs no
I/O](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md), which turns out to
be the property that makes a containerised Gateway expressible.

Baking them into the **agent's** image is the alternative and does not work: `/workspace` and
the agent directory are bind-mounted, and a bind mount shadows whatever the image had
underneath it.

## What the framework is told about the agent

One value, with one required field. An **Agent Container** is the container a Run happens
in — an image, and what the container running it sees — and it is inert: it creates no
directory, checks no path and starts nothing, resolving to container arguments and no
more. The whole of the reference deployment's is one call:

```ts
const runtime = createPiRuntime({
  image: "saf-agent:0.83.0",
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
  networks: ["saf_agent"],
  mounts: {
    entries: [
      {
        agentPath: "/workspace",
        gatewayPath: path.join(baseDirGateway, "state", "workspace"),
      },
      {
        agentPath: "/home/agent/.pi/agent",
        gatewayPath: path.join(baseDirGateway, "state", "agent"),
      },
      {
        agentPath: "/workspace/AGENTS.md",
        gatewayPath: path.join(baseDirGateway, "AGENTS.md"),
        readOnly: true,
      },
      {
        agentPath: "/home/agent/.pi/agent/settings.json",
        gatewayPath: path.join(baseDirGateway, "settings.json"),
        readOnly: true,
      },
    ],
    hostRoot: { gatewayPath: baseDirGateway, hostPath: baseDirHost },
  },
});
```

`hostRoot` is the one line this deployment needs and yours may not: it is what a Gateway
that is **itself in a container** has to say, because a `gatewayPath` is resolved by the
daemon on the *host* and not in this process's filesystem. One pair, one fact, "this
directory, over there", and every entry above falls under it. `baseDirGateway` and
`baseDirHost` are the two sides of it, both read from compose (`BASE_DIR_GATEWAY` and
`BASE_DIR_HOST`) rather than derived here, so the image's internal layout is not
load-bearing for this file. See ["If you containerise your own
Gateway"](#if-you-containerise-your-own-gateway-hostroot).

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
`agentPath`, the `gatewayPath` it comes from on this machine, and `readOnly` if the
agent must be unable to change it. An entry may name a directory or a single file, and the
declaration does not say which, because nothing in the Mount Table looks. Who the
container runs as is not in the table and is not configuration at all — always this
process's own `uid:gid`, which in this stack means [root](#the-agents-container-runs-as-the-gateways-uid-which-is-root)
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
never calls it. Telling it is yours, and **it is one URL rather than a transcription**:
what used to be a table here for you to copy is now
[a document the server generates](#the-routes-and-why-you-do-not-write-them-down).

The mechanism is `pi`'s own: it looks for `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` or
`CLAUDE.MD` in its working directory and that directory's ancestors, and its working
directory is the `WORKDIR` your image declares. So you point a mount at that path and put
a file in it, and it is found. The reference deployment commits
[`../example/AGENTS.md`](../example/AGENTS.md) and mounts it there, **read-only**, as the
third entry of its Mount Table:

```ts
{
  agentPath: "/workspace/AGENTS.md",
  gatewayPath: path.join(baseDirGateway, "AGENTS.md"),
  readOnly: true,
}
```

Read-only, and a single **file** entry rather than a directory, is the whole shape. The
Workspace around it stays writable, so `pi`'s own tooling and your Handlers are
unaffected, while a Run that is talked into rewriting the agent's instructions gets
`EROFS` instead. That property used to be held by the framework rewriting the file before
every single Run; the container runtime holds it by construction now, and holds it even
for a Run that never finishes.

### The routes, and why you do not write them down

All JSON, all on the Agent server, and **all unscoped**. Which of them exist is a
consequence of which parts were handed that server: four are the Signal Worker's, three the
User Manager's, two the HTTP Messenger's, three Decisions' and one Signatures'. The Signal
Worker is handed it by `createGateway`, and the reference deployment hands it to the other
four in `extend`, so an agent talking to that Gateway gets the whole of that.

**Which thirteen, though, is not written here and is not written in your `AGENTS.md`
either.** The server describes itself: `GET /openapi.json` answers a current OpenAPI
document generated from the routes that deployment actually registered, and `/docs` is the
same thing as a browsable page. It carries every path, what each takes, the shape of every
record it answers with, and every status it can answer. An agent can therefore tell a 404
for an unknown Signal from a 400 for a mistyped one without guessing.

The behaviour goes with it, which is the half that used to be transcribed and quietly
misunderstood. The document says on the routes it applies to that reads are not scoped by
Session or by User, that `limit` is capped and a larger value refused rather than quietly
reduced, that an unknown query parameter is a **400** rather than a filter that did nothing,
that `POST /users` has nowhere for Attributes to arrive through, and that the Message log
requires a `user` because a log belongs to one person and `seq` numbers only theirs
([ADR-0040](./adr/0040-the-gateway-describes-its-own-http-api.md)).

`pi` ships no HTTP client, so the agent fetches that with its shell tool and `curl`, which
is why `curl` is one of the [three things the agent's image
needs](#no-agent-image-is-published):

```sh
curl -s http://gateway:7411/openapi.json
```

That host name is the reference deployment's Compose service, and it is
[not derivable from where the server binds](#where-the-agent-reaches-you-is-not-derivable-from-where-the-server-binds).

So what is left for you to write is what the framework has no way to know, and there is
not much of it. The **address** above is the first thing. The second is what your Signal
Handlers make a `payload` mean: in this deployment a Signal's `payload` **is** a Message
record, so a Signal the agent reads is something somebody said with the person it came from
attached, and no generated document can say that about a convention of yours. The third is
how the agent should conduct itself: who it is acting for, and what to do when a call is
refused while somebody is still waiting.
[`../example/AGENTS.md`](../example/AGENTS.md) is those three and nothing else.

### What keeps the description honest

This section used to be a hand-made table of nine routes and four record shapes, the file
in your Workspace used to be a second copy made from it, and the warning here used to be
that nothing kept either current. The failure mode was worth knowing because it was quiet:
a stale copy produced an agent that asked for something absent, got a 400 or a 404, and
stopped asking, which reads as an unhelpful model rather than as a deployment out of date.

Being generated is the whole of the answer. The document is built at boot from the running
route table, so it describes *that* Gateway and whatever you registered on it appears
beside ours, and there is nothing left to compare against this page when you upgrade: the
agent fetches it each Run and gets what the Gateway it is talking to actually serves.

The hazard that replaces it is ours rather than yours, and it is why the round-trip
assertions in `src/gateway.test.ts` exist: a response schema is both what the
document describes a route with **and** what Fastify serialises the answer through, so a
record that gains a field its schema does not declare loses that field on the wire,
silently, in the answer and in the description alike
([ADR-0040](./adr/0040-the-gateway-describes-its-own-http-api.md)).

## What the entry point actually does

Read [`../example/main.ts`](../example/main.ts) — seventy-odd lines including the comments,
and the best documentation this project has. Most of it is the Agent Container above; the
deployment itself is three calls, one Signal Handler, and the loop at the bottom the
framework does not ship. It builds the four opinionated parts by hand in `extend` and is
otherwise a thin consumer of `createGateway`, which is why there is so little of it even
with the wiring on display.

Three things in it are the framework's to describe and **yours to do**, and all three are
near the top. It reads `BASE_DIR_GATEWAY` and `BASE_DIR_HOST` and refuses to start without
them, because a Gateway in a container cannot work out where it is on the host and a wrong
answer is silent. The two are the two sides of `hostRoot`, and compose states both. An
`AGENTS.md` sits committed beside it — not written by anything at runtime, just a file in
the repository — which the Mount Table's third entry mounts into the Workspace read-only,
and which is the only thing that tells the agent the Agent server exists. And a
`settings.json` sits beside *that*, mounted the same way, which is the only thing that tells
the agent which model to use. The framework creates no directory and writes no file, ever
([ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)).

Two more things it reads for itself, because the framework reads no environment and defaults
no policy. It reads `DATABASE_URL` and passes it as the required `databaseUrl`, since
`createGateway` has no environment fallback and where the Db connects is stated at the call
site. And it sets `tokenTtl` to thirty days when it builds the User Manager in `extend`, since
nothing defaults it, which is a trade the framework will not make for a deployment
([ADR-0045](./adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md),
[ADR-0030](./adr/0030-passwords-are-traded-for-bearer-tokens.md)).

The construct call is the whole of the wiring, and `extend` is where the four opinionated
parts are built by hand from the infrastructure `createGateway` handed back, each a one-line
`create*` call and only the ones this deployment wants:

```ts
const gateway = createGateway({
  databaseUrl,
  runtime,
  publicListen: { port: publicPort, host: publicHost },
  agentListen: { port: agentPort, host: agentHost },
  extend: ({ db, agentServer, publicServer, worker }) => {
    // The User Manager before the HTTP Messenger, which takes it as an argument.
    const users = createUsers({ db, tokenTtl, agentServer, publicServer });
    const signatures = createSignatures({ signingKey, agentServer, publicServer, users });
    const decisions = createDecisions({ db, signatures, users, agentServer, publicServer });
    const messenger = createHttpMessenger({ db, users, worker, publicServer, agentServer });
    return { users, signatures, decisions, messenger };
  },
  handlers: () => ({ [messageReceivedKind]: /* your Signal Handler */ }),
});
```

Those calls are **construct** and **start**, in that order and no other, with **your**
migration step somewhere before the second one.

1. **Construct.** `createGateway({ … })` builds the Db, two `Fastify()`
   instances and the Signal Worker, and calls your `extend`, where the reference deployment
   builds the User Manager, Signatures, Decisions and the HTTP Messenger by hand and returns
   them. It hands each part what it needs and keys them in an order. Construction is also the whole of the
   wiring: a part handed a server registers its routes on that server, so there is no second
   item on a checklist for you to forget
   ([ADR-0032](./adr/0032-components-wire-themselves-at-construction.md)). Its *tables* are
   the one thing construction does not wire, and never touches
   ([ADR-0046](./adr/0046-the-operator-owns-migrations.md)) — that is step 2. What comes back
   is a **Gateway** — that record, reachable by key at `gateway.components.db` and the rest,
   with one `start` and one `stop` over the whole of it. Nothing here touches the network.
   The **Runtime** a few lines above is the one construction that can refuse you, and only
   [three things about it can](#four-things-nothing-checks).
2. **Migrate — not here.** The entry point makes no migration call at all. The framework
   ships schema definitions and applies nothing, so the tables exist because *you* applied
   them, from a barrel of the parts you run
   ([ADR-0046](./adr/0046-the-operator-owns-migrations.md)). The reference deployment does it
   in the one-shot `migrate` container the Gateway waits on, which is [a deploy step of its
   own](#migrations-as-a-separate-step) and with more than one replica has to be.
3. **Start.** `await gateway.start()`. One call opens the pool, starts the worker
   and binds the two ports. It checks nothing about the database's schema, which is the
   other half of step 2 belonging to you: a table you never created is a PostgreSQL error
   on the first query that needs it. A part that throws stops everything that had already started,
   in reverse, and rethrows that part's own error unwrapped, so a Gateway that could not
   boot holds no pool open. Both bind addresses are options on the call in step 1, with no
   framework default behind either — see
   ["Where each server binds is yours to state"](#where-each-server-binds-is-yours-to-state).

**There is no fourth step, and what went is the order.** It used to be a list the entry point
wrote out under eighteen lines of comment arguing for each position — reasoning that was
correct, unavoidable, and identical in every deployment built out of these parts, so it now
sits beside the constructor instead of in your file.
[ADR-0045](./adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md) has it: the
order, the single rule it all comes from, and what that rule costs. You need none of it to run
this, and all of it before you write a Component of your own.

One word, since it is the only thing the framework asks a part to be. A **Component** is a
`start` and a `stop` and nothing else: no name, no routes field, no declared dependency and
nothing resolved. All eight above are Components, the four whose methods do nothing
included — the User Manager, Signatures, Decisions and the HTTP Messenger — because
membership in the record is what gives a part a key and a position, rather than owning a timer
([ADR-0037](./adr/0037-the-gateway-is-a-record-of-components.md)).

Then the one thing the framework does not do for you, at the bottom of the file:
**shutdown**.

### The HTTP Messenger, and the one thing it asks of you

Messaging is one call and five options, and every one of them is required:

```ts
const messenger = createHttpMessenger({ db, users, worker, publicServer, agentServer });
```

You write that line yourself, in `extend`, and the Gateway hands the result back at
`gateway.components.messenger`. Two things about it are still not yours to get wrong. **Its
position is decided by where `extend`'s parts are keyed**: it is a Component whose `start` and
`stop` do nothing, keyed after the servers and ahead of the worker so that it outlives the
drain, which is when a Handler's `post` phase reaches it (ADR-0037, ADR-0045). And **the
order it must be constructed in cannot be written wrongly**, because the User Manager is an
argument to this call, so you build `users` before you can name it here. What *is* still
expressible wrongly is [your migration barrel](#migrations-as-a-separate-step): this part's
`messages.user_id` is a foreign key onto `saf_users.users.id`, so a barrel carrying the
Messenger without the User Manager generates a constraint onto a table it never creates.

That call registers its two route groups at
`/messages`, the Public pair behind the Manager's `requireUser` and the Agent pair behind
no credential at all, which is the whole of the wiring. Nothing here is a capability to leave
out, unlike the User Manager's servers: a Messenger with no Public server cannot be reached
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
somebody is waiting. A deployment whose Handlers neither send nor read simply never reaches
for `gateway.components.messenger`; the part is there and costs nothing.

## Things that will bite you

These are not edge cases. Every one of them is something you meet on day one.

### Where each server binds is yours to state

The framework has no opinion about either bind address, and supplies no default for
either. Both are **required options** of the one call, written next to each other, and each
is Fastify's own `listen` options object handed over unread:

```ts
const gateway = createGateway({
  publicListen: { port: publicPort, host: publicHost },
  agentListen: { port: agentPort, host: agentHost },
  // …
});
```

They are the only thing that call states about either server, and the reference deployment
fills each side from `compose.yml` rather than a literal: `PUBLIC_HOST`/`PUBLIC_PORT` and
`AGENT_HOST`/`AGENT_PORT`, read in `main.ts` and set beside the `ports:` they must agree
with, because the framework defaults neither address. `Fastify()` is called with no
options at all and there is no bring-your-own-instance escape, which is a real limit rather
than an oversight: a Public server behind a reverse proxy wants `trustProxy`, and getting it
means leaving this constructor for `createBareGateway` and `serverComponent`
([ADR-0045](./adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)). Nothing *after*
construction is out of reach — the instances are at `gateway.components.publicServer.fastify`
and `.agentServer.fastify`, so routes, plugins and hooks go on the same servers ours do.

The address is held until `start` rather than passed to `Fastify()` because that is Fastify's
own split: `Fastify()` takes no port, and `listen` is the call a `start` has to make.

The asymmetry is the reason there are two servers. The Public server is the one meant to
be reached, and a Public server on loopback inside a container answers nobody — a
deployment that looks healthy and serves no User. The Agent server is the opposite: it
has no authentication, so **reaching the port is access**. Moving it should be something
you did on purpose, which is why it is written out rather than inherited.

**Both are `0.0.0.0` here, and that is not the same as exposing them.** This Gateway is in a
container, so a bind reaches the networks that container joined and nothing else. What
decides exposure is `ports:` in `compose.yml`, which publishes 8080 to loopback and publishes
7411 to nobody at all. The unauthenticated server is therefore reachable from the agent's
network and from no host anywhere, which is a tighter position than a loopback bind on your
machine ever managed — there,
[`host.docker.internal` reaches your loopback interface](#the-agents-network-which-is-a-boundary-now).

Two details worth knowing. **`0.0.0.0` is IPv4 only**, so `localhost` inside the Gateway's
container may resolve to `::1` and be refused; use `127.0.0.1` when you `exec` into it. And
if you go back to a loopback bind, `localhost` and `127.0.0.1` are not the same instruction
to Fastify: `localhost` binds both loopback addresses and `127.0.0.1` binds only the IPv4
one, so `localhost` is the one to write. `localhost` is also Fastify's own default, so an
options object that says nothing about `host` is already on loopback.

### Where the agent reaches you is not derivable from where the server binds

Where the Agent server's socket **binds** and how the agent's container **reaches** it
are two separate values, and nothing can compute either from the other. The framework
holds neither. The first is the `host` and `port` in `agentListen`; the
second is a **string in your own `AGENTS.md`**, and there is nowhere else for it to be —
the Agent Container has no field for it, nothing has ever read it, and the Runtime never
sees that address at all.

The reference deployment uses **`http://gateway:7411`**, which is facts that have to agree
across two files: `gateway` is the service name in `compose.yml`, `7411` is `AGENT_PORT` in
`compose.yml` too (which `main.ts` reads and the Agent server binds), and `AGENTS.md` is the
only place a URL puts the two together.

It works because Compose gives each service its own name as a **network alias** on
`saf_agent`, and the daemon's DNS answers for that alias to anything on that network —
including the agent containers, which Compose knows nothing about, since the Gateway starts
them itself. Nothing in the framework guarantees that; it was verified against a real Run,
and if it ever stops being true the fallback is the container's own name.

**If your Gateway is not in the stack**, the address is a different problem.
`http://host.docker.internal:7411` reaches a Gateway on your host, and that works on Docker
Desktop, which routes that name to the host including its loopback interface. On a plain
Linux daemon it needs both `--add-host=host.docker.internal:host-gateway` in the Agent
Container's `extraArgs` and an Agent server bound somewhere the bridge can reach, which
means it is no longer on loopback and
["the Agent server is unauthenticated"](#the-agent-server-is-unauthenticated) starts applying
to you. That is much of why the reference deployment stopped doing it that way.

If you get this wrong the symptom is at least legible: the agent's `curl` fails and the
agent says so.

### The agent's container runs as the Gateway's uid, which is root

With bind mounts, files the agent writes are owned by whoever the container runs as. So the
container always runs as the Gateway process's own `uid:gid` — otherwise your Signal
Handlers cannot read what the agent left in the Workspace, and the agent cannot read what
they left for it. There is no field for it: it used to be the Mount Table's and is no longer
configuration at all
([ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)). To
countermand it, put `--user` in `extraArgs`, which is spliced last and so wins.

**In this stack that uid is root**, because reaching `/var/run/docker.sock` inside a
container means being uid 0 or being in the host's `docker` group, whose gid differs from
machine to machine. So every agent container runs as root, and everything under
`example/state/` is owned by root.

On Docker Desktop you will not notice: the file sharing layer remaps ownership and those
directories show up as yours. On Linux they are genuinely root-owned, and `rm -rf
example/state` wants `sudo`. That is a papercut in a gitignored throwaway directory, traded
against a second machine-specific variable that would work on the author's machine and fail
on yours ([ADR-0039](./adr/0039-the-reference-deployment-runs-in-a-compose-stack.md)).

The general consequence outlives the demo: **the mounted directories must be writable by
that uid.** Where those directories come from somewhere else — a volume, a provisioned path,
another container — making them writable is your job, and nothing checks it for you. The
framework verifies no mount and starts no container at boot, so an unwritable directory is
something the agent meets during a Run, with the consequence in the next section.

### Four things nothing checks

This is the whole bill for the framework carrying no model, no provider and no path inside
the agent, and it is collected in one place because the person reading it is the person
who pays it.

**Three things are refused where you wrote them**, at construction, as a pure function of
the value: a missing `image`, a relative path on **either** side of a mount entry, and a
`gatewayPath` the `hostRoot` does not cover. That is the complete list. Everything below is
a file the framework does not read, at a path it was told about rather than chose, for a
program it does not depend on — so it cannot refuse any of it
([ADR-0033](./adr/0033-an-agent-is-a-container-and-one-function.md)).

| What you got wrong | What it looks like |
| --- | --- |
| **No usable model.** `settings.json` missing, not mounted where `pi` looks, or naming a model your key cannot reach | a **permanently failed first Run**, carrying the provider's own message |
| **An agent directory `pi` will not look in.** Your mount's `agentPath` and the image's `PI_CODING_AGENT_DIR` disagree | a **permanently failed first Run**: the mounted `settings.json` is inside that directory too, so `pi` reads no model — and if nothing declares the variable at all, `HOME=/` makes the default `/.pi/agent`, which the agent cannot create |
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
mount's `agentPath` is exactly the image's `PI_CODING_AGENT_DIR`, then look for the
`.jsonl` transcripts under it on disk.

### The line you need to diagnose a mount or a network is off by default

The Runtime logs the whole composed container invocation — every flag, every
`--mount`, the image, the network, and `pi`'s own arguments — so that diagnosing a mount
or a network problem never means reading framework source. Since nothing is verified any
more, this line is the whole of what the framework offers for that, which makes it worth
turning on before you need it rather than after. It logs at **`debug`**, and the logger
every part falls back to when you supply none runs at `info`. So by default you do not see
it.

Supply your own logger to get it. The Runtime takes one, and so does `createGateway`, which
forwards it to the Signal Worker. The seam is structural — four methods,
`debug`/`info`/`warn`/`error`, each taking fields then a message — so anything your system
already logs through satisfies it without wrapping:

```ts
const logger = pino({ level: "debug" });          // or your own object with those four
const runtime = createPiRuntime({ image: "saf-agent:0.83.0", mounts, logger });
const gateway = createGateway({ runtime, logger, /* … */ });
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

### The agent's network, which is a boundary now

`compose.yml` puts the agent on `saf_agent` and PostgreSQL on `saf_db`, and the Agent
Container's `networks: ["saf_agent"]` is what puts the agent there. So the agent **cannot
resolve `postgres`**, which is the point: the Db holds the Gateway's own state and the agent
is supposed to reach it only through the Agent server's read-only routes.

This section used to carry a confession, and the confession is worth reading even though it
no longer applies, because it is the failure mode to look for in your own topology. A
separate bridge network stops **service-name discovery**, not **host access**. When the
Gateway ran on the host, PostgreSQL had to publish a port for it to connect to, and on Docker
Desktop `host.docker.internal` reaches the host's loopback interface — so the agent could
reach anything bound there, the published PostgreSQL included, whatever network it was on.
What stood between the agent and the Db was the password.

**PostgreSQL now publishes nothing.** The Gateway reaches it by service name over `saf_db`,
there is no host port, and the network separation is load-bearing rather than decorative.

Three things still worth knowing. The credentials in `compose.yml` are `saf:saf` because this
is a local demo; a real deployment supplies its own through `DATABASE_URL`. The agent can
reach the **Public** server, because one bind covers both of the Gateway's networks, and that
is fine because the Public server wants a Token the agent does not have. And `postgres` can
reach the Agent server for the same reason, which is harmless and is not nothing; preventing
it would need per-network binds, which Fastify does not express.

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
answer today is the poll interval, because SSE or long-polling means the HTTP Messenger
growing a `LISTEN` registration and a `stop` that closes open responses
([ADR-0035](./adr/0035-a-users-messages-are-one-log-read-by-cursor.md)). It is already a
Component and already positioned to outlive the drain, so that day is two methods filling in
rather than a place in an order to argue about (ADR-0037). Nothing about the data model has
to change either, which is why it is deferred rather than designed around.

### Shutdown is two lines, and the policy is yours

The framework ships **no signal handling at all**: no `SIGINT` handler, no `SIGTERM`
handler, no timeout on the drain and no exit code. What it does ship is the ordering —
`gateway.stop()` stops the record in the exact reverse of the order it started. So the whole
of shutdown in the entry point is this:

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

What that reverse order is, and the one rule the whole of it comes from, is
[ADR-0045](./adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)'s and not this file's. The
short of it: the **Signal Worker's `stop` is the only stop that does work** — every other
one releases something — so the drain goes first, while both servers are still listening,
the HTTP Messenger is still live and the pool is still open. Everything the Run in flight needs
outlives it because nothing has closed yet. The cost is stated there too: the Public server
keeps accepting submissions throughout the drain, and a Message posted during one is stored,
stays `pending`, and is picked up on the next boot.

And the part no ordering fixes: **a Run in flight when the signal arrives.** The worker's
`stop` waits for it, which can be minutes, and `gateway.stop()` does not return until it
has. Killing the process instead leaves that Signal marked `processing`; the next start
marks it `failed` and never re-runs it, because it may already have written the Workspace
or made external calls, and replaying it would do all of that twice. Whether that is acceptable, and what to do about it, is a decision every
deployment makes for itself.

**Which is why `compose.yml` says `stop_grace_period: 300s`.** Compose's default is ten
seconds, and then SIGKILL. If your deployment is a container, that number is now part of
your shutdown policy whether you wrote it or not, and the default one truncates the drain.
The symptom is worth memorising because its cause is nowhere near it: a `runs` row stuck in
`running` **forever**, its Signal never settling, and an agent container that outlived the
Gateway, finished its work and reported the outcome to a process that was no longer there.
Nothing logs any of that. If you ever see a permanently `running` Run, look at your
orchestrator's grace period before you look at anything in this framework.

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
Manager too — every User, unscoped by Session or by User.

That is deliberate: a credential is no boundary against the agent, which is the only
party meant to reach it at all. What follows is that keeping the port unreachable is
your whole defence, and that defence is the `host` in your `agentListen` and nothing
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

**It is already a separate step here, and that is not a convenience.** `main.ts` makes no
migration call, because the framework applies nothing: `example/schema.ts` barrels the parts
this deployment runs, `example/drizzle.config.ts` points at that barrel, and
`example/migrate/Dockerfile` pushes it in a one-shot container the Gateway waits on with
`condition: service_completed_successfully`
([ADR-0046](./adr/0046-the-operator-owns-migrations.md)). Migrating at boot instead is
something **one process on one machine can get away with. More than one cannot** — Drizzle's
migrator takes no advisory lock, so two replicas booting together apply the same DDL and all
but one die of a duplicate relation, which is a rolling deploy. Nothing in the package would
let you do it at boot anyway: there is no `migrate` method, no migration descriptor and no
shipped `.sql`.

Your whole side of it is two files. The barrel:

```ts
// schema.ts
export * from "shared-agent-framework/decisions/schema";
export * from "shared-agent-framework/http-messenger/schema";
export * from "shared-agent-framework/scheduler/schema";
export * from "shared-agent-framework/signals/schema";
export * from "shared-agent-framework/users/schema";
```

and a `drizzle.config.ts` pointing `schema` at it. Every part with tables of its own has a
`/schema` subpath like those, exporting its tables as top-level names because that is the
only shape `drizzle-kit` reads: it takes `Object.values` of the module and keeps whatever
passes `is(x, PgTable)`, never looking inside a plain object, so a barrel that gathered the
tables into one exported record would push nothing at all and say so nowhere. Signatures has
no such subpath, because it stores nothing: it is the only part of the framework with no
schema at all.

**Set `schemaFilter` in that config, and derive it rather than typing it.** `drizzle-kit`
defaults it to `["public"]` and applies it to *both* sides of the diff, so with every table
of ours behind a `saf_*` schema the two sides come out empty and match: it prints
`No changes detected`, creates not one table, and exits 0 — after which the Gateway starts
on the strength of that success and dies on its first query.
[`../example/drizzle.config.ts`](../example/drizzle.config.ts) takes the list off the barrel
itself, so it cannot fall behind it.

Then `drizzle-kit push` for a prototype, or `generate` at build time and `migrate` at deploy
time for production: one word's difference, with the same compose wiring either way. And
either way it is a job that **constructs nothing** — no Gateway, no Runtime, and, the point
of the shape, **no model credential and no agent image**, because a migration job that needs
an `ANTHROPIC_API_KEY` is a broken migration job
([ADR-0032](./adr/0032-components-wire-themselves-at-construction.md)).

**What goes in the barrel is the one thing here that nothing checks**, and the two ways to
get it wrong fail very differently. Leave the User Manager out while the HTTP Messenger is
in, and generation dies loudly with `schema "saf_users" does not exist`, before it has
touched anything: `messages.user_id` is a foreign key onto `saf_users.users.id` and there is
no table for it to point at
([ADR-0036](./adr/0036-the-http-messengers-user-id-is-a-foreign-key.md)). Leave out a part
you nonetheless construct in `main.ts`, and **nothing** says anything — its tables are
simply absent, and you learn that on the first query needing one. Your `extend` and your
barrel are two lists of the same parts, and keeping them in agreement is yours (ADR-0046,
cost 2).

**Leaving the step out altogether is nobody's error but yours**, either way. `db.start()`
checks nothing about the database, so a missing table is a `relation does not exist` from
the first request that happens to touch it, and not a startup refusal — that verification
went with the ownership (ADR-0046).

## Making it yours

Seven things you will want, in the order you will want them.

**Your own Signal Handler.** A Handler is a plain object with a `handle` that takes a
Signal and returns Prompts. There is no base class, no context object, and no registration
call — it receives only the Signal, and everything else it needs it closes over from where
it was built, which is a callback holding every part the Gateway just constructed:

```ts
function summarising(workspace: string): SignalHandler<{ file: string }> {
  return {
    handle: (signal) => [{ session: null, text: `Summarise ${workspace}/${signal.payload.file}.` }],
    post: (signal, { failed }) => log.info({ signal: signal.id, failed }, "done with it"),
  };
}
```

`handlers: () => ({ "file.arrived": summarising("/workspace") })` puts it to work. The map
is **required**, and it is a callback rather than a value because a Handler usually wants
parts this call is in the middle of building — `handlers: ({ db, messenger }) => …` is what
the reference deployment writes. It reaches the Signal Worker as a construction option and
never as an argument to `start`, so a Worker with no Handlers is not something you can
construct, let alone run
([ADR-0045](./adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)).

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

**Your own routes.** `gateway.components.publicServer.fastify.register(plugin, { prefix })`,
on either server. `.fastify` is exactly what `Fastify()` returned, so its plugin system is
the extension mechanism and there is no contract of ours to satisfy. Register between the
constructor and `gateway.start()`: Fastify refuses a route registration once a server is
listening, and `start` is what listens.

**Use `register`, and your routes are described too.** Both servers publish an OpenAPI
description of themselves at `/openapi.json` and a browsable page at `/docs`, generated from
the running route table, so whatever you register appears in it alongside ours. The one
spelling that does *not* appear is a route written straight onto the instance in the same
stretch the constructor returned into: `publicServer.fastify.get("/ask", …)` is served and is
missing from the document, because Fastify fires the discovery hook as a route is declared
and the plugin adding that hook has not run yet. The route works either way; only the
description differs, and wrapping it in a `register` call is the whole fix.

**Users and authentication.** The reference deployment does this itself, in `extend`: it
constructs the **User Manager** and hands it both servers, which is the whole of the wiring,
and returns it so it comes back at
`gateway.components.users`. There is no separate registration call and no descriptor to
remember, because handing a part a server *is* how its routes get registered. The call the
reference deployment writes is this one:

```ts
const users = createUsers({
  db,
  tokenTtl: 30 * 24 * 60 * 60 * 1000,   // the Operator's now: nothing defaults it
  agentServer,      // `POST /users` and the two reads, at `/users`
  publicServer,     // logging in, logging out, reading and replacing your own credential, at `/auth`
});
```

**Omitting a server is how you switch that group off.** Leave
`agentServer` out and the agent cannot create a User; there is no flag and no route to
guard. Leave both out and you still have `users` in hand for your own routes.

The prefixes are defaults rather than policy, and the way out of them is the exported
plugins, which are ordinary Fastify plugins with no prefix of their own:

```ts
await gateway.components.publicServer.fastify.register(users.publicRoutes, { prefix: "/login" });
```

That is the escape hatch for a prefix of your own, for registering inside your own
encapsulated plugin, or for putting a hook in front of the group. Do one or the other for
a given group, not both, or the routes exist twice.

A User logs in with `POST /auth/tokens` and gets a bearer Token back; every route of yours
that should require one takes `users.requireUser` as a `preHandler` and reads
`request.safUser`:

```ts
const { db, users, worker, publicServer } = gateway.components;

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

**Your own Component.** Anything with a `start` and a `stop` starts and stops with
everything else — a poller, a queue consumer, a metrics endpoint of your own. There is no
base class, no `name`, and nothing to register: `extend` returns them under keys of your
own, and they join the Gateway's record beside the infrastructure the call built and the
parts you built in `extend`.

```ts
let timer: ReturnType<typeof setInterval> | undefined;

const gateway = createGateway({
  // …
  extend: ({ db }) => ({
    sweeper: {
      start: async () => { timer = setInterval(() => void sweep(db), HOUR); },
      stop: async () => { clearInterval(timer); },
    },
  }),
});
```

Both methods are required, and the reason is structural typing rather than ceremony. With no
`name` on the interface, a Component whose methods were both optional would be the *empty*
type — satisfied by an options bag, a Mount Table, a string — and a wrong entry in
an order-bearing record is silent by construction. So a part with nothing to run says so
with two methods that do nothing, which is exactly what the User Manager and the HTTP
Messenger do ([ADR-0037](./adr/0037-the-gateway-is-a-record-of-components.md)).

**The one thing about `extend` worth knowing: your Components stop *after* the drain.** What
it returns is keyed ahead of the Signal Worker, so those keys start before it and therefore
stop after it, once the Worker has finished waiting for the Run in flight. That is right for
**anything the drain uses**: an outbound client your Handlers call in their `post`
phase, a cache they read, a connection to something of your own. It is **wrong for a
Producer**, which should stop producing before the drain rather than after it. That position
is the one `extend` cannot express, and the answer is not a flag: it is `createBareGateway`
with the whole record written out by hand and yours where it belongs
([ADR-0045](./adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)).

One thing about the keys. The four infrastructure keys (`db`, `agentServer`,
`publicServer`, `worker`) are **type errors** in what `extend`
returns, because a spread would overwrite one in place, keep its position, and say nothing
(ADR-0037).

**Your own tables.** `db.handle(yourSchema)` gives you a typed Drizzle handle through
the same call the framework's own parts use, and `db.tx(cb)` a transaction you can pass
into `worker.emit`. No privileged access and no special case. Give your part its own
PostgreSQL schema, `export *` its tables from your barrel beside the framework's, and it is
applied by the same push in the same graph as ours, on exactly the same terms. No privileged
position there either: your tables and ours are one generation, so a foreign key from yours
onto ours is a foreign key you can simply declare.

**Your own mount.** One more thing for the agent to see is one more entry in
`mounts.entries`, and that is the whole of it — no framework change, no new field, and no
privileged position for the Workspace, which is an ordinary entry like the rest:

```ts
{ agentPath: "/reference", gatewayPath: "/srv/handbook", readOnly: true }
```

Both paths are absolute — a relative one on either side is refused where you wrote it — and
`agentPath` is POSIX however your own platform spells a path. Create the source
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
import { createAgentContainerRuntime, type RunPlan } from "shared-agent-framework";
import type { RunPrompt } from "shared-agent-framework/signals";

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

That `runtime` is a Runtime, so it goes straight into `createGateway({ runtime,
… })` (or into `createSignalWorker({ db, runtime, handlers })` if you assemble by hand),
and nothing else in the entry point changes. `createPiRuntime` is that same
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

## The Gateway holds your Docker socket

`compose.yml` mounts `/var/run/docker.sock` into the Gateway, and that is root on your
host. Anything that can execute code in the Gateway process can execute code as root
outside it. Do not run this stack on a machine you would mind losing.

This file used to argue the other way, and the argument was: a containerised Gateway needs
a container runtime socket, which is a far bigger hole than the one it closes, so run it on
the host instead. The hazard was right and the conclusion was wrong. **The Gateway holds
container-creation authority wherever it runs** — on your host it reaches the same socket,
the same way, with the same blast radius — so containerising does not create the hole, and
running on the host does not close it. The only real question is *whose* authority it holds.

Two answers change that, and one of them is worth your time:

- **A socket proxy** allowlisting what `docker run` needs. It has to allow the endpoint that
  starts a container with arbitrary bind mounts, which is on its own enough to mount `/`
  somewhere writable. It adds a service and closes approximately nothing.
- **Rootless Docker, or Podman.** This genuinely shrinks the hole rather than moving it, and
  the framework already supports it:  `containerCommand: ["podman"]` on the Agent Container.
  It is not what the reference deployment does, only because the quickstart's whole promise
  is that a clean clone runs on a stock Docker Desktop install.

If you take this design to production, rootless is the first thing to change.
[ADR-0039](./adr/0039-the-reference-deployment-runs-in-a-compose-stack.md) has the rest.

### If you containerise your own Gateway: `hostRoot`

A Mount Table entry is two values — where a directory or file appears **to the agent**,
and where it is **as this process sees it** — and the second is what the container
runtime's daemon resolves, **on the host**. Three processes are naming the same directory
and only two of the names are in that entry. They are the same string while the Gateway
runs on the host, and they part company the moment it does not.

That is **one fact about your deployment** rather than a property of each mount, so it is
stated once, on the table, as a single pair: where the shared tree sits inside this
container, and where the daemon finds that same tree on the host. Here is the reference
deployment's, which is as small as one gets:

```ts
mounts: {
  entries: [
    /* … */
  ],
  // this container's /app/example is the host's ${PWD}; compose.yml passes both in
  hostRoot: { gatewayPath: baseDirGateway, hostPath: baseDirHost },
}
```

Both sides come from compose (`BASE_DIR_GATEWAY` and `BASE_DIR_HOST`) rather than being
derived here, and every entry sits under `baseDirGateway` because the state directories
were deliberately put *inside* `example/` instead of beside it. One pair is the whole
mapping. A more typical one, with the state somewhere of its own:

```ts
mounts: {
  entries: [
    { agentPath: "/workspace", gatewayPath: "/srv/state/workspace" },
    { agentPath: "/home/agent/.pi/agent", gatewayPath: "/srv/state/agent" },
  ],
  // this container's /srv/state is the host's /var/lib/saf
  hostRoot: { gatewayPath: "/srv/state", hostPath: "/var/lib/saf" },
}
```

A `gatewayPath` **does not have to exist in your container**, and the reference deployment
relies on it: `AGENTS.md` and `settings.json` are named at paths that are not in the
Gateway's image at all, because the daemon resolves them on the host where they really are.
Resolving a Mount Table performs no I/O, so nothing ever looks.

The root is applied by prefix: a `gatewayPath` equal to it resolves to `hostPath` whole, one
below it resolves to `hostPath` with the remainder appended, and a trailing slash on the
root changes nothing. Leave `hostRoot` out and every entry is its own source, which is what
a Gateway running on a host wants.

Once you write one it is **exhaustive**. An entry whose `gatewayPath` falls **outside** the
root is refused when you construct the Runtime, with a message naming the path and the root
you declared. It deliberately does not fall back to identity: a fallback is what turns
forgetting to widen the root into a deployment that starts, serves, and has one silently
empty directory in it. And because resolution is a pure function of what you wrote, you find
out with no daemon, no image and no container.

**One pair means one host mount.** A Gateway whose shared tree spans more than one host
mount cannot say so through `hostRoot`, and its escape is to declare none and write
daemon-namespace paths straight into each `gatewayPath`, which works because translation is
the only thing the framework ever does with a `gatewayPath`, at the price of entries this
process cannot itself `ls`.

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

## What the Gateway's own image needs

[`../example/gateway/Dockerfile`](../example/gateway/Dockerfile) is two stages: one that
runs `npm ci && npm run build`, and one that runs the result. Four things in it are
requirements rather than choices, and three of them are easy to leave out and hard to
diagnose:

1. **The Docker CLI.** The framework runs `docker` as a **process**, not through an API
   client, so the binary has to be in the image and on `PATH`. `containerCommand` on the
   Agent Container is what names something else, `["podman"]` included.
2. **`node_modules` including dev dependencies.** `drizzle-orm` and `fastify` are peer
   dependencies of this package and pinned devDependencies of this repository, which is how
   it builds and tests against them. `npm ci --omit=dev` produces an image whose Gateway
   dies on its first import. Copying the whole tree keeps every version stated once.
3. **`package.json`.** `main.ts` imports the framework **by name**, which Node resolves by
   self-reference through the `exports` map, so the manifest is what makes
   `shared-agent-framework` resolvable from inside the package with no `node_modules` entry
   of its own.
4. **The entry point as PID 1.** `CMD ["node", "example/main.ts"]` puts Node at PID 1, so
   the SIGTERM from `docker compose down` reaches the handler at the bottom of the file
   directly, with no shell in between to swallow it.

What is deliberately **not** copied in is `AGENTS.md` and `settings.json`, for the reason in
["Two files are not in the Gateway's image"](#two-files-are-not-in-the-gateways-image).
Nor is any SQL, since this image applies none:
[`../example/migrate/Dockerfile`](../example/migrate/Dockerfile) is the one that carries
`drizzle-kit`, the barrel and the config, and it is a separate image so that a tool for
changing the database is not sitting in the service that serves from it.

The build context is the **repository root** rather than `example/`, since the image
compiles the framework rather than installing it, and `.dockerignore` at the root is what
keeps that context from carrying `node_modules`, `dist` and the state directory into the
daemon. When there is a published base image to build on, the second stage's `FROM` is the
one line that changes.

## No agent image is published

There is no official `pi` image; every deployment builds one.
[`../example/agent/Dockerfile`](../example/agent/Dockerfile) is the reference, and it is six
instructions. Three things any image you substitute has to have, and two lines it has to
declare.

The three:

1. **A POSIX shell** — the agent's own shell tool needs one.
2. **`curl`** — `pi` ships no HTTP client, so the agent reaching the Agent server is its
   shell plus `curl`.
3. **No dependence on a passwd entry** — the container runs as a uid the image has never
   heard of, so nothing may need `/etc/passwd` or `$HOME` to name it.

`pi` as the `ENTRYPOINT` used to be a fourth. It is not: `entrypoint` is a field of the
Agent Container and `pi` defaults it to `["pi"]`, so an image that starts something else
is a value rather than a workaround.

The version is pinned exactly, and worth keeping pinned: every fact the Runtime relies on
about `pi` — the flag names, the JSONL record types, the terminal record, and what the exit
code does and does not mean — was read out of that exact version.

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
docker compose down -v   # from example/: containers, networks, and the database volume
rm -rf state             # the Workspace and the agent's directory
```

`example/state/` is gitignored. It holds credentials the agent wrote, so do not commit it.
On Linux its contents are owned by root, because
[that is what the agent's container runs as](#the-agents-container-runs-as-the-gateways-uid-which-is-root),
so that second command wants `sudo`.

Agent containers are `--rm` and are started by the Gateway rather than by Compose, so
`down` does not touch them; one that outlives the Gateway removes itself when it finishes.

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
- **POSIX signal handling.** The framework installs none. `gateway.stop()` gives you the
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
