# The framework has no plugin system

> **Superseded in part** by [ADR-0031](./0031-parts-that-run-are-components.md) and
> [ADR-0032](./0032-components-wire-themselves-at-construction.md), including this ADR's
> title. Seven claims below no longer hold. The rest do, and so does the argument that
> produced them: the eleven seams have nothing in common, which is exactly why the
> interface that now exists is two methods rather than a plugin contract.
>
> 1. *"no lifecycle protocol that parts of the Gateway implement in common"*. There is
>    one. A **Component** is a `name`, a `start` and a `stop`, and only parts that run
>    are Components: today the Db, the Signal Worker and the two servers (ADR-0031).
> 2. *"Startup and shutdown ordering belong to the Operator, since nothing owns the set
>    of parts."* Something owns the set now. The Operator writes the start order as a
>    list; reverse-order stop and the unwind of a failed start are the framework's
>    (ADR-0031).
> 3. *"the Core takes its Signal Handlers when it starts"*. The Signal Worker takes them
>    at construction, which makes one with no Handlers unconstructable rather than merely
>    unstartable. The allowance in
>    [ADR-0024](./0024-signal-handlers-receive-only-the-signal.md) that a Handler may
>    close over the Core goes with it (ADR-0031).
> 4. *"Each part exports an inert migration descriptor and the entry point applies them in
>    one explicit step."* Components register their descriptor with the Db when they are
>    constructed, and `db.migrate()` takes no arguments. The descriptors stay exported, so
>    a pre-deploy migration job still constructs nothing (ADR-0032).
> 5. *"constructing a part against an unmigrated schema is representable, and surfaces as
>    a Postgres `relation does not exist` on the first request that touches it."* The Db
>    verifies every registered schema at start and refuses to start behind one (ADR-0032).
> 6. *"'Component' is retired as a term."* It is a term again, with the narrow meaning in
>    ADR-0031. "Service", "plugin", "module" and "extension" stay rejected, and "part"
>    stays the informal word for anything in the Gateway, most of which are not
>    Components.
> 7. *"[ADR-0010](./0010-the-agent-reaches-the-gateway-over-http.md)'s endpoint groups can
>    be switched off per deployment ... is just not registering that plugin."* A Component
>    registers its own routes on the servers it is given, so switching a group off is
>    omitting the server option. Still an omission rather than a flag, and the route
>    plugins stay exported for anyone who wants their own prefix or encapsulation
>    (ADR-0032).
>
> Also superseded, by [ADR-0037](./0037-the-gateway-is-a-record-of-components.md) and
> [ADR-0038](./0038-the-default-assembly-is-a-constructor.md): *"The Gateway has no
> object"* and *"the Operator's entry point is that assembly"*. `createGateway(record)`
> returns one, and `createGatewayWithDefaults` constructs the six parts a deployment using
> ours would otherwise construct by hand. The argument in this ADR's *body* is untouched,
> and is the reason the returned object is a record with two methods rather than a plugin
> host: it resolves nothing, injects nothing, and cannot say what depends on what.
>
> Unaffected: Fastify is still public API, the Store's
> schema is still not public API while obtaining a handle is, Producer is still a role
> rather than a type, and the framework still ships no POSIX signal handling. What this
> ADR calls the Store and the Core are now the Db and the Signal Worker; see
> [`CONTEXT.md`](../../CONTEXT.md).
>
> Three later corrections, all from
> [ADR-0046](./0046-the-operator-owns-migrations.md), and two of them to the paragraph
> immediately above rather than to this ADR's body.
>
> 1. **"the Store's schema is still not public API" no longer holds.** Each component's
>    tables are public API on the component's own subpath,
>    `shared-agent-framework/<component>`, because that is what an Operator's own
>    `drizzle-kit` reads to generate their DDL. (ADR-0046 put them on a `/schema` subpath
>    beside it; [ADR-0047](./0047-a-component-is-one-subpath.md) moved them onto the
>    component itself and retired that one. Public either way, which is this item's point.) Obtaining a handle
>    still is too, and "no part reads another's tables" survives as a discipline rather
>    than as something the objects being private enforced.
> 2. **Item 5 is withdrawn, and this ADR's original sentence is true again.**
>    Constructing a part against an unmigrated schema is representable, and surfaces as a
>    PostgreSQL `relation does not exist` on the first request that touches it. The
>    verify-at-start that ADR-0032 added is deleted; ADR-0046 records the reopened hole as
>    a cost it accepts rather than one it missed.
> 3. **Item 4 goes further than ADR-0032 took it.** There are no migration descriptors at
>    all, so nothing registers one at construction and nothing stays exported for a
>    pre-deploy job. That job still constructs nothing, and now for a simpler reason: it
>    is a `drizzle-kit` run against the Operator's own barrel.

The framework exposes ordinary constructed objects and named interfaces. It defines no plugin contract, no registry, and no lifecycle protocol that parts of the Gateway implement in common. An Operator customises each part on that part's own terms.

We started from the opposite assumption: a single `Component` abstraction that the Messenger, the Scheduler, and anything an Operator wrote would all satisfy — owning tables, mounting routes on either server, running background work, emitting Signals, with `start`/`stop`. We also considered splitting it in two, a `Producer` that may emit Signals and a routes-only `Service`, so that a routes-only extension could not forge a Signal's attribution.

Both were rejected. Enumerating what an Operator actually wants to vary produced eleven seams, and they have nothing in common: some are plain configuration values, some are a single function, and only a few are objects with a lifecycle. A contract covering all of them degenerates to "a thing with an optional everything," and the two-kind split fails on the first example — the Messenger emits Signals *and* serves routes *and* owns tables, so it lands in both boxes. The privilege argument for splitting is real but is answered by trust rather than by types: every part of the Gateway is trusted already ([ADR-0020](./0020-producers-are-trusted-components-of-the-gateway.md)).

Where extensibility is genuinely wanted, something else already provides it. HTTP routes extend through **Fastify's own plugin system** on whichever server the route belongs to, which brings encapsulation, prefixes, decorators, and hooks that we would otherwise reimplement badly. Background work is ordinary code the Operator starts, calling the Core's emit method to produce Signals. Replacing the Messenger or the Scheduler means not constructing ours.

## Consequences

- **The Gateway has no object.** It is one deployable assembled from a Store, two servers, a Core, and whichever Producers a deployment wants — and the Operator's entry point *is* that assembly. No god object, and nothing to grow capabilities on later.
- **Startup and shutdown ordering belong to the Operator**, since nothing owns the set of parts. One hazard is designed out rather than documented: the Core takes its Signal Handlers when it starts, so "started with none registered" is unrepresentable — which matters because an unhandled Signal fails permanently under [ADR-0017](./0017-failed-runs-are-not-retried.md). Migrations are **not** designed out this way. Each part exports an inert migration descriptor and the entry point applies them in one explicit step, which keeps them runnable from a separate entry point — a pre-deploy migration job rather than only at boot ([ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md)). The cost is that constructing a part against an unmigrated schema is representable, and surfaces as a Postgres `relation does not exist` on the first request that touches it. The residual cost is real too: every deployment hand-writes its own SIGTERM handling, and a serial worker mid-Run at shutdown is a situation each Operator meets alone.
- **Fastify is public API.** Handing out server instances means a Fastify major version is a breaking change for every deployment. Accepted: the alternative is wrapping it, which costs us the plugin ecosystem that was the reason to choose it.
- **"Component" is retired as a term**, along with "service", "plugin", "module" and "extension" as synonyms. `CONTEXT.md` keeps "part" as the informal word. **"Producer" survives as a role, not a type** — anything that emits a Signal is acting as one, including a loop in the Operator's entry point.
- **The Store's *schema* is not public API**, but obtaining a handle is. This started as the narrower "Operators get no tables at all," and [ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md) relaxed it: since every part gets its handle via `store.handle(ownSchema)` and registers its own migration descriptor, an Operator wanting their own tables uses the identical mechanism. No part reads another's tables, and nothing is privileged — the capability falls out rather than being granted.
- Two things in earlier decisions get simpler rather than harder. [ADR-0010](./0010-the-agent-reaches-the-gateway-over-http.md)'s "endpoint groups can be switched off per deployment" and [ADR-0018](./0018-scheduling-is-a-separate-component.md)'s disableable scheduling endpoint are both just *not registering that plugin* — a configuration flag becomes an omission.
