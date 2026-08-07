# The package root exports nothing

`package.json` `exports` has no `.` entry. The thirteen subpaths are `/gateway`, `/logging`,
`/db`, `/agent-container`, `/signals`, `/pi`, `/users`, `/messenger`, `/http-channel`,
`/nostr-channel`, `/signatures`, `/decisions` and `/scheduler`, and
`import … from "shared-agent-framework"` resolves to nothing. `src/index.ts` is deleted.

This amends the picture [ADR-0047](./0047-a-component-is-one-subpath.md) painted. That decision
gave every component one door and said nothing about what the root was then left holding. Four
new subpaths take that residue: `/gateway` the assembly, `/logging` the logging seam, `/db` the
PostgreSQL client, `/agent-container` the container plumbing. `templateHandler` joins `/signals`,
whose vocabulary it is written in. One name, `CursorWindow`, goes nowhere and is exported no more.

It also supersedes one sentence of ADR-0047: *"`src/container/` does not move. It stays at the
package root because a second Agent Implementation needs it unchanged."* The reason survives and
the placement does not. That directory is `src/agent-container/` now, and it is unchanged for the
second Agent Implementation on a specifier of its own.

## What the root had become

Six unrelated things, held together by one property: none of them is a component.

- the assembly, `createGateway` and `createBareGateway` and the types around them
- the Db client, `openDb` and its handle, transaction and listener types
- the Agent Container family, `createAgentContainerRuntime` and everything it takes
- the logging seam, `defaultLogger` and `Logger`
- `templateHandler`, a Signal Handler with no component of its own
- `CursorWindow`, a paging type two components read through

"Not a component" is a fact about how we build the framework. It is not a subject, and a specifier
named after the package is what a reader opens first. So the most prominent page in the reference
was a page about nothing, holding mostly what a Developer would never import first: a database
client, a mount table, a paging type and a logger, in an order no argument produced.

Each of the first four groups is a real thing, and each now has a name that says which thing it
is.

## `CursorWindow` is the proof

`Decisions.history` and `Messenger.history` both take a paging window. Neither component owns it,
so it was declared once in `src/route-conventions.ts`, aliased inside each of the two, and
exported from the root. Why it was exported at all is the part worth recording: the two
signatures named a type no specifier exported, and `check:docs` fails the build on a dangling
reference. The root was the cheapest place to point that reference at.

A name reaches the public API because a Developer needs to write it, or it does not reach it. This
one reached it to silence a documentation warning. Both methods spell the object inline now, and
the name is exported nowhere.

What that costs: the two spellings can drift apart and nothing will notice. Three optional
fields, written twice. We take that over a public name chosen by a doc check.

## Why nothing, rather than a smaller root

The obvious alternative keeps `createGateway` at the root, on the argument that a deployment
starts there, and moves everything else out. It loses to one asymmetry.

**Adding a root export later breaks nobody. Removing one breaks everybody.** We are not sure
which names deserve the root, and one of the two mistakes is cheap to undo. So the option-preserving
choice is to export nothing and let a later decision put the first name there, with an argument
attached to it.

## The four new specifiers

**`/gateway`** carries `createGateway`, `createBareGateway`, `serverComponent`, `Gateway`,
`Component`, `ListeningServer` and the option types. `src/gateway.ts` and `src/components.ts`
move into `src/gateway/`, so the specifier and the directory match the way a component's already
do.

**`/logging`** is its own subpath and not part of `/gateway`. Every component takes a `logger`
option and none of them is the Gateway, so a Developer reaching for the seam would be reading the
assembly's page to find it.

**`/db`** is `src/db/`, which never moved. Only the specifier is new.

**`/agent-container`** is named for what `CONTEXT.md` already calls that directory: the **Agent
Container** and the **Agent Container Runtime** are glossary terms, and the directory becomes
`src/agent-container/` so the term, the directory and the specifier are one word. `/runtime` was
the alternative and was rejected: `Runtime` is the Signal Worker's seam type, one method wide, and
a subpath of that name would read as the home of the type rather than of the thing that implements
it.

## What does not change

**ADR-0045's loading property.** It was stated as "the root imports no component", and a root that
imports nothing at all cannot break it. `/gateway` reaches the Db, the logging seam and the Signal
Worker, which are the three things `createGateway` builds, and reaches no component an Operator
constructs in `extend`. `/pi` is still the import edge nothing else pulls in.

**ADR-0047's rule and its shape.** A component is still one subpath, its tables still arrive on it
as flat named exports, and every schema object still carries its component's prefix. The four new
subpaths own no tables, so none of them enters an Operator's barrel.

## The costs, recorded

**`import … from "shared-agent-framework"` fails.** A package whose own name resolves to nothing is
unusual and will surprise somebody. What they see is a module-resolution error naming the
specifier, and it does not tell them to reach for a subpath. Nothing here mitigates that. The
export map is where the thirteen are written, and the API reference is where they are readable.

**Two words are defined nowhere now.** **Operator** and **Shared Agent** are used on every page of
the reference and are owned by no component. The root's module comment defined them, and it was
the only place in the rendered reference that did. `site/reference/index.md` is generated from the
entry point list, so nothing can be authored into it. The hole is deliberate rather than
overlooked, and handwritten documentation is what will close it. Until then a reader of the
reference alone meets both terms undefined; `CONTEXT.md` defines them and is not something a
Developer is handed.

## Considered and rejected

**A curated root: `createGateway` and nothing else.** The strongest alternative, and it reads well,
since one call is where a deployment starts. Rejected on the asymmetry above. It also would not have
answered where the Db client and the container plumbing go, so the other three specifiers arrive
either way and the only question is whether one name stays behind.

**A root that re-exports the thirteen.** Rejected twice over. ADR-0047 already rejected it, because
an ES re-export is eager and would load every component and the `pi` adapter on any root import.
It would also make every name reachable two ways, which is the split ADR-0047 closed.

**Keeping `CursorWindow`, on `/db` or on `/gateway`.** It is not a Db concept and not an assembly
one, so either home would have been picked to satisfy the doc check. That is the same reason it
was on the root, moved one subpath sideways.
