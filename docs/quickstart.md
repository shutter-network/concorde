# Quickstart

From a fresh clone to a completed agent Run, on one machine, in five commands.

Everything here is self-contained: you do not need to read an architecture document or
a decision record to get this working. Links to those exist where you might want the
reasoning, and every one of them is optional.

What you will end up with is a **Gateway**: one process that owns a queue of things that
arrived from outside, turns each of them into a Prompt, and runs an AI agent against
that Prompt inside a container. The vocabulary is in [`../CONTEXT.md`](../CONTEXT.md);
the five words you need before you start are:

| Word | Meaning |
| --- | --- |
| **Signal** | something that arrived from outside and may cause the agent to act |
| **Signal Handler** | your code, which turns a Signal into zero, one, or many Prompts |
| **Run** | one execution of the agent: one Prompt, in one Session |
| **Workspace** | a directory your Handlers and the agent both read and write |
| **Mount Table** | your list of what the agent's container can see on disk, and who it runs as |

## Before you start

- **Docker**, running. The agent executes in a container, one fresh container per Run,
  and the Gateway starts them itself.
- **[mise](https://mise.jdx.dev)**, which provisions the pinned Node version. Anything
  else that gives you Node 24 also works.
- **A model API key.** The reference deployment is written for Anthropic and reads
  `ANTHROPIC_API_KEY` from your environment. Any provider `pi` supports works — the
  environment variable's name and the `model`/`provider` fields in the entry point are
  what change. See ["No key, or a different provider"](#no-key-or-a-different-provider)
  below.

## Five commands

```sh
mise install                                          # Node 24
npm ci                                                # dependencies
npm run build                                         # the example imports the package by name
docker compose -f example/compose.yaml up -d --build   # PostgreSQL, the agent image, the networks
ANTHROPIC_API_KEY=sk-ant-... node example/gateway.ts
```

The last command starts the Gateway *and* emits one Signal, so a Run happens
immediately. You should see roughly this, one JSON line at a time:

```
Signal claimed                              {"kind":"ask", ...}
Run started                                 {"session":"user_42", ...}
Run finished                                {"session":"user_42", ...}
Signal finished                             {"state":"done", ...}
```

Nothing announces that either server started. One call binds both ports, opens the pool
and starts the worker, and it says nothing about any of it — the framework logs no
startup line anywhere, and any line you want about one is yours to write next to that
call. The first line above is the Signal the last line of the entry point emits, and it
is the first sign the process got up.

`Ctrl-C` stops it — after the Run in flight has finished, which is not instant and is
[the part of shutdown nothing can fix for you](#shutdown-is-two-lines-and-the-policy-is-yours). It
keeps running because a Gateway is a server; ask it something else by restarting it with
your question as an argument:

```sh
ANTHROPIC_API_KEY=sk-ant-... node example/gateway.ts "what did I ask you before?"
```

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

## Seeing what happened

The Gateway's own record lives in PostgreSQL, and the agent reads it over HTTP. So can
you:

```sh
curl -s http://127.0.0.1:7411/signals | jq
curl -s http://127.0.0.1:7411/runs | jq
```

A Run row carries the exact Prompt the agent was given, its Session, its state, its
timings, and — if it failed — why, in the provider's own words. That `error` column is
the first place to look when something goes wrong, and usually the only place you need.

The Run also leaves things on disk, under `example/state/`:

```
example/state/workspace/            the Workspace: your Handlers and the agent share it
example/state/agent/                the agent's own directory: credentials, trust, tooling
example/state/sessions/user_42/     one directory per Session, holding its transcript
```

Those three directories are **the entry point's**, `mkdir`ed by `gateway.ts` itself a few
lines before it opens the Db. The framework creates no directory anywhere, so creating
what your mounts point at is the deployment's job rather than a courtesy —
[a wrong path costs you a Signal](#a-wrong-path-costs-you-a-signal) is what happens when
one is missing. What ends up inside them is the agent's, written as your own uid.

Ask a second question in the same Session and the agent will remember the first: the
Session directory is how, and it is why Sessions get a directory each.

One thing in there is not what it looks like. After the first Run you will find an **empty
`example/state/workspace/AGENTS.md`**, and it is not the file the agent read. A mount's
*target* is created by the daemon when it is not already there, and the real file is
`example/AGENTS.md`, mounted over that path read-only on every Run. Editing the empty one
changes nothing and deleting it changes nothing; the file to edit is the committed one.

## Telling the agent about the Agent server

The framework does not tell the agent anything. It writes no file, passes no system
prompt, and holds no text about itself — so an agent nobody tells about the Agent server
never calls it. Telling it is yours, and **this section is what you copy from.**

The mechanism is `pi`'s own: it looks for `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` or
`CLAUDE.MD` in its working directory and that directory's ancestors, and its working
directory is your `workspacePath`. So you put a file in the Workspace and it is found. The
reference deployment commits [`../example/AGENTS.md`](../example/AGENTS.md) and mounts it
there, **read-only**, as the fourth entry of its Mount Table:

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
Signal Worker's, and the last three are there because the reference deployment hands the
Agent server to the User Directory as well.

| Route | Answers |
| --- | --- |
| `GET /signals?limit=&kind=` | `{ "signals": [ … ] }`, newest first |
| `GET /signals/<id>` | one Signal, or 404 |
| `GET /runs?limit=&signalId=` | `{ "runs": [ … ] }`, newest first |
| `GET /runs/<id>` | one Run, or 404 |
| `GET /users?limit=` | `{ "users": [ … ] }`, newest first |
| `GET /users/<id>` | one User, or 404 |
| `POST /users` | the User it created |

A **Signal** is `{ id, kind, payload, emittedAt, state, error }`. `payload` is arbitrary
JSON, exactly as the Producer wrote it. `emittedAt` is an ISO 8601 string, because JSON
has no date. `state` is one of `pending`, `processing`, `done`, `failed`, and `error` is a
string or `null`.

A **Run** is `{ id, signalId, session, prompt, state, error, startedAt, endedAt }`.
`session` is a plain name, or `null` where the Prompt asked for a fresh Session. `state`
is one of `pending`, `running`, `done`, `failed`. The timings are ISO 8601 strings, or
`null` for a Run that has not reached that point. The Run executing right now is in there,
and so is its Signal.

A **User** is `{ id, attributes, createdAt }`. `attributes` is arbitrary JSON that the
deployment's own code put there and is the whole of what anything means by authorization.

Four facts about the surface that an agent's instructions should carry, because each of
them is a request that would otherwise be written and quietly misunderstood:

- **There is no credential.** Reaching the port is access. Nothing to send, nothing to
  obtain, nothing to rotate.
- **Reads are not scoped.** Every Signal, every Run and every User, whatever Session the
  Run asking is in. There is no `session` parameter and no `user` parameter on any route,
  and an unknown query parameter is a **400** rather than a request answered with
  everything — so a deployment that believed it was scoping something finds out at once.
- **`limit` defaults to 50 and caps at 200.** Asking for more is refused rather than
  quietly reduced. There is no cursor and no offset, so records past the cap are reached
  by narrowing with `kind` or `signalId` and not by paging.
- **The one thing here that writes creates a User with nothing.** The Signal Worker has
  nothing an agent may change at all: a Signal is immutable but for the state the worker
  gives it, and a Run is the worker's record of its own work. `POST /users` takes a
  password and no attributes, so an agent talked into creating a User cannot make it a
  privileged one, and setting attributes, replacing a password, issuing a Token and
  revoking one are methods on the User Directory and no route at all.

`pi` ships no HTTP client, so the agent calls this with its shell tool and `curl` — which
is why `curl` is one of the four things the agent's image needs:

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

Read [`../example/gateway.ts`](../example/gateway.ts) — seventy-nine lines of code under
two hundred and sixty-seven with the comments, and the best documentation this project
has. Twelve of those lines are imports; the rest are the configuration literals, the three
directories it creates, the parts themselves, and the two things at the bottom the
framework does not ship. Nothing in the framework represents the Gateway: there is no
object to construct, no registry to add parts to and no plugin system. The file *is* the
Gateway, and every line of it is a part being constructed and handed to another part.

Two things in it are the framework's to describe and **yours to do**, and both are near
the top. It `mkdir`s `state/workspace`, `state/agent` and `state/sessions`, because it is
about to declare all three as mounts and nothing else will create them. And an `AGENTS.md`
sits committed beside it — not written by anything at runtime, just a file in the
repository — which the Mount Table's fourth entry mounts into the Workspace read-only, and
which is the only thing that tells the agent the Agent server exists. The framework
creates no directory and writes no file, ever
([ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)).

The whole of an assembly is four steps — **construct, migrate, order, start** — and the
third of them is the one thing about that file that is not arbitrary.

One word before them. A **Component** is a part with something to run: a `name`, a
`start` and a `stop`, and nothing else at all. Four things here are Components — the Db,
the two servers and the Signal Worker — and the User Directory is deliberately not one,
having nothing to start and nothing to release. It is not a plugin contract: nothing
declares a dependency, nothing is resolved, and parts still hold each other because you
passed them to each other.

1. **Construct.** The Db from one PostgreSQL URL, two `Fastify()` instances as Components,
   the Runtime Adapter, the User Directory and the Signal Worker with its Handler map,
   each handed what it needs as an ordinary constructor option. Construction is also the
   whole of the wiring: a part handed a server registers its routes on that server, and a
   part with tables of its own registers its migration descriptor with the Db, so there is
   no third item on a checklist for you to forget
   ([ADR-0032](./adr/0032-components-wire-themselves-at-construction.md)). Nothing here
   touches the network. The adapter does settle the Mount Table on the spot, as a pure
   function of what you wrote: a relative path, or an entry no `hostPaths` prefix covers,
   is refused **at this line** rather than at the first Signal.
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

Then two things the framework does not do for you, both at the bottom of the file:
**shutdown** and **emitting Signals**.

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
the adapter has no field for it, has never read it, and never sees that address at all.

The reference deployment uses `http://host.docker.internal:7411` with a loopback bind,
and that works **on Docker Desktop**, which routes that name to the host including its
loopback interface.

**On a plain Linux daemon it does not.** There, you need both of:

- `--add-host=host.docker.internal:host-gateway` in the adapter's `extraArgs`, because
  the name does not otherwise exist; and
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
the Mount Table defaults its `user` to the Gateway process's own `uid:gid` — otherwise
your Signal Handlers cannot read what the agent left in the Workspace, and the agent
cannot read what they left for it. It sits beside the entries because it is the other
half of the same fact: what is shared, and who shares it. Write `user: "1000:1000"` on the
table to override it; it is a default and not a rule.

The consequence: **the mounted directories must be writable by that uid.** In the
reference deployment they are, trivially, because the Gateway runs as you on your own
machine and the directories are under `example/state/`. In a deployment where those
directories come from somewhere else — a volume, a provisioned path, another
container — making them writable by that uid is your job.

Nothing checks it for you. The framework verifies no mount and starts no container at
boot, so an unwritable directory is something the agent meets during a Run — with the
consequence in the next section.

### A wrong path costs you a Signal

Nothing verifies your mounts. There is no startup check, no throwaway container, and not
even a `stat` of the paths you declared: the Mount Table performs no I/O at all, on
purpose ([ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)).
Resolving it catches what is wrong with what you *wrote* — a relative path, an entry your
`hostPaths` does not cover — and nothing at all about what is on your disk.

What catches the rest is the container runtime, and it does catch it. Every entry is
emitted as `--mount type=bind`, never `-v`, and the difference is the point: `-v` invents
a missing source as a `root`-owned **directory**, even where you meant a file, and the
agent then reads an empty Workspace perfectly happily. `--mount` refuses, naming the path:

```
docker: Error response from daemon: invalid mount config for type "bind":
bind source path does not exist: /srv/saf/wokspace
```

**The bill is that this arrives at the first Run, not at boot.** A failed Run is never
retried ([ADR-0017](./adr/0017-failed-runs-are-not-retried.md)), so the Signal that found
your typo is dead permanently: fixing the path and restarting does not bring it back, and
if that Signal was a user's question, the user is owed a new one. This is the one real
cost of nothing being checked, and it is worth knowing before you meet it rather than
after.

Two things soften it. The daemon's message is in the Run's `error` column, verbatim, with
the exit code beside it — so the first place you look is the place it is. And there is
nothing timing-dependent about which Runs fail: a mount that is wrong is wrong for every
Run, so the first Signal after a deploy tells you, and it tells you the same thing the
hundredth would.

### The line you need to diagnose a mount or a network is off by default

The Runtime Adapter logs the whole composed container invocation — every flag, every
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
const runtime = createPiAdapter({ /* ... */, logger });
const worker = createSignalWorker({ db, runtime, handlers, logger });
```

Safe to keep in a log file: the argument list on that line has environment **values**
stripped out, because the real one carries your provider API key. The two values a mount
problem is diagnosed from are kept.

The same line carries one field the argv cannot: `sessionDirectory`, the Session's own
directory **as this process sees it**, rather than as the container does. That is the
answer to "the agent has forgotten everything" — go and look at whether the transcript is
where you think it is. The Mount Table works the container path back through your entries
to produce it, and reports nothing at all where the Session root is not something you
mounted, which is itself the answer in that case.

### The agent's network isolates less than it looks like

`compose.yaml` puts the agent on `saf_agent` and PostgreSQL on `saf_db`, and the
adapter passes `--network saf_agent`. So the agent **cannot resolve `postgres`**, which
is the point: the Db holds the Gateway's own state and the agent is supposed to reach it
only through the Agent server's read-only routes.

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

### The Public server carries logins and nothing else, and that is finished work

The only thing on it is the User Directory's `/auth` group, because the entry point hands
it that server. Nothing on it accepts a submission and nothing on it emits a Signal. This
is a **scope boundary, not an unimplemented feature.**

The Public server is the surface the outside world reaches, and in this framework users
talk to two parts and no others: the **User Directory**, which authenticates them, and
the **Messenger**, which accepts what they send and holds their outboxes. The User
Directory is built and wired up here. The Messenger is designed and deliberately not built
yet, so the half of the surface that would accept anything from a User is missing, and
that is the whole of what is missing.

The server would be in the entry point regardless, for two reasons. It is part of the
Gateway's shape: what the world can reach and what the agent can reach are different
servers, kept apart by what you register on each and by where each one binds. And it is
where your own routes go — `publicServer.fastify.register(yourPlugin, { prefix: "/api" })`,
which is Fastify's own plugin mechanism and the only extension mechanism there is.

The same is true in the other direction: nothing emits Signals in this slice either,
because the Messenger was the only shipped thing that would. That is why the last line
of the entry point calls `worker.emit` directly — and that is not a stand-in for a real
Producer, it *is* one. Anything inside the Gateway that emits a Signal is a Producer,
including a loop you write.

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
db.registerMigrations(signalsMigrations, usersMigrations);
await db.migrate();
```

The identical descriptor registered twice is one registration. Two *different* folders
naming one tracking table still throw, because that is the failure where Drizzle silently
skips the older folder's migrations and reports success.

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
the Agent Runtime exactly as you wrote it, and one that runtime will not accept fails
that Prompt's Run with the runtime's own complaint in the Run's `error` and your name in
its `session`.

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

That is the whole integration surface, and it is what the Messenger will use too. Four
things about it are decisions rather than omissions, and are cheaper to learn now than to
discover:

- **Seeding the first User is yours, and it happens once.** A User has no natural key — no
  email, no username, nothing to match on — so "create this User if absent" cannot be
  written. Create one out of band against the Agent server and keep the id it returns:
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
happen or neither does — and a rollback wakes nobody.

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

Both paths are absolute, and `containerPath` is POSIX however your own platform spells a
path. An entry may name a directory or a single file, and the declaration does not say
which, because nothing in the Mount Table looks. Create the source yourself before the
first Run — nothing else will, and the daemon refuses what is not there.

## No key, or a different provider

The reference deployment names Anthropic in two places — `model`/`provider` in the
adapter's configuration, and `ANTHROPIC_API_KEY` in the `env` it passes into the
container. Both are one-line edits, and `env` is the whole of what you put in the agent's
environment: this process's own is deliberately **not** inherited, which is much of the
reason the agent runs in a container at all. The adapter adds exactly two variables of its
own — one turning off `pi`'s startup network calls, which you can override, and one
pointing `pi` at the mounted agent directory, which you cannot, because an agent pointed
anywhere else finds nothing you put there.

For another provider, change the model, the provider, and the variable name. For a local
OpenAI-compatible server, leave `provider` off and put a `models.json` describing it in
the agent's directory yourself. The framework will not carry it for you: it has no
`models` field and no `settings` field, because writing out JSON it never reads is
pass-through with a file write attached. Anything `pi` should read on disk is yours to
place in a directory you mount, and the framework has never heard of any of it.

There is a second way in, worth knowing because it survives restarts: the agent's own
directory persists between Runs, so an `auth.json` you put there is picked up, and `pi`'s
own documentation says a credential there takes priority over the environment. Credentials
the agent refreshes mid-Run persist the same way — which is the point of that directory,
and the reason nothing of ours writes into it.

Everything in there persists, including whatever the agent did to its own settings. If you
want a file the agent cannot durably change, the answer is a **read-only single-file
entry** in the Mount Table, the same shape `AGENTS.md` uses; the framework no longer holds
that property by rewriting anything. Two facts about doing it to `settings.json` in
particular, both checked against `pi@0.83.0` rather than assumed: it must be the **file**
that is read-only and not the directory, because `pi` takes a lock beside that file even
to read it, and a write it is refused is recorded rather than thrown, so the Run survives
being denied.

Without a usable key the Gateway still starts, the container still runs, and the Run is
recorded as **failed** carrying the provider's own message — which is worth seeing once,
because it is also what a real model error looks like:

```
"error": "the Agent Runtime settled with stopReason \"error\" and exited successfully
          anyway: 401 {\"type\":\"error\", ... \"message\":\"invalid x-api-key\"} ..."
```

Note "exited successfully anyway". The Agent Runtime's machine-readable mode exits zero
on model and API errors, so the outcome is read out of the event stream and never from the
exit code. You do not have to do anything about that; it is here because seeing a
successful exit next to a failed Run is otherwise alarming.

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
    { containerPath: "/sessions", gatewayPath: "/srv/state/sessions" },
  ],
  // this container's /srv/state is the host's /var/lib/saf
  hostPaths: { "/srv/state": "/var/lib/saf" },
}
```

Keys are matched **longest prefix first**, so a general mapping and a specific exception
coexist. Leave `hostPaths` out and every entry is its own source, which is what every
example on this page has been doing.

Once you write one it is **exhaustive**. An entry whose `gatewayPath` falls under no key
is refused when you construct the adapter, with a message naming the path and listing the
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
four instructions under a page of comments. Four things the adapter needs of any image
you substitute:

1. **`pi` as the `ENTRYPOINT`** — the adapter appends `pi`'s flags after the image name.
2. **A POSIX shell** — the agent's own shell tool needs one.
3. **`curl`** — `pi` ships no HTTP client, so the agent reaching the Agent server is its
   shell plus `curl`.
4. **No dependence on a passwd entry** — the container runs as a uid the image has never
   heard of, so nothing may need `/etc/passwd` or `$HOME` to name it.

The model, the key, the Workspace, and the agent's instructions are deliberately not in
the image. The first two are passed in per Run and the last two are mounted, so changing
any of them is an edit to your entry point, or to a file beside it, rather than an image
rebuild. Nothing is *written* into the image or into a mount by the framework; the reason
the instructions are mounted rather than baked in is that a mount can be read-only and can
change without a rebuild.

## Tearing it down

```sh
docker compose -f example/compose.yaml down -v   # containers, networks, and the database volume
rm -rf example/state                             # the Workspace, the agent's directory, the Sessions
```

`example/state/` is gitignored. It holds credentials the agent wrote, so do not commit it.

## What is not here

So you do not go looking:

- **The Messenger** — messages in both directions, and outboxes. Designed, not built. It is
  why the Public server carries nothing but logins and why nothing but your entry point
  emits Signals.
- **Any way to remove a User**, any account-recovery flow, and any limit on password
  guessing. All three refused, with the reasoning above and in the ADRs.
- **The Scheduler** — recurrence and future work. Designed, not built.
- **Timeouts, cancellation, and retry.** Refused, with the consequences spelled out
  above.
- **Authentication on the Agent server.** Refused, with the consequences spelled out
  above.
- **Any check on what you mounted.** Refused, with the cost spelled out above. The
  container runtime refuses a source that is not there, and that is the whole of it.
- **Any file the framework writes.** It writes none, anywhere, ever — not the agent's
  settings, not its instructions, not a directory to put them in.
- **POSIX signal handling.** The framework installs none. `components` gives you the
  ordering; the exit code, any timeout on the drain and what a second signal does are
  yours.
- **Any Agent Runtime but `pi`.** The adapter's contract is narrow enough that another is
  possible; none is written.
- **Retention.** Session directories grow by one per fresh-Session Run and nothing prunes
  them.

The reasoning for each is in [`../docs/adr/`](./adr/), and the map of how the parts fit
together is [`architecture.md`](./architecture.md). Neither is required reading to run
what you just ran.
