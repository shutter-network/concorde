# Components are named for what they own

**Signatures** and **Decisions**, not *Signer* and *Decision Log*. A Component that exists to
own a subject is named for the subject, in the plural, and the framework's other Components
follow as they are renamed.

This is recorded rather than just done, because a reader meeting `Signatures` beside `Signal
Worker` and `HTTP Messenger` will read it as an inconsistency, and because `CONTEXT.md` said
the opposite about the last name that went this way:

> **"Manager" is the vaguest word in this glossary, and it was taken knowing that**: the other
> entries name what a thing is or does (a Signal Worker works Signals, a Mount Table is a table
> of mounts) where "manager" names a department, so this is the exception and not a precedent
> for the next entry.

## Why the plural subject wins

The `-er` names read as the established pattern — Worker, Manager, Messenger, Scheduler,
Producer — and `Signer` sits among them without explanation. Three arguments against it anyway:

- **The code already says it.** `CONTEXT.md` records that when the User Directory became the
  User Manager, *"no public name moved with it: `createUsers`, the `Users` type,
  `usersMigrations`, the `saf_users` schema and the `shared-agent-framework/users` subpath are
  untouched."* Every identifier a consumer touches has said `Users` all along; only the prose
  says User Manager. The rename makes the prose match the code and deletes the apology above.
- **A plural subject is not the department name the apology was about.** "User Manager" *is* the
  department; `Users` is the subject matter the Component owns. Different failure, and this one
  is the fix.
- **For this Component it covers the whole surface.** `POST /sign` makes a signature,
  `POST /verify` checks one, `GET /jwks.json` serves the means to check one — all three are about
  signatures, where `Signer` covers one of three and says nothing about the other two. The
  Component also stores nothing, so signing capability really is all it owns: not Statements,
  not Decisions.

The argument that `Signatures` misnames the artifact — the Component hands back a *Signed
Statement*, of which the signature is one of three segments — was considered and does not carry.
The `jws` column lives on a Decision, in another Component, and is named for holding a whole JWS.
Two Components using two accurate words is not an inconsistency.

## Where the scheme stops

**Name a Component for what it owns, unless its behaviour is what the reader needs.** The
**Signal Worker** does not become `Signals`: one Signal at a time, globally, is the fact a reader
must carry, and `Signals` would both lose it and collide with the Signal entity outright. The
**HTTP Messenger** keeps its qualifier, which carries ADR-0034's four declined freedoms.

## Consequences

- **`Signatures` and `Decisions` ship under these names.** Keys `signatures` and `decisions`,
  subpaths `./signatures` and `./decisions`, constructors `createSignatures` and
  `createDecisions`, types `Signatures` and `Decisions` — on `createUsers`' precedent.
- **The User Manager becomes `Users` in the prose, as separate later work.** No public name
  changes, because none of them ever said "Manager". Until then the documents say User Manager
  and mean the thing this ADR will call `Users`.
- **`Decision Log` is not a term.** The Component is `Decisions` and it holds Decisions; unlike
  the Message log there is nothing distinct from the Component needing its own word
  ([ADR-0043](./0043-decisions-are-one-global-log.md)).
- **Prose gets worse for a Component that acts.** "The Signer verifies a signature" is smooth;
  "Signatures verifies a signature" is not. Every document pays this a few times, and the
  mitigation is writing "the Signatures component" or naming the route instead. `Users` has the
  same shape and the codebase already tolerates it.
