# Components wire themselves at construction

A Component is given the parts it needs and wires itself to them. `createUsers({ db,
tokenTtl, agentServer, publicServer })` registers its own routes on each server it is
given and its own migration descriptor with the Db; `createSignalWorker({ db, runtime,
handlers, agentServer })` does the same. `db.migrate()` then takes no arguments and
applies everything that registered, and `db.start()` refuses to start if any registered
schema is behind the migration folder shipped beside it.

The Operator's entry point constructs, orders and starts. It no longer wires. Five
`register` calls and a hand-assembled list of migration descriptors leave
`example/gateway.ts`, and the class of bug where a part is constructed and its
migrations are not applied stops being expressible.

This reverses three things. [ADR-0021](./0021-the-framework-has-no-plugin-system.md) said
"construction stays free of side effects, like migrations before it", and said each part
"exports an inert migration descriptor and the entry point applies them in one explicit
step". [ADR-0010](./0010-the-agent-reaches-the-gateway-over-http.md) said switching an
endpoint group off "is simply not registering that plugin".

Note what is *not* reversed. The registration is a convention about constructor options,
not a contract: the `Component` interface stays `name`, `start` and `stop`, with no
`routes` field and no `migrations` field
([ADR-0031](./0031-parts-that-run-are-components.md)). The thing ADR-0021 rejected was a
type that every part implements in common; this is two ordinary options that two
components happen to share.

## What is kept, and what it costs

**Omission still switches a route group off.** The server options are optional, so a
deployment with no use for the User Directory's Agent server routes passes no
`agentServer`, and a deployment replacing our password login with its own passes no
`publicServer` ([ADR-0030](./0030-passwords-are-traded-for-bearer-tokens.md)). ADR-0010's
property survives with a different spelling: an omission rather than a flag, still.

**The plugins stay exported.** `users.agentRoutes`, `users.publicRoutes` and
`worker.agentRoutes` remain public, because Fastify's encapsulation is the reason
ADR-0021 chose Fastify, and an Operator who wants our routes inside their own scoped
plugin, behind a shared hook, or under a version prefix can only do that by holding the
plugin. Passing the server is the easy path; the plugin is the door out.

**The prefix becomes the component's**, and every document already assumed it was.
`example/AGENTS.md` hard-codes `/signals` and `/runs` into the agent's own instructions,
and the User Directory's own doc comments write `{ prefix: "/users" }` and `POST
/auth/tokens` as though they were fixed. Making the component own the layout removes an
option nobody was varying and turns three documents into one truth. An Operator who needs
a different layout takes the escape hatch above.

**What is lost is legibility, and it is not recoverable by a comment.** You could
previously read the Gateway's whole HTTP surface off the entry point, because every route
group appeared in a `register` line. Now you infer it from which components were given a
server.

## Migrations register, and the Db verifies rather than applies

`db.migrate()` applying whatever registered is only safe if the *other* entry point
registers the same set. `example/migrate.ts` exists so that migrations can run as a
pre-deploy step rather than only at boot, and it must stay cheap: descriptors therefore
remain exported and that file registers them directly, constructing nothing but a Db. The
alternative, letting construction be the only path, would have made the migration job
build a Signal Worker, which needs a Runtime Adapter, which in the reference deployment
needs a model credential and an image name. **A migration job that needs an
`ANTHROPIC_API_KEY` is a broken migration job.**

Two entry points registering two lists can drift, and that is what
**`db.start()` verifies**. For each registered descriptor it reads the largest `when` in
the folder's `meta/_journal.json` and compares it against `select max(created_at)` from
the descriptor's tracking table. It refuses to start if the table is absent or the
database is behind. Being *ahead* is allowed, because that is what a rollback looks like.

This also closes a hole ADR-0021 accepted: "constructing a part against an unmigrated
schema is representable, and surfaces as a Postgres `relation does not exist` on the
first request that touches it." It now surfaces as a refusal to start that names the
schema.

**Migrations are not applied at start**, and this is the one place we declined to go
further. `drizzle-orm`'s PostgreSQL migrator takes no advisory lock: it reads the newest
tracker row, then opens a transaction and applies everything newer. Two processes booting
together both read the same row, both apply the same DDL, and the loser's transaction
rolls back and takes its process down. Applying at start would make a rolling deploy of
three replicas crash two of them, with no way to opt out that is not a flag. Beyond that,
`start` rewriting the schema is a far larger capability than every other Component's,
which bind a port and open a pool.

## Consequences

- **Migrating moves after construction** in the entry point, where it used to come first.
  This works because the pool is lazy, but it means `db.migrate()` is a method called on a
  Component that has not started, which reads oddly the first time.
- **A new way to fail to boot.** A database one migration behind used to serve requests
  until one touched the missing relation; it now refuses to start. That is the intended
  trade, and it is a behaviour change for anyone who was relying on the former.
- **Operators keep their own tables by the same mechanism**, which
  [ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md) already established:
  `db.handle(theirSchema)` and `db.registerMigrations(theirDescriptor)` instead of passing
  a descriptor to `migrate`. Their schema is verified at start like ours.
- **`registerMigrations` is idempotent for an identical descriptor** and unchanged
  otherwise: two *different* folders naming one tracking table still throw, because that
  is the failure ADR-0022 describes where Drizzle silently skips the older folder's
  migrations and reports success.
- **`db.start()` reads from disk.** One `meta/_journal.json` per registered descriptor,
  at boot.
