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

Nothing announces that either server started, because the framework starts neither: the
`listen` calls are yours, in your entry point, and so is any line you want about them.
Nothing announces startup at all, in fact — the first line above is the Signal the last
line of the entry point emits, and it is the first sign the process got up.

`Ctrl-C` stops it — after the Run in flight has finished, which is not instant and is
[the part of shutdown nothing can fix for you](#shutdown-handling-is-yours-to-write). It
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
lines before it opens the Store. The framework creates no directory anywhere, so creating
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

All `GET`, all JSON, all on the Agent server, and **all unscoped**:

| Route | Answers |
| --- | --- |
| `/signals?limit=&kind=` | `{ "signals": [ … ] }`, newest first |
| `/signals/<id>` | one Signal, or 404 |
| `/runs?limit=&signalId=` | `{ "runs": [ … ] }`, newest first |
| `/runs/<id>` | one Run, or 404 |

A **Signal** is `{ id, kind, payload, emittedAt, state, error }`. `payload` is arbitrary
JSON, exactly as the Producer wrote it. `emittedAt` is an ISO 8601 string, because JSON
has no date. `state` is one of `pending`, `processing`, `done`, `failed`, and `error` is a
string or `null`.

A **Run** is `{ id, signalId, session, prompt, state, error, startedAt, endedAt }`.
`session` is a plain name, or `null` where the Prompt asked for a fresh Session. `state`
is one of `pending`, `running`, `done`, `failed`. The timings are ISO 8601 strings, or
`null` for a Run that has not reached that point. The Run executing right now is in there,
and so is its Signal.

Four facts about the surface that an agent's instructions should carry, because each of
them is a request that would otherwise be written and quietly misunderstood:

- **There is no credential.** Reaching the port is access. Nothing to send, nothing to
  obtain, nothing to rotate.
- **Reads are not scoped.** Every Signal and every Run, whatever Session the Run asking
  is in. There is no `session` parameter and no `user` parameter on any route, and an
  unknown query parameter is a **400** rather than a request answered with everything —
  so a deployment that believed it was scoping something finds out at once.
- **`limit` defaults to 50 and caps at 200.** Asking for more is refused rather than
  quietly reduced. There is no cursor and no offset, so records past the cap are reached
  by narrowing with `kind` or `signalId` and not by paging.
- **Nothing here writes.** The Core has nothing an agent may change: a Signal is immutable
  but for the state the worker gives it, and a Run is the worker's record of its own work.

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

Read [`../example/gateway.ts`](../example/gateway.ts) — sixty-five lines of code under a
hundred and ninety with the comments, and the best documentation this project has.
Forty-three of those lines are the assembly itself; the rest are five lines of imports,
the configuration literals, the three directories it creates, and the two things at the
bottom the framework does not ship. Nothing in the framework represents the Gateway:
there is no object to construct, no registry to add parts to, no lifecycle to implement,
and no plugin system. The file *is* the Gateway, and every line of it is a part being
constructed and handed to another part.

Two things in it are the framework's to describe and **yours to do**, and both are near
the top. It `mkdir`s `state/workspace`, `state/agent` and `state/sessions`, because it is
about to declare all three as mounts and nothing else will create them. And an `AGENTS.md`
sits committed beside it — not written by anything at runtime, just a file in the
repository — which the Mount Table's fourth entry mounts into the Workspace read-only, and
which is the only thing that tells the agent the Agent server exists. The framework
creates no directory and writes no file, ever
([ADR-0028](./adr/0028-the-mount-table-declares-mounts-and-verifies-nothing.md)).

Then **the ordering is yours**, and it is the one thing about that file that is
not arbitrary:

1. **Open the Store.** One PostgreSQL URL. Nothing touches the network yet.
2. **Migrate.** An explicit call, never a side effect of construction — which is what
   lets it also be [a deploy step of its own](#migrations-as-a-separate-step).
3. **Construct, and register routes.** Two Fastify instances — the framework ships no
   server, so `Fastify()` is what you call and everything Fastify offers is yours without
   asking — then the Runtime Adapter and the Core, handing each what it needs, and then
   the Core's own routes onto the Agent one. Nothing constructed here has a side effect;
   the registration is the only one. The adapter takes the Mount Table and settles it on
   the spot, as a pure function of what you wrote: a relative path, or an entry no
   `hostPaths` prefix covers, is refused **at this line** rather than at the first Signal.
4. **Start the Core with its Handlers.** The Handler map is a parameter of `start`, so a
   Gateway running with no Handlers registered is not something you can express by
   accident.
5. **Listen.** Last, because Fastify refuses a route registration after a server is
   listening. Both bind addresses are stated here, next to each other, and there is no
   framework default behind either — see
   ["Where each server binds is yours to state"](#where-each-server-binds-is-yours-to-state).

Then two things the framework does not do for you, both at the bottom of the file:
**shutdown** and **emitting Signals**.

## Things that will bite you

These are not edge cases. Every one of them is something you meet on day one.

### Where each server binds is yours to state

The framework has no opinion about either bind address, and supplies no default for
either. Both are arguments to the `listen` calls at the bottom of your own entry point,
where the reference deployment writes them next to each other:

```ts
await publicServer.listen({ port: 8080, host: "0.0.0.0" });   // the exposed surface
await agentServer.listen({ port: 7411, host: "localhost" });  // loopback, deliberately
```

The asymmetry is the reason there are two servers. The Public server is the one meant to
be reached, and a Public server on loopback inside a container answers nobody — a
deployment that looks healthy and serves no User. The Agent server is the opposite: it
has no authentication, so **reaching the port is access**, and loopback is what keeps
that true. Moving it should be something you did on purpose, which is why it is written
out rather than inherited.

Two details worth knowing. `localhost` and `127.0.0.1` are not the same instruction to
Fastify — `localhost` binds both loopback addresses, IPv4 and IPv6, and `127.0.0.1` binds
only the first, so `localhost` is the one to write. And `localhost` is also Fastify's own
default, so a `listen` that says nothing about `host` is already on loopback; the
reference deployment states it anyway, because the most consequential value in a
deployment should not be one you have to know a library's defaults to find.

### Where the agent reaches you is not derivable from where the server binds

Where the Agent server's socket **binds** and how the agent's container **reaches** it
are two separate values, and nothing can compute either from the other. The framework
holds neither. The first is the `host` and `port` you pass to `agentServer.listen`; the
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
agent says so. The two values are in two files that sit next to each other — the `listen`
call at the bottom of `gateway.ts`, and the URL in `AGENTS.md` beside it. Read them
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
const core = createCore({ store, runtime, logger });
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

`compose.yaml` puts the agent on `saf_agent` and PostgreSQL on `saf_store`, and the
adapter passes `--network saf_agent`. So the agent **cannot resolve `postgres`**, which
is the point: the Store is the Gateway's own state and the agent is supposed to reach it
only through the Agent server's read-only routes.

What that does *not* do, and you should know it before you rely on it: a separate bridge
network stops **service-name discovery**, not **host access**. The Gateway is on your host
and the agent has to be able to reach it, so on Docker Desktop — where
`host.docker.internal` reaches the host's loopback interface, which is the whole reason
the Agent server works on `127.0.0.1` — the agent can reach *anything* bound there,
PostgreSQL on 5433 included. What stands between the agent and the Store on this machine
is the password, not the network. (Under a plain Linux daemon a loopback-bound port is
genuinely out of reach, which is the one way that platform is the stricter of the two.)

Two things follow. The credentials in `compose.yaml` are `saf:saf` because this is a local
demo; a real deployment supplies its own through `DATABASE_URL` and does not publish
PostgreSQL's port at all. And the agent's network is worth having as one layer, not as the
boundary.

### The Public server has no routes, and that is finished work

The entry point constructs a second Fastify instance and puts nothing on it. This is a
**scope boundary, not an unimplemented feature.**

The Public server is the surface the outside world reaches, and in this framework the
only thing users talk to is the **Messenger** — the part that authenticates them,
accepts what they send, and holds their outboxes. The Messenger is designed and
deliberately not built yet. Until it is, there is nothing for users to reach, so there
are no routes.

It exists in the entry point anyway, for two reasons. It is part of the Gateway's shape:
what the world can reach and what the agent can reach are different servers, kept apart
by what you register on each and by where each one binds. And it is where your own routes
go — `publicServer.register(yourPlugin, { prefix: "/api" })`, which is Fastify's own
plugin mechanism and the only extension mechanism there is.

The same is true in the other direction: nothing emits Signals in this slice either,
because the Messenger was the only shipped thing that would. That is why the last line
of the entry point calls `core.emit` directly — and that is not a stand-in for a real
Producer, it *is* one. Anything inside the Gateway that emits a Signal is a Producer,
including a loop you write.

### Shutdown handling is yours to write

The framework ships **none**. No signal handling, no drain, no ordering — and the two
servers are yours to close, because they are yours to have constructed. What is in the
entry point is an example, and the ordering in it is the part that matters:

```ts
process.on("SIGINT", async () => {
  await core.stop();                                            // first
  await Promise.all([agentServer.close(), publicServer.close()]);
  await store.close();                                          // last
});
```

`core.stop()` **before** `store.close()`. The worker holds a dedicated PostgreSQL
connection to be woken on, and the Store owns it — so closing the Store first pulls that
connection out from under a running Core, which then logs a dropped connection and
retries reconnecting forever.

And the part no ordering fixes: **a Run in flight when the signal arrives.** `core.stop()`
waits for it, which can be minutes. Killing the process instead leaves that Signal marked
`processing`; the next start marks it `failed` and never re-runs it, because it may
already have written the Workspace or made external calls, and replaying it would do all
of that twice. Whether that is acceptable, and what to do about it, is a decision every
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
every Signal and every Run in the Store, unscoped by Session or by User.

That is deliberate: a credential is no boundary against the agent, which is the only
party meant to reach it at all. What follows is that keeping the port unreachable is
your whole defence, and that defence is the `host` you pass to `listen` and nothing else.
Nothing checks it and nothing warns about it: the framework never sees the address, and
where a server binds is the deployment's to decide and this page's to explain.

The specific trap worth knowing: **publishing a container port inserts firewall rules
that bypass your host's own.** A `ports:` entry that looks like it is behind `ufw` or
`firewalld` is not. If this server ever ends up published, the consequence is not a leak
of some records — the agent-facing surface is the Gateway's whole read side, and anything
that can reach it can also reach whatever else you mounted there.

## Migrations as a separate step

`gateway.ts` migrates at boot. It is idempotent, and for one process on one machine that
is all you need.

Applying migrations is an **explicit call** rather than something opening the Store does
for you, and the reason is the deployment where those are two steps:

```sh
node example/migrate.ts       # against the new schema, before anything serves new code
```

Same call, six lines, no Gateway involved. Each part of the framework exports a
*migration descriptor* — inert data naming a folder, a PostgreSQL schema, and a tracking
table — and your entry point hands them all to one `store.migrate(...)`. The Core's is
`coreMigrations`; add your own alongside it. Do add them to that one call rather than
making a second: each part having its own tracking table is not tidiness, it is the only
thing that stops one part's migrations being silently skipped, and the one call is where
a collision can be caught.

You never run a schema generation tool. The SQL ships inside the package.

## Making it yours

Five things you will want, in the order you will want them.

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

`core.start({ "file.arrived": summarising("/workspace") })` puts it to work.

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

**Your own routes.** `server.register(plugin, { prefix })`, on either instance. They are
plain Fastify instances, so its plugin system is the extension mechanism and there is no
contract of ours to satisfy. Register before `listen`.

**Your own Producer.** Anything that calls `core.emit(tx, { kind, payload })`. A webhook
route, a poller, a loop. Note the transaction: `emit` takes yours rather than finding one,
so recording something in your own tables and telling the agent about it either both
happen or neither does — and a rollback wakes nobody.

**Your own tables.** `store.handle(yourSchema)` gives you a typed Drizzle handle through
the same call the framework's own parts use, and `store.tx(cb)` a transaction you can pass
into `core.emit`. No privileged access and no special case. Give your part its own
PostgreSQL schema and its own migration tracking table.

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

- **The Messenger** — users, messages in both directions, outboxes, authentication.
  Designed, not built. It is why the Public server is empty and why nothing but your entry
  point emits Signals.
- **The Scheduler** — recurrence and future work. Designed, not built.
- **Timeouts, cancellation, and retry.** Refused, with the consequences spelled out
  above.
- **Authentication on the Agent server.** Refused, with the consequences spelled out
  above.
- **Any check on what you mounted.** Refused, with the cost spelled out above. The
  container runtime refuses a source that is not there, and that is the whole of it.
- **Any file the framework writes.** It writes none, anywhere, ever — not the agent's
  settings, not its instructions, not a directory to put them in.
- **Shutdown handling.** Yours.
- **Any Agent Runtime but `pi`.** The adapter's contract is narrow enough that another is
  possible; none is written.
- **Retention.** Session directories grow by one per fresh-Session Run and nothing prunes
  them.

The reasoning for each is in [`../docs/adr/`](./adr/), and the map of how the parts fit
together is [`architecture.md`](./architecture.md). Neither is required reading to run
what you just ran.
