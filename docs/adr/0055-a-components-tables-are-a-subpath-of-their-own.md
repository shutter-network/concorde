# A component's tables are a subpath of their own

Partially reverses [ADR-0047](./0047-a-component-is-one-subpath.md). A component's tables leave the
component's subpath and go back onto a `/schema` subpath below it. `shared-agent-framework/users`
carries `createUsers` and its types; `shared-agent-framework/users/schema` carries the `users`
table, the `saf_users` schema object and the `tables` wrapper. The export map goes from fifteen
entries to twenty-three: eight components own tables, and each gets a second entry. The root still
exports nothing ([ADR-0051](./0051-the-package-root-exports-nothing.md)).

The prefixes go with the move. `usersSchema` is `schema`, `usersTables` is `tables`, and the same
for the other seven. The table names are unchanged and stay flat.

## The reason is a build tool's file-path API, and it is weaker than the one it replaces

ADR-0047 argued that a component is one thing, that a Developer should not have to remember which
of two specifiers holds which half of it, and that a reference page per component reads better than
a reference page per file. Every one of those arguments still holds. Nothing about them was found
to be wrong.

What overrules them is this, in `drizzle-kit`'s own config type:

```ts
schema?: string | string[]
```

Those strings are **file paths**. There is no object form and no callback form: the tool globs the
paths, requires each file, and reads the exports of what it got. So the only thing a package can
hand an Operator is a path, and the only supported way to name a path inside a package is an entry
in `exports`. Without one, an Operator writes `node_modules/shared-agent-framework/dist/users/schema.js`
into their config, against a layout this package has never promised and empties on every build.

That is the whole argument. It is a fact about one tool's interface rather than a fact about what a
component is, and it is worth being plain that a better version of `drizzle-kit` would take the
objects directly and this ADR would not exist. The alternative was to keep ADR-0047 whole and have
each deployment write a barrel module of its own that re-exports the components it runs, which is
what the four examples did. The barrel is what this buys back, and it is a real file with real
failure modes: its own first sentence goes stale, it is a second list of the components a
deployment runs that nothing compares against the first, and it is where the name collision below
lives.

## What the barrel cost, and why the prefixes were part of it

`export *` **excludes an ambiguous name**. Two modules starred into one barrel, both exporting
`schema`, produce a barrel exporting no `schema` at all: the name resolves to two bindings and ES
modules drop it rather than choose. Nothing warns. `drizzle-kit` then collects `Object.values` of
that barrel, finds no `PgSchema`, and an Operator's derived `schemaFilter` is empty, so `push`
compares nothing against nothing, prints `No changes detected`, creates not one table and exits 0.
The Gateway starts on the strength of that success and fails on its first query.

The prefixes existed to make that impossible by construction, and they worked. They are also the
only reason anybody ever typed `usersSchema` rather than `schema`.

With the barrel gone the hazard goes with it. `drizzle-kit`'s loader, `prepareFromPgImports`,
**requires each listed file separately** and concatenates what each yields. There is no namespace
merge anywhere in the pipeline, so there is no name for `export *` to drop, and a prefix protects
nothing. What the rename costs is one silent failure the repository can no longer produce and one
naming discipline it no longer has to hold: `scripts/check-package.ts` used to assert that eight
prefixed names survived a barrel, and that assertion is deleted rather than weakened, there being
no barrel for a name to survive.

The **table** names are a different question and are unchanged. `drizzle-kit` takes `Object.values`
of a module and keeps what passes `is(x, PgTable)` or `is(x, PgSchema)`, and it never looks inside
a plain object ([ADR-0046](./0046-the-operator-owns-migrations.md)), so a table gathered up into
`tables` and not also flat-exported is dropped in silence. That rule stands exactly as ADR-0046
wrote it.

## What a `/schema` subpath is

A directory with an `index.ts` that stars its component's `schema.ts`, which is the shape every
subpath in this package has. **The declarations do not move.** `src/<component>/schema.ts` is where
a table is declared, it is what the component's own modules import, and it is what
`src/schemas.test.ts` and `scripts/reference/schema-extraction.ts` scan for. Only the door in front
of it is new.

A star and not a list, deliberately. A list would be a second place to name every table, and a
table added to `schema.ts` and forgotten there would be queryable, absent from the DDL, and
mentioned by nothing.

**Eight names are on two subpaths, and no table is among them.** `signalStates`, `runStates`,
`messageDirections` and `scheduleKinds` are declared in the components' `schema.ts` files because
the check constraints on those columns are compiled from them, and `SignalState`, `RunState`,
`MessageDirection` and `ScheduleKind` are derived from those arrays and are what
`SignalRecord.state`, `RunRecord.state`, `MessageRecord.direction` and `ScheduleRecord.kind` are
declared with, on the wire. A reader of a record reaches them off the component; `export *` on the
`/schema` subpath carries them too.

Two ways to remove the overlap were declined. **Naming the exports on the `/schema` subpath**
rather than starring them would leave the arrays behind, and would also make a table added to a
`schema.ts` and forgotten in the list queryable, absent from the DDL, and mentioned by nothing:
that trade is a silent failure bought with a tidier export surface. **Inlining the four unions** at
their record types would remove the derivation, and it would take four names a Developer can import
with it. So the overlap stands and is recorded here. What the split is actually for is the tables,
and no table is on more than one specifier.

## The `--force` on `push`

`drizzle-kit push --force` is what an Operator's migrate step runs, and the flag is not
belt-and-braces. `push` asks before it applies a statement it considers destructive, and it asks on
a TTY. There is no TTY in a Compose one-shot service. Without `--force` the prompt has nowhere to
go, **the push applies nothing and exits 0**, the service is recorded as completed successfully,
the Gateway's `condition: service_completed_successfully` is satisfied, the Gateway starts, and
every query it makes fails against a database with no tables in it. The failure is at the far end
of a chain of successes, which is why the reason is written here: the flag reads like noise at the
call site and deleting it is a one-word change.

This is recorded in this ADR because the four examples carry no code comments and there is nowhere
else durable for it.

## The reference guard gets stricter rather than an exemption

A `/schema` entry is **not** a TypeDoc entry point. `excludeExternals` empties drizzle's type
parameter, so a generated page for one would print `PgTableWithColumns<{}>` for every table and say
less than the table page beside it already says. But an entry point list that simply omits eight
entries is an entry point list nothing holds against the export map.

So `site/specifier-titles.mjs` stops asking "is every export entry a TypeDoc entry point" and asks
"is every export entry documented by exactly one generator": a TypeDoc page or a generated table
page, both ways, with no exemption list. Eight `/schema` entries, eight table pages, one to one. A
`/schema` entry that gained a TypeDoc entry point fails on being documented twice; a component that
grew a `schema.ts` and no export entry fails on a page nobody can import.

## The costs, recorded

- **`check:package` grows from fifteen subpaths to twenty-three**, and every one of them is
  resolved to the type checker and to Node in a throwaway consumer project. Eight of those blocks
  import their tables by name, because a namespace import would resolve and prove nothing.
- **A consumer holding a table object changes import site.** `import { users } from
  "shared-agent-framework/users"` becomes `import { users } from
  "shared-agent-framework/users/schema"`, and every deployment's `drizzle.config.ts` is rewritten
  from a barrel to a list of resolved specifiers. This package is at `0.2.0` and the four examples
  are the whole of the known consumer base, so the sweep is four directories.
- **The import line stutters where it did not.** `shared-agent-framework/users/schema` says
  "schema" and then the module exports `schema`. That is the price of dropping the prefix, paid at
  the import site instead of at the identifier, and it is a smaller price than the one ADR-0047 was
  paying.
- **A Developer now has two pages per component to find things on**, which is the reader-facing
  half of ADR-0047's argument coming back. The reference sidebar carries the component pages and a
  collapsed `Tables` section, and the table page's heading is now the `/schema` specifier so the
  two are told apart by the line an Operator copies.
- **The doc comments on the tables stop being rendered anywhere.** While the tables were on the
  component subpath, TypeDoc documented each table and each schema object on the component's page
  with the prose written above it. A `/schema` subpath is not a TypeDoc entry point, and the table
  pages are generated from a `drizzle-kit` snapshot and carry structure rather than prose, so
  every sentence in a `schema.ts` is now a comment for a reader of the source alone. That is a
  real loss and it is accepted rather than answered: the sentence a reader most needs, which
  component has to be listed beside this one and why, is on the table page already, written from
  the foreign keys.

## Considered and rejected

**A programmatic migrate script**, calling `pushSchema` with the schema objects and skipping the
config file entirely. It works, and it is what `src/test-support/apply-schema.ts` does. Rejected
because ADR-0046's shape is `push` to prototype and `generate` + `migrate` in production, and
`generate` requires a config file pointing at a schema **path**. A flow that cannot become the
production flow is the wrong thing to demonstrate.

**Keeping the barrel and the prefixes**, which is the status quo and ADR-0047 whole. Rejected on
the barrel rather than on the prefixes: it is a file each deployment writes, whose content is a
list of the components it runs, which nothing compares against the components it constructs.

**Naming the subpath `/tables` rather than `/schema`.** It reads better against `tables` and worse
against `schema`, and it would be a third name for the same file after `schema.ts` and
`saf_<component>`. Rejected for consistency with the file it fronts.
