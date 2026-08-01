# Quickstart

From a fresh clone to a completed agent Run, on one machine, in five commands.

Everything here is self-contained: you do not need to read an architecture document or
a decision record to get this working. Links to those exist where you might want the
reasoning, and every one of them is optional.

What you will end up with is a **Gateway**: one process that owns a queue of things that
arrived from outside, turns each of them into a Prompt, and runs an AI agent against
that Prompt inside a container. The vocabulary is in [`../CONTEXT.md`](../CONTEXT.md);
the four words you need before you start are:

| Word | Meaning |
| --- | --- |
| **Signal** | something that arrived from outside and may cause the agent to act |
| **Signal Handler** | your code, which turns a Signal into zero, one, or many Prompts |
| **Run** | one execution of the agent: one Prompt, in one Session |
| **Workspace** | a directory your Handlers and the agent both read and write |

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
the agent's container reads and writes every mount, as this process's own user
Signal claimed                              {"kind":"ask", ...}
Run started                                 {"session":"user_42", ...}
Run finished                                {"session":"user_42", ...}
Signal finished                             {"state":"done", ...}
```

Nothing announces that either server started, because the framework starts neither: the
`listen` calls are yours, in your entry point, and so is any line you want about them.
The mount check runs before both of them, so the first line above is still the sign that
the process got up.

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

Ask a second question in the same Session and the agent will remember the first: the
Session directory is how, and it is why Sessions get a directory each.

## What the entry point actually does

Read [`../example/gateway.ts`](../example/gateway.ts) — fifty-three lines of code under a
hundred and seventy with the comments, and the best documentation this project has. Thirty-four
of those lines are the assembly itself; the rest are five lines of imports, the
configuration literals, and the shutdown handler the framework does not ship. Nothing in the framework represents the Gateway:
there is no object to construct, no registry to add parts to, no lifecycle to implement,
and no plugin system. The file *is* the Gateway, and every line of it is a part being
constructed and handed to another part.

Which means **the ordering is yours**, and it is the one thing about that file that is
not arbitrary:

1. **Open the Store.** One PostgreSQL URL. Nothing touches the network yet.
2. **Migrate.** An explicit call, never a side effect of construction — which is what
   lets it also be [a deploy step of its own](#migrations-as-a-separate-step).
3. **Construct, and register routes.** Two Fastify instances — the framework ships no
   server, so `Fastify()` is what you call and everything Fastify offers is yours without
   asking — then the Runtime Adapter and the Core, handing each what it needs, and then
   the Core's own routes onto the Agent one. Nothing constructed here has a side effect;
   the registration is the only one.
4. **Verify the mounts.** One throwaway container that proves the agent can really see
   the three directories, and refuses the deploy if it cannot. A step of its own rather
   than something constructing the adapter does, for the same reason migrating is.
5. **Start the Core with its Handlers.** The Handler map is a parameter of `start`, so a
   Gateway running with no Handlers registered is not something you can express by
   accident.
6. **Listen.** Last, because Fastify refuses a route registration after a server is
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

### `agentServerUrl` is not derivable from where the server binds

Where the Agent server's socket **binds** and how the agent's container **reaches** it
are two separate values, and nothing can compute either from the other. The second one is
`agentServerUrl`, a field of the Runtime Adapter's configuration: an absolute base URL,
no default, and nothing validates it — it is written into the agent's instructions file
byte for byte as you wrote it, a trailing slash included.

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

On a shared Compose network where the Gateway is itself a service, neither is needed:
`agentServerUrl` is `http://<service-name>:7411` and the bind stays inside the network.

If you get this wrong the symptom is clear at least: the agent says it cannot reach the
URL it was given. Both values are in your own entry point, a few lines apart — the `host`
and `port` you passed to `agentServer.listen`, and the `agentServerUrl` you passed to
`createPiAdapter`. Read them together; nothing else has to be consulted.

### The agent's container runs as *your* uid

With bind mounts, files the agent writes are owned by whoever the container runs as. So
the adapter defaults `user` to the Gateway process's own `uid:gid` — otherwise your
Signal Handlers cannot read what the agent left in the Workspace, and the agent cannot
read what they left for it.

The consequence: **the mounted directories must be writable by that uid.** In the
reference deployment they are, trivially, because the Gateway runs as you on your own
machine and the directories are under `example/state/`. In a deployment where those
directories come from somewhere else — a volume, a provisioned path, another
container — making them writable by that uid is your job.

You will be told if you get it wrong. `runtime.verifyMounts()` starts one throwaway
container at boot, writes a token into each of the three mounts, has the container read
it back and write its own, reads that, edits it, and checks who owns it. A failure
**refuses startup and names the mount**, with all three of its paths printed.

Two limits on the ownership half of that, both deliberate. Only the **uid** is compared,
not the gid: a file created in a `setgid` directory takes the directory's group on both
sides equally, so refusing over a differing gid would refuse deployments that work — the
gid is reported when the uid is wrong, because it is the next thing to look at. And
**Docker Desktop remaps bind-mount ownership to the host user**, so on macOS the ownership
comparison passes whatever happens; it is exact only under a real bind mount on a Linux
daemon. The read-and-write round trip either side of it holds on both, and that is the
part that actually matters — it is what "each side can use what the other wrote" means. That container start
is worth its cost, because two of the three failures it catches are otherwise completely
silent: an agent directory that did not mount leaves the agent running happily knowing
nothing about the Agent server, and a Session root that did not mount makes every
Session start empty, which reads as a forgetful model rather than a broken deployment.

### The line you need to diagnose a mount or a network is off by default

The Runtime Adapter logs the whole composed container invocation — every flag, every
`--volume`, the image, the network, and `pi`'s own arguments — so that diagnosing a mount
or a network problem never means reading framework source. It logs it at **`debug`**, and
the logger every part falls back to when you supply none runs at `info`. So by default you
do not see it.

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

Four things you will want, in the order you will want them.

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

## No key, or a different provider

The reference deployment names Anthropic in two places — `model`/`provider` in the
adapter's configuration, and `ANTHROPIC_API_KEY` in the `env` it passes into the
container. Both are one-line edits, and `env` is the whole of what you put in the agent's
environment: this process's own is deliberately **not** inherited, which is much of the
reason the agent runs in a container at all. The adapter adds exactly two variables of its
own — one turning off `pi`'s startup network calls, which you can override, and one
pointing `pi` at the mounted agent directory, which you cannot, because an agent pointed
anywhere else finds none of the configuration written for its Run.

For another provider, change the model, the provider, and the variable name. For a local
OpenAI-compatible server, leave `provider` off and describe it in `models`, which is
written to the agent's `models.json` untouched.

There is a second way in, worth knowing because it survives restarts: the agent's own
directory persists between Runs, so an `auth.json` you put there is picked up, and `pi`'s
own documentation says a credential there takes priority over the environment. Credentials the agent refreshes mid-Run persist the same
way. What does *not* persist is the agent's **settings** — those are rewritten from your
entry point before every single Run, on purpose, so that nothing the agent was talked into
doing to its own configuration outlives the Run it happened in.

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

If you do containerise it, the framework has the one thing you need for it. A mount is
three values, not one: where the directory is **as this process sees it**, where it
appears **to the agent**, and what the **container runtime** should resolve. The reference
deployment sets the first two; the third defaults to the first and exists precisely for
the case where the Gateway is itself in a container and the daemon resolves paths on the
host. Get it wrong and the daemon silently creates an empty directory rather than
refusing — which is the failure `verifyMounts()` exists to turn into a startup error.

## No agent image is published

There is no official `pi` image; every deployment builds one.
[`../example/agent/Dockerfile`](../example/agent/Dockerfile) is the reference, and it is
four instructions under a page of comments. Four things the adapter needs of any image
you substitute:

1. **`pi` as the `ENTRYPOINT`** — the adapter appends `pi`'s flags after the image name.
2. **A POSIX shell** — the agent's shell tool needs one, and so does the mount check.
3. **`curl`** — `pi` ships no HTTP client, so the agent reaching the Agent server is its
   shell plus `curl`.
4. **No dependence on a passwd entry** — the container runs as a uid the image has never
   heard of, so nothing may need `/etc/passwd` or `$HOME` to name it.

The model, the key, the Workspace, and the instructions are deliberately not in the image.
All four are the Gateway's, passed or written per Run, so changing any of them is an edit
to your entry point rather than an image rebuild.

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
- **Shutdown handling.** Yours.
- **Any Agent Runtime but `pi`.** The adapter's contract is narrow enough that another is
  possible; none is written.
- **Retention.** Session directories grow by one per fresh-Session Run and nothing prunes
  them.

The reasoning for each is in [`../docs/adr/`](./adr/), and the map of how the parts fit
together is [`architecture.md`](./architecture.md). Neither is required reading to run
what you just ran.
