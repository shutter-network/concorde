# A component is one subpath

Everything a component offers arrives on one subpath: its constructor, its types, and its
tables. The five `/schema` subpaths retire into the component subpaths they belonged to, the
Signal Worker gains `./signals` of its own, and `"./messenger": null` retires with them. The
package has eight entry points, and each one is a thing a Developer can name.

This supersedes one sentence of
[ADR-0046](./0046-the-operator-owns-migrations.md) and none of its mechanism. That ADR put the
tables on a subpath *"named `/schema` so the encapsulation-softening sits behind one labelled
door rather than blurring into each part's main API."* The door stays open, and it is now the
component's own front door.

## Why one door per component

A component was reachable through two specifiers, and which one held a given export was not
derivable from anything. `createUsers` came from `shared-agent-framework/users`, `users` the
table from `shared-agent-framework/users/schema`, and the split was a fact to memorise. The
Signal Worker had it worse: `createSignalWorker` at the root, its tables on
`./signals/schema`, and no subpath of its own between them.

Three things follow from closing that.

- **The import site says which component it is.** One line names the component and everything
  taken from it, so a reader of an Operator's entry point can see which parts a deployment runs
  by reading its imports.
- **The reference documents components, not files.** The generated API reference takes one entry
  point per subpath, so eight subpaths produce eight pages, each a component. Twelve subpaths
  produced twelve, five of which were table listings with no constructor on them.
- **The Signal Worker stops being an exception.** It is irreducible infrastructure that
  `createGateway` builds ([ADR-0045](./0045-the-framework-builds-only-the-irreducible-infrastructure.md)),
  which is why its constructor sat at the root. But it owns tables like any other component, and
  a component that owns tables has a subpath. `Signal`, `SignalHandler`, `Prompt`, `RunRecord`
  and `Runtime` move with it, because they are the vocabulary of the thing that owns them.

`src/container/` does not move. It stays at the package root because a second Agent
Implementation needs it unchanged ([ADR-0033](./0033-an-agent-is-a-container-and-one-function.md)),
and it owns no tables.

## The names keep their prefixes, and that is load-bearing

`shared-agent-framework/users` exports `usersSchema`, `usersTables`, `users` and `tokens`, not
`schema`, `tables`, `users` and `tokens`. The redundancy is deliberate, and removing it would
break an Operator's database in silence.

An Operator assembles a barrel of the parts they run (ADR-0046) and `drizzle-kit` reads it:

```ts
export * from "shared-agent-framework/users";
export * from "shared-agent-framework/http-messenger";
export * from "shared-agent-framework/decisions";
```

**`export *` excludes ambiguous names.** If every component exported `schema`, those three lines
would produce a module with no `schema` at all, because the name resolves to three different
bindings and ES modules drop it rather than choose. Nothing warns. `drizzle-kit` then collects
`Object.values` of the barrel and finds no `PgSchema` among them, so the `schemaFilter` an
Operator derives from it is empty, so `push` compares nothing against nothing, prints
`No changes detected`, creates not one table, and exits 0. The Gateway starts on the strength of
that success and dies on its first query.

That failure is the same one ADR-0046 recorded for wrapper objects, reached by a different
route. Its answer was flat named exports; the answer here is names distinct across components,
which is what a prefix buys. A short name would need an aliased re-export in every barrel and a
check to prove the aliases are there, which is machinery bought to make an import line read
better.

## What does not change

**ADR-0045's loading property survives.** The subpaths stay separate modules, so constructing
none of the opinionated components still loads none of them. The root imports no component, and
`./pi` stays the import edge nothing at the root reaches for. A single root barrel re-exporting
everything was considered for exactly one reason, that it would give the reference one entry
point, and rejected: an ES re-export is eager, so it would load every component and the `pi`
adapter on any root import.

**ADR-0046's flat-export shape survives.** The tables are top-level named exports on the
component subpath, which is the shape `drizzle-kit` reads.

## The cost, recorded

**`drizzle-kit` now loads each component's runtime module.** It collected tables from a schema
module holding table definitions and nothing else; it now collects them from the component's
`index.ts`, which reaches its constructor, its routes and its secrets handling. Nothing there
has module-level side effects and the route modules name Fastify's types without importing its
runtime, so the collection is expected to be identical, and it is proven by generating against
the new barrel and comparing the SQL rather than by this paragraph.

**An import line repeats the component's name.** `import { createUsers, usersSchema } from
"shared-agent-framework/users"` says "users" twice. This is the price of a name that stays
distinct through `export *`, paid at a handful of import sites in one barrel file.

## Considered and rejected

**Short names inside each component, disambiguated in the barrel.** `schema` and `tables`, with
`export { schema as usersSchema }` beside each star and a packaging check asserting the barrel
yields one `PgSchema` per component. Rejected: it adds a line per component and a check per
repository to buy a shorter identifier, and the failure it guards is the silent empty push
above. A prefix guards it by construction.

**One root entry point, every component re-exported.** Rejected on ADR-0045: the loading
property is real and an eager re-export ends it.

**Keeping the `/schema` subpaths as ADR-0046 left them.** The status quo, and the honest
argument for it is that a labelled door is easy to explain. Rejected because the label named a
file layout rather than anything a Developer reasons about, and because the door it labelled
belongs to a component that already has one.
