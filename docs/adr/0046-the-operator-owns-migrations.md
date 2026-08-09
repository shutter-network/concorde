---
status: partially superseded by ADR-0055
---

# The Operator owns migrations

> **Amended, and the barrel below is a file no deployment writes.**
> [ADR-0055](./0055-a-components-tables-are-a-subpath-of-their-own.md) put a component's tables on a
> `/schema` subpath of its own, and the barrel went with them: a deployment lists the `/schema`
> specifiers of the components it runs in its own `drizzle.config.ts` and **derives** `schemaFilter`
> by importing those same specifiers. So two things read false. The summary below says a deployment
> "assembles the ones it runs into a barrel", and the section headed "The deployment writes a barrel
> and a config" describes a `schema.ts` that `export *`s the parts — which is also what the second
> banner further down voids, that `export *` being the whole reason the prefixed schema names
> existed. What a barrel cost is why it is gone, and ADR-0055 has it. **Everything this ADR decides
> stands**: the framework applies no DDL, an Operator generates and applies it with their own
> `drizzle-kit`, and the flat-export rule below is unchanged and is the one ADR-0055 quotes.

The framework ships schema definitions and applies nothing. A component exports its tables;
a deployment assembles the ones it runs into a barrel, generates or pushes with **its own**
`drizzle-kit`, and applies the result against **its own** database. `db.migrate`,
`db.registerMigrations`, `MigrationDescriptor`, the five `*Migrations` descriptors, the five
root `drizzle.*.config.ts`, the shipped `migrations/` tree, and the verify-at-start in
`db.start` are all gone.

This supersedes the *migration mechanism* of
[ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md),
[ADR-0032](./0032-components-wire-themselves-at-construction.md), and
[ADR-0036](./0036-the-http-messengers-user-id-is-a-foreign-key.md). What those ADRs decide
about PostgreSQL itself is untouched: PostgreSQL only, a real schema per part, `drizzle-orm`
a pinned peer, `pg` out of the public API, `LISTEN`/`NOTIFY` and transactional DDL used
directly. Only *who generates and applies the DDL* changes, and everything below follows from
that one move.

## Why the old shape existed, and why it can dissolve

`drizzle-kit`'s workflow assumes an application that owns its whole database and runs the tool
itself. We are the opposite: a library that installs its tables into a database it does not
own and does not run a CLI against. Bridging that gap is the entire origin of the machinery
this ADR deletes:

- **Per-part migration folders, each with its own tracking table.** Mandatory under ADR-0022
  because Drizzle compares folder timestamps against only the newest tracker row, so two
  parts sharing a tracker silently skip the older one's migrations. It exists only because
  the *framework* was applying many folders in one process.
- **Folders resolved from `import.meta.url`, shipped at the repository root**, reached by
  `../../migrations/<part>` so the one location resolves identically from `src` and `dist`.
  It exists only because the framework had to carry `.sql` inside its own package.
- **Two hand-edits on every regeneration** ([ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md),
  [ADR-0036](./0036-the-http-messengers-user-id-is-a-foreign-key.md)): the `CREATE SCHEMA`
  line removed because `db.migrate` created the schema itself, and the cross-schema foreign
  key added back because a per-part config could not import another part's schema without
  emitting its `CREATE TABLE`.

Hand ownership to the party that actually owns the database, and every one of those closes at
once. There is one folder, so one tracking table, so no silent-skip to guard. There is no
`.sql` in the framework, so nothing to resolve from `import.meta.url` and no root folder. And
the two hand-edits vanish for the same reason (below). This is also the reading most
consistent with [ADR-0045](./0045-the-framework-builds-only-the-irreducible-infrastructure.md):
someone else's database schema is not irreducible framework infrastructure, and a migration
run is not something the framework has to build.

## The mechanism

**A component exports its tables on a `/schema` subpath.** `shared-agent-framework/decisions/schema`
re-exports `src/decisions/schema.ts` — the table objects as top-level named exports, the shape
`drizzle-kit` actually reads. This is verified, not assumed: `drizzle-kit`'s `prepareFromExports`
does `Object.values(exports)` and keeps only values that pass `is(x, PgTable)` / `is(x, PgSchema)`.
It **never looks inside a plain object**, so a wrapper like `export const decisionsTables = { decisions }`
is dropped in silence and `drizzle-kit` generates an empty migration. Flat named exports are the
only shape that survives — including through the Operator's `export *`, which carries names but
does not unwrap objects. This reverses ADR-0021/0022's "schemas are deliberately absent from the
subpath": they are public API now, on a subpath named `/schema` so the encapsulation-softening
sits behind one labelled door rather than blurring into each part's main API.

> **The `/schema` subpath left and came back.**
> [ADR-0047](./0047-a-component-is-one-subpath.md) moved the tables onto the component's own
> subpath, and [ADR-0055](./0055-a-components-tables-are-a-subpath-of-their-own.md) moved them
> back, because `drizzle-kit`'s config takes file paths and an export entry is the only supported
> way to hand an Operator one. So this section reads true again, with two corrections. The names
> lost their prefixes: `shared-agent-framework/users/schema` exports `schema`, `tables` and
> `users`, and the paragraph below about the Operator's `export *` is void with the barrel that
> needed it. And the "labelled door" rationale is not the reason the subpath exists; the reason is
> the config's type. Everything about the flat shape stands, and it is what `drizzle-kit` reads.

**The deployment writes a barrel and a config.** A `schema.ts` that `export *`s the parts it
runs, and a `drizzle.config.ts` pointing `schema` at that barrel. `drizzle-kit generate` then
sees one schema graph and one `out` folder — which is what retires both hand-edits. The
`CREATE SCHEMA` statements are now correct and wanted, because nothing pre-creates the
schemas. And the cross-schema foreign key generates itself, because `http-messenger/schema.ts`
now openly imports `users/schema.ts` to declare it: with one folder there is no other part's
`CREATE TABLE` to bleed into, so the import that ADR-0036 had to forbid is exactly the import
that makes the constraint free. `drizzle-kit` orders the statements within the single
generation, so ADR-0036's "construction order is load-bearing at `migrate`" is retired too.

**The example applies through an init container.** A one-shot `migrate` service — an example's
own `Dockerfile`, carrying the framework, `drizzle-kit`, the barrel and the config — runs
`drizzle-kit push` against the database, gated `postgres: service_healthy`. The gateway
gains `migrate: condition: service_completed_successfully`, mirroring the `agent-image` service
that already uses that condition. `push` is the prototype flow, legitimate here precisely
because the Operator owns this database; a production deployment changes one line —
`push` becomes `migrate` against a committed folder — and the compose wiring is identical.

## The costs, recorded and not mitigated

**1. A schema/database mismatch is now a raw runtime error.** `db.start` no longer verifies
that the database is up to date, so a forgotten or stale migration surfaces as a PostgreSQL
"column/relation does not exist" mid-request, not a clean refusal to boot. A boot-time check
rebuilt from the schema objects was considered and declined: applying migrations and
confirming they applied is the Operator's responsibility, whole. The framework does not
half-own it with a check.

**2. A deployment declares its parts twice.** Once by constructing them in `extend`, once by
`export *`-ing their schemas in the barrel, and nothing keeps the two lists in agreement.
Construct a part but omit its schema from the barrel and its tables are simply absent, felt as
cost 1 on the first query that needs them. Under the old shape, constructing a part
registered its migration automatically — one list, not two. This is the price of the split,
and it is unguarded by design.

**3. Production DDL is generated by the Operator's `drizzle-kit`, not authored by us.** We no
longer ship, review, or test the exact bytes applied to a production database, and
`check:package` can no longer prove "the shipped SQL applies" because nothing is shipped. The
residual risk is low because every correctness-critical detail lives in `schema.ts`, which is
what generation reads — `decisions.created_at` has no default, `seq` is `GENERATED BY DEFAULT`
not `ALWAYS`, `direction` carries its CHECK — so the intent survives even as byte-authorship
moves.

## Considered and rejected

**The framework pushes or migrates on the Operator's behalf.** Rejected: `push` and the
programmatic migrator both need a live connection to a database the framework does not own,
at a moment the framework is not present. The Operator installs a package; there is no point
at which the framework could run a CLI against their production database, and it should not
want to.

**Shrink the descriptor but keep the framework owning migrations.** The incremental option:
let `db.registerMigrations` take `(schema, folder)` and default the tracking table, collapsing
`migrations.ts` to one line. Rejected as a smaller version of the wrong thing — it keeps every
item in "Why the old shape existed": the per-part trackers, the shipped folders, the URL
resolution, and both hand-edits all remain. The gap only closes by moving ownership, not by
tidying our side of it.

**Rebuild a boot-time schema check from the schema objects.** The framework holds the table
objects and could, at start, introspect the live database and assert its parts' tables exist.
Rejected per cost 1: it re-splits an ownership we chose to make whole, and trades a small,
real deletion for a new mechanism guarding a failure the Operator is now responsible for.

## Consequences

- **The `*Migrations` exports are gone** — `signalsMigrations` from the root, and the four
  from `/users`, `/http-messenger`, `/decisions`, `/scheduler`. Each part instead exports its
  tables on a new `/schema` subpath. `MigrationDescriptor`, `db.migrate`, and
  `db.registerMigrations` leave the `Db` type; `db.start` keeps opening the pool and drops the
  verify loop.
- **`http-messenger/schema.ts` imports `users/schema.ts`.** The constraint ADR-0036 wanted is
  now declared in code, so the foreign key and its 404-inside-the-Run stand exactly as that
  ADR decided; only its hand-edit and its migration-ordering cost are retired. A deployment
  that runs the HTTP Messenger must also barrel the User Manager's schema, or generation
  references a table it does not create — the same "requires our User Manager" dependency,
  surfacing now at generation rather than at `migrate`.
- **`check:package` keeps its substance and loses the migrations.** It still installs the
  tarball into a fresh project and proves every subpath — now including each `/schema` — resolves
  to both the type checker and Node, which is what catches a broken `exports` map or an
  `import type` that should have been a value import. It no longer ships or applies any
  migration folder.
- **`drizzle-kit` leaves the framework's runtime story** and lives only where migrations are
  run: the example's migrate image, and any Operator's toolchain. `drizzle-orm` stays a pinned
  peer, because `schema.ts` and `db.handle` use it directly.
- **The encapsulation rule softens.** An exported table object is both migratable and
  queryable, so publishing schemas for generation also permits querying another part's tables.
  "No part reads another's tables" stays a discipline; it is no longer enforced by the objects
  being private.
- **Docs follow.** `CLAUDE.md`'s migration section, the `migrations:generate` instructions,
  `docs/data-model.md`, and the quickstart's apply step are rewritten to the Operator-owned
  flow, and ADR-0022/0032/0036 gain supersession banners pointing here.
