---
status: partially superseded by ADR-0031, ADR-0032 and ADR-0036
---

# The Store is PostgreSQL, accessed through Drizzle

> **Renamed and superseded in one detail.** The Store is now the **Db**: `openDb`,
> `db.handle`, `db.tx`, `db.listen`, `db.migrate`, and `db.stop` where `store.close` was.
> The handle type this ADR's mechanism returns is `Handle<TSchema>`, since `Db` now names
> the component. See [`CONTEXT.md`](../../CONTEXT.md) and
> [ADR-0031](./0031-parts-that-run-are-components.md).
>
> [ADR-0032](./0032-components-wire-themselves-at-construction.md) changes how a
> descriptor reaches `migrate`. It is registered rather than passed: a Component calls
> `db.registerMigrations(...)` when it is constructed, an Operator with their own tables
> does the same, and `db.migrate()` takes no arguments and applies everything registered.
> The Db then verifies each registered schema at start and refuses to start behind one.
> Everything this ADR decides is unaffected: PostgreSQL only, per-part schemas, per-part
> tracking tables mandatory for the reason given below, and `pg` staying out of the public
> API.
>
> **Partially superseded by
> [ADR-0036](./0036-the-http-messengers-user-id-is-a-foreign-key.md)** in one claim: "no
> table references another part's" now has exactly one exception, the HTTP Messenger's
> `messages.user_id`, which is a foreign key onto `saf_users.users.id`. Nothing else here is
> affected: PostgreSQL only, a schema per part, a migration tracker per part, and migrations
> shipped inside the package all stand. The exception costs the four things ADR-0036 records,
> among them a hand-edit on every `drizzle-kit` regeneration, because the generator cannot
> express a cross-schema reference without emitting the foreign part's DDL, and a
> construction order that becomes load-bearing at `migrate`.

The Store is PostgreSQL and nothing else. Schemas and queries are written with `drizzle-orm`'s `pg-core`, the whole surface is asynchronous, and there is no storage abstraction, no repository layer, and no second dialect.

This reverses the initial intent, which was SQLite in a file. The reversal is not about scale — [ADR-0012](./0012-the-gateway-is-a-serial-signal-worker.md)'s serial worker means a single node is the design, and a SQLite file would have carried the load indefinitely. It is about a correctness trap. **Every SQLite driver for Node is synchronous, and Drizzle's transaction API is silently unsafe with them.** An `async` callback passed to `db.transaction()` typechecks with no complaint, and then: under `better-sqlite3` it throws `Transaction function cannot return a promise` *after* the callback body has already run outside any transaction, so writes land non-atomically while the caller reasonably concludes nothing happened; under `node:sqlite` it is accepted, no transaction is ever opened, and `tx.rollback()` does nothing — verified by successfully running `BEGIN` from inside the callback. A single `await` anywhere in the callback triggers it. Avoiding that means enforcing "never `await` inside a transaction" as a convention across our code *and* every Operator's, where the penalty for breaking it is silent data loss that no test reliably catches.

Postgres also supplies three things we use rather than merely tolerate. Component schemas are real database namespaces instead of table-name prefixes. DDL is transactional, so a failed migration rolls back whole. And a connection per concurrent request means Outbox polling is not blocked by the worker, where a synchronous driver would block the event loop for the duration of every query.

We considered **PGlite**, embedded Postgres compiled to WASM, which would have kept the "no database server" story. Rejected: it is alpha and 32-bit, runs with `fsync = off`, costs 38 MB for an empty database, and hard-PANICs the Node process rather than erroring on unsupported SQL. Decisively, two OS processes opening one datadir do not fail — they diverge and silently lose committed writes, with no lockfile and no warning. That makes any admin CLI, cron container, or overlapping restart an unannounced data-loss event, which is the opposite of SQLite's behaviour and disqualifying for a default. We also considered **libsql** to keep SQLite as an async embedded option. Rejected because it is a second *dialect*: it would cost the schema namespacing and transactional DDL above, and force every component's tables to be defined twice.

## Consequences

- **A deployment requires a PostgreSQL server.** Configuration is a connection URL and a managed credential rather than a filesystem path, backup is `pg_dump` rather than copying a file, and major-version upgrades need `pg_upgrade`. Tests run against a container.
- **Each component owns a Postgres schema and its own migration tracker.** `pgSchema('messenger')` for tables, and `migrate()` with both `migrationsSchema` and `migrationsTable` set per component. This is mandatory, not tidy: Drizzle's guard compares timestamps against only the newest row of the tracker, so components sharing one tracker cause the older component's migrations to be **silently skipped while `migrate()` resolves successfully**. Per-component trackers are a complete fix.
- **Migrations ship inside the package** as generated SQL plus `meta/_journal.json`, resolved relative to `import.meta.url` and never `process.cwd()`. Both files are required — the migrator will not run on SQL alone. Bundling the framework into a single file breaks this, since the migrator reads `.sql` off disk.
- **`drizzle-orm` is a peer dependency.** Two copies in one dependency tree produce structurally incompatible branded types in Operator code.
- **We pin Drizzle.** Stable `0.45.2` has been frozen since March 2026 while development continues on a `1.0` line whose generated migration folder format differs and whose docs have already moved on. Upgrading is a deliberate migration, not a version bump.
- **Postgres is not abstracted and will not be swapped.** `pgSchema`, transactional DDL, and `LISTEN`/`NOTIFY` are used directly. Anyone reaching for a different engine is rewriting the Store, and that is the intended cost.
- Migration hashes are recorded but **never verified**, so Drizzle gives no schema-drift detection. If we want that, we write it.

- **Components obtain a handle with `store.handle(schema)`**, which returns a typed `PgDatabase<PgQueryResultHKT, typeof schema>` over the shared pool. `pg` therefore stays internal rather than joining Fastify and Drizzle as public API.
- **Operators may keep their own tables after all**, using exactly this mechanism: `store.handle(theirSchema)` plus their own migration descriptor passed to `store.migrate()`. This closes what was an open question here and softens [ADR-0021](./0021-the-framework-has-no-plugin-system.md)'s "Operators get no tables of their own" — the capability falls out of the design rather than being added to it, and needs no privileged access or special case.
