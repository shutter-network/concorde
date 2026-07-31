# Cross-component writes take an explicit transaction

Any function one part of the Gateway calls on another takes the transaction as its first parameter. `emit` is the case that matters: the Messenger records an inbound Message and emits a Signal in one transaction, so it calls `emit(tx, signal)` rather than `emit(signal)`.

The obvious alternative is ambient enlistment — one connection shared by every part, so any write joins whatever transaction happens to be open and no signature mentions transactions at all. That is what we intended, and it is **silently wrong** on Postgres. `NodePgSession.transaction()` detects a `pg.Pool` and calls `client.connect()` to take a dedicated connection for the transaction. A second Drizzle handle over the same pool therefore writes on a *different* connection, and its writes survive the transaction's rollback with no error reported anywhere. Verified against PostgreSQL 17.10: after a rollback, the other handle's row was still there.

Ambient enlistment does work if every handle shares a single `pg.Client` rather than a pool — which is exactly why this is worth recording. The implicit version appears correct in any test written against a single client, and breaks the moment a pool is introduced for concurrency. The failure mode is lost atomicity, discovered in production.

The type that accepts both a database handle and a transaction is driver-agnostic and comes from the dialect package rather than the driver:

```ts
import { PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';
type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
```

Note `typeof db` does **not** work: `drizzle()` returns a handle intersected with `{ $client }` that a `PgTransaction` lacks. That is drizzle-orm issue #3175, open since 2024 and still reproducing.

Two further constraints follow from each part holding a handle typed to *its own* schema ([ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md)). A transaction carries its originating handle's schema in its type, so **cross-part signatures widen the schema parameter** rather than naming one part's schema. And inside such a function the receiving part must use the **query-builder** form, `tx.insert(signals).values(…)`, not the relational form `tx.query.signals` — the query builder generates SQL from the table object and works across schemas, while the relational API is genuinely scoped to the handle's registered schema.

## Consequences

- **A transaction parameter appears in every cross-component signature**, which is the visible cost. In exchange, no part learns anything else about another: the Messenger knows `emit(tx, signal)` and nothing about the Core's schema, tables, or existence.
- **The connection pool is safe to use**, and the public server can serve Outbox polls concurrently with the worker.
- **`tx.rollback()` throws.** `TransactionRollbackError` propagates out of `db.transaction()` rather than being swallowed, so callers using it as control flow must catch and filter it. It is exported from `drizzle-orm`.
- **Nothing prevents an Operator from ignoring this.** A handler holding two handles and expecting implicit atomicity gets the broken behaviour. The framework's own paths are correct by construction; Operator code is guidance, as everywhere else ([ADR-0009](./0009-signal-handlers-are-arbitrary-code.md)).
