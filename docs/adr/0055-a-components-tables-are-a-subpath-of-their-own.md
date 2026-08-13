# A component's tables are a subpath of their own

Partially reverses [ADR-0047](./0047-a-component-is-one-subpath.md). A component's tables leave the
component's subpath and go back onto a `/schema` subpath below it. `shared-agent-framework/users`
carries `createUsers` and its types; `shared-agent-framework/users/schema` carries the `users`
table, the `saf_users` schema object and the `usersTables` wrapper. The export map goes from fifteen
entries to twenty-three: eight components own tables, and each gets a second entry. The root still
exports nothing ([ADR-0051](./0051-the-package-root-exports-nothing.md)).

**This ADR was amended after it shipped, and one of its decisions is reversed.** It removed the
component prefixes from the two names every schema module declares, on the ground that no
deployment writes a barrel any more. Deployments write one again, so the prefixes are back:
`usersSchema` and `usersTables`, not `schema` and `tables`. The table names are unchanged and stay
flat, then and now. The section below headed *the prefixes come back* is the reversal, and the
original reasoning is left standing above it rather than edited away, because it was correct about
everything except how long its premise would hold.

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

## Amended: the prefixes come back, because the barrel does

The premise above is that a deployment lists `/schema` specifiers directly in its
`drizzle.config.ts`, so no module ever merges two schema modules into one namespace. That held for
one release. What it cost the four examples was the config itself: `drizzle-kit` globs the `schema`
field, a bare package specifier globs to nothing, so every config resolved its specifiers with
`createRequire(import.meta.url)` and derived `schemaFilter` by requiring them a second time. Twenty
lines of build-tool trivia in the one file every consumer copies out, and a `createRequire` that had
to be documented as a shape nobody may modernise.

A deployment now writes a `schema.ts` that is `export *` per component, and its config points at
that one relative path. `createRequire` goes, the specifier array goes, and the component list reads
as ordinary import lines. The barrel is back, and with it the hazard this ADR deleted the prefixes
to celebrate the end of.

Measured rather than argued, on the real toolchain. `drizzle-kit push --force` over a barrel of two
components whose schema objects were both called `schema`:

```
[✓] Changes applied
saf_users.users
```

The other component's two tables are absent and the tool reports success. Under Node's ESM
semantics the ambiguous name is dropped from both modules; under the `tsx` loader `drizzle-kit`
actually registers, esbuild's re-export helper keeps the **first** binding, so one arbitrary
component wins. Either way `schemaFilter` derives to one schema name out of eight and seven
schemas never get a `CREATE`. With the prefixes restored, the same push yields all three tables.

**The rule is narrower than the one this ADR removed, and it is mechanically decidable.** A name
every schema module declares is prefixed. A name that describes one particular thing is not. Two
names are in the first class, `<component>Schema` and `<component>Tables`, and any third would
collide by construction the day it arrived. The thirteen table names and the four enum arrays are
in the second, and the arrays could not be prefixed anyway: they are public on the component subpath
too, where `signalsSignalStates` is indefensible.

**The table names stay unguarded by naming and get a guard instead.** Two components exporting one
table name would drop it from the barrel, so `push` would create twelve tables of thirteen and exit
0, and the component that queries the missing one fails at its first read. Nothing in the test
suite would notice, because `src/schemas.test.ts` reaches each module by file path and never builds
a barrel. `scripts/check-package.ts` is what notices: it imports all eight `/schema` specifiers
into one module scope out of the installed tarball, and every alias has been deleted, so a
duplicate name is `TS2300: Duplicate identifier` from the type checker and
`SyntaxError: Identifier 'x' has already been declared` from Node, each naming both import lines.
The guard is the absence of the aliases, which is a load-bearing absence: an alias added there to
work around some other clash removes the check for that name, and the file says so.

The argument this ADR won against ADR-0047 survives the reversal, which is why it is an amendment
and not a replacement. The complaint against the barrel was that it is *a second list of the
components a deployment runs, compared against the first by nothing*. It is not. It is the only
list: nothing else in a deployment names a `/schema` specifier, and `schemaFilter` is derived from
the barrel rather than written beside it. The other complaint, that a barrel's own first sentence
goes stale, is answered by the examples carrying no comments at all.

Three costs, recorded rather than mitigated. The barrel's `schema: "./schema.ts"` is glob'd against
the process cwd, where a resolved absolute path was cwd-independent; correct in the Compose one-shot
and loud from anywhere else, `No schema files found` and exit 1. The duplicate-identifier guard runs
in `npm run check:package`, which needs the network and is not the inner loop, so a ninth component
with a colliding table name passes `npm run check` and fails the step after it. And `schemaFilter`
is still five lines of `is` and `PgSchema` in a file with no comments to explain them: the
`::: danger Never remove schemaFilter` block in the guide is the only thing standing between a
reader's instinct and an empty database. Shipping a `schemaNames()` helper would make that
deletion impossible rather than merely documented, and was declined because ADR-0046 put the
Operator's migration machinery outside this package and one field of their config is where that
boundary starts moving.

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

**A third way was raised after this ADR shipped, and declined for a reason the other two do not
have.** Move each array into a module of its own that both `schema.ts` and `index.ts` import: the
`/schema` subpath keeps `export *` and loses nothing to a silent failure, the unions stay derived,
and the rule stops needing an exception. It costs three modules, and it costs the thing that put
these arrays in `schema.ts` to begin with. Each is read **twice in its own file and nowhere else in
it** — `signalStates` types the column with `$type<SignalState>()` on one line and is the argument
to `check("signals_state_known", stateIsKnown(table.state, signalStates))` twenty lines later, and
`runStates`, `messageDirections` and `scheduleKinds` are each the same pair. So the array, the
column it constrains and the constraint compiled from it are in one file, and the move separates
them to make one documentation sentence unqualified. The overlap costs a reader two doors to one
declaration, which cannot drift, because it is one declaration. That is the cheaper of the two.

## A config ran as CommonJS and resolved the specifiers with `createRequire`

**Superseded by the amendment above: a config names one relative path now and resolves nothing.**
The loading facts are still true of `drizzle.config.ts` and still worth having written down, since
a config that imports the barrel is still `require`d as CommonJS by `tsx`.


`drizzle-kit` reads `drizzle.config.ts` by registering `tsx` and calling `require()` on it, so the
file is transformed to CommonJS before it runs whatever the deployment's `package.json` says. Two
things an ES module has are therefore not available in it. Top-level `await` fails the transform,
with `Top-level await is currently not supported with the "cjs" output format`. And
`import.meta.resolve` is absent at run time, with `import_meta.resolve is not a function`.
`import.meta.url` does survive: `tsx` substitutes the real file URL.

So an example resolves the export map through a `require` built on that URL, and one handle answers
both halves of the config:

```ts
const requireFrom = createRequire(import.meta.url);

const specifiers = ["users", "password-auth", "messenger", "signals"].map(
  (component) => `shared-agent-framework/${component}/schema`,
);

const schema = specifiers.map((specifier) => requireFrom.resolve(specifier));
```

`requireFrom.resolve` answers the file path `schema` takes. `requireFrom(specifier)` loads the same
module synchronously, which is what lets `schemaFilter` be **derived** from the `PgSchema` objects
in it rather than listed beside the specifiers as a second list. That second call is `require()` of
an ES module, which Node does since 22.12 and refuses with `ERR_REQUIRE_ASYNC_MODULE` for a module
with a top-level `await` in it: a `/schema` subpath is a star of a `schema.ts` and has none, and
gaining one would break every config in the same loud way. Both failures above are loud, and
neither is what the derivation guards against: a config with no `schemaFilter` at all filters both
sides of the diff down to `public`, finds no difference, prints `No changes detected`, creates not
one table and exits 0 — the same ending as the `--force` below, reached another way.

The whole of this is a fact about how one tool loads one file. It was written here because the four
examples carry no code comments, and because the shape read like an old-fashioned spelling of
`import.meta.resolve` that somebody would helpfully modernise. That last worry is what the barrel
retired: `import * as schema from "./schema.ts"` is an ordinary import, and the guide's
`::: tip Why createRequire` block went with it. What survives is the reason `schemaFilter` is still
derived: a config with no `schemaFilter` at all filters both sides of the diff down to `public`,
finds no difference, prints `No changes detected`, creates not one table and exits 0.

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
  "shared-agent-framework/users/schema"`, and every deployment's `drizzle.config.ts` is rewritten.
  This package is at `0.2.0` and the four examples are the whole of the known consumer base, so the
  sweep is four directories. The amendment above rewrote all four a second time, back to a barrel,
  which is the cost of having got this half wrong once.
- **The import line stutters where it did not.** `shared-agent-framework/users/schema` says
  "schema" and then the module exports `usersSchema`. The amendment above put the prefix back, so
  the stutter is milder than this ADR first shipped it and the identifier carries a component name
  again.
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
