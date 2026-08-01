# Parts that run are Components

The framework defines one interface. A **Component** is a `name`, a `start()` and a
`stop()`. `components(list)` starts them in the order given, stops them in reverse, and
unwinds a failed start. Nothing else is added: no registry, no dependency declarations,
no field for tables or routes, no way to look a Component up by name.

[ADR-0021](./0021-the-framework-has-no-plugin-system.md) argued the opposite and is
superseded here. Its central argument is not superseded, and it is the reason this
interface is two methods rather than eleven fields: enumerating what an Operator wants
to vary produced seams with nothing in common, and a contract covering all of them
degenerates to "a thing with an optional everything". That still holds. **A Component is
not a plugin contract. It is a lifecycle, and only parts that run have one.**

Today there are four: the Db, the Signal Worker, the Public server and the Agent server.
The User Directory is not one. Neither is the Runtime Adapter, whose whole contract is
`run(prompt, runId)`; nor the Mount Table, which is inert by decision
([ADR-0028](./0028-the-mount-table-declares-mounts-and-verifies-nothing.md)); nor a
Signal Handler, which is the extension point rather than a part. `createUsers` returns
what it returns today, with no `start` and no `stop`, because it has nothing to run and
nothing to release. It becomes a Component on the day it grows one, and the only thing
that changes in an entry point is the list.

## Why this and not ADR-0021

Because of a cost that ADR-0021 accepted in its own words:

> every deployment hand-writes its own SIGTERM handling, and a serial worker mid-Run at
> shutdown is a situation each Operator meets alone

That cost turned out to be the whole of what a lifecycle interface buys, and it is worth
two methods. The evidence is that we got it wrong ourselves. `example/gateway.ts` handled
`SIGINT` and not `SIGTERM`, so the reference deployment drained cleanly when a developer
pressed Ctrl-C and was killed outright by `docker stop`, which is what `compose.yaml`
sends. That leaves a Run `processing`, and a Run left `processing` fails permanently on
the next boot ([ADR-0017](./0017-failed-runs-are-not-retried.md)). Eleven lines of
hand-written ordering, in the one file whose job is to demonstrate the ordering, with the
wrong signal name in it.

**Both methods are required.** A Component with no work at either end has no position in
an order, so putting one in the list is ceremony that implies its placement matters when
it does not. Optional methods would also reconstruct precisely the shape ADR-0021
rejected. The rule is therefore a sentence rather than a type: if you have background
work or a resource to release, you are a Component.

## What the interface does not do

Dependencies are passed as ordinary constructor options and are never declared to the
framework. `components(list)` receives objects that already hold each other; it resolves
nothing, injects nothing, and could not tell you what depends on what. A graph was
considered and rejected: it would move the wiring out of the entry point, and the wiring
is where the Signal Handlers are built, which is what keeps the Signal Worker free of a
reference to the User Directory ([ADR-0029](./0029-users-are-a-part-of-their-own.md)).

`components(list)` returns a plain `{ start, stop }` and is not itself a Component.
Nesting has no use here and would force it to carry a `name` that nothing reads.

## Consequences

- **The list is a second order, it is load-bearing, and nothing checks it.** The Db
  starts first because everything queries it and the drain queries it on the way down.
  **The Agent server starts before the Signal Worker**, so that it closes after the
  drain: the agent calls it mid-Run (`example/AGENTS.md` gives the agent those URLs), and
  closing it first would refuse the agent its own API while a Run is still in flight. The
  Public server goes last so that it stops accepting submissions first. The framework
  cannot know any of this, so it is a comment in the reference deployment and nothing
  more.
- **This inverts the shutdown order the reference deployment used**, which closed both
  servers together after the drain and so kept the Public server accepting submissions
  throughout it.
- **A failed `start` unwinds.** Everything already started is stopped, in reverse, before
  the error is rethrown, so `start()` has one postcondition: everything is running, or
  nothing is. The alternative was to rethrow and leave the wreckage, on the grounds that
  the only response to a failed startup is to exit. Rejected because a half-started
  Gateway holds a pool and possibly a `LISTEN` connection, and
  [ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md) already names that
  failure: a process that will not exit and a database that cannot be dropped, with no
  error anyone can read.
- **`stop` is best-effort and idempotent.** Every Component is stopped even if one throws,
  and the errors are aggregated at the end, because one failure stranding the other three
  is the worst available behaviour. Idempotence falls out of popping a started list, and
  it matters because a second Ctrl-C fires the handler again. `start` called twice is not
  guarded: it would start a second worker and break serial execution
  ([ADR-0012](./0012-the-gateway-is-a-serial-signal-worker.md)), but it is the Operator
  calling `start` twice in their own file.
- **The Signal Worker takes its Handlers as a construction option**, not as an argument to
  `start`. This strengthens what ADR-0021 designed out: a Signal Worker with no Handlers
  was previously unstartable and is now unconstructable. It costs the allowance in
  [ADR-0024](./0024-signal-handlers-receive-only-the-signal.md) that "a handler may
  therefore close over the Core itself", which nothing in the repository exercised. An
  Operator who wants it writes a `let` in the entry point, which is where ADR-0024
  already puts Handler construction.
- **`store.close()` becomes `db.stop()`**, and the Db's `stop` closes the pool and every
  `LISTEN` connection exactly as `close` did.
- **A Fastify instance reaches the list through `serverComponent`**, which constructs
  nothing and wraps nothing: the Operator still calls `Fastify()` with their own options
  and holds the instance, exposed on the Component as `.fastify`. It is generic in the
  instance type, so a server carrying a type provider, http2 or a custom logger passes
  through unchanged. Only `listen` and `close` come through us, which keeps ADR-0021's
  "nothing of ours between this file and Fastify" true of everything that matters. The
  address is on the Component rather than the instance because that is Fastify's own
  split: `Fastify()` takes no port, and `listen` is the call `start` has to make.
- **The framework still ships no POSIX signal handling.** What ADR-0021 complained about
  was the ordering, and the ordering is now ours; the registration is
  `process.once(name, () => void gateway.stop())` over two strings. What remains is
  policy we should not pick: the exit code, whether to force-exit when a Run will not
  finish, whether a second signal escalates. After `stop` nothing holds the event loop,
  so the process exits by itself with no `process.exit` anywhere.
- **"Component" is no longer a rejected term.** `CONTEXT.md` retired it along with
  "service", "plugin", "module" and "extension" as synonyms; it returns as a term with
  the narrow meaning above, and the others stay rejected. "Part" survives as the informal
  word for anything in the Gateway, Component or not, and most parts are not Components.
