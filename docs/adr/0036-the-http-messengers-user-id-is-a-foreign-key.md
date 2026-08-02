# The HTTP Messenger's `user_id` is a foreign key

`messages.user_id` references `saf_users.users.id`, across schemas and across parts. This is
the one exception to [ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md)'s flat
rule that no table references another part's, which `data-model.md` recorded as settled:
"Not a foreign key: Users are the User Directory's, and no part references another's tables.
Nothing therefore enforces that this names a real User, which is safe only because nothing
removes one."

The constraint is also the **only** enforcement. The insert runs, PostgreSQL raises `23503`,
and the route answers 404. There is no lookup in front of it. A check in front of a
constraint is two mechanisms for one rule: the check can be forgotten while the constraint
holds, it can pass and then lose a race the constraint would still catch, and it makes the
404 come from a read rather than from the write that actually failed. One mechanism, at the
place the rule lives.

## What it buys, which is one thing

The agent's send names a User by id, from whatever it worked out during a Run. Nothing else
in the framework lets untrusted arithmetic pick a row's identity: a User's own post is
attributed from their Token, and every other id in the model is one the Gateway issued and
handed straight back. So the failure this guards against is specific: **an agent copying an
id wrong**, from a prior Message, from Attributes, or from a hallucinated string of the
right shape.

Without the constraint that write succeeds. It stores a Message addressed to nobody, which
nobody will ever read, and the Run that made it finishes reporting success. A failed Run is
never retried ([ADR-0017](./0017-failed-runs-are-not-retried.md)), so a silently misaddressed
Message is permanent and invisible. With the constraint the agent gets a 404 inside the Run,
while it still has the context to notice and correct, which is exactly the moment when a
mistake is cheap.

## The four costs

None of these is mitigated. Each is recorded so that the next reader knows they were bought
deliberately.

**1. `drizzle-kit` cannot generate it.** A part's config points at one schema file, and a
schema file importing `../users/schema.ts` makes the generator emit `CREATE TABLE
saf_users.users` into *this* part's migration folder, which would have this part creating the
User Directory's table. So the constraint is added by hand to the generated migration and
the snapshot is hand-edited to match, on **every** regeneration. `CLAUDE.md` already
documents one such hand-edit, the `CREATE SCHEMA` line that must be removed; this is a
second, and unlike the first it is an *addition*, so a forgotten one leaves a silently
unenforced constraint rather than a loud failure. It is pinned by a test that scans the
shipped folder, the way the first one is.

**2. Construction order becomes load-bearing at `migrate`.** `db.migrate()` applies
descriptors in registration order, which is construction order
([ADR-0032](./0032-components-wire-themselves-at-construction.md)), so the User Directory
must be constructed before the HTTP Messenger. Nothing checks this. The failure is
PostgreSQL's `relation "saf_users.users" does not exist`, which names the missing thing
plainly enough to leave alone, and it is documented in the part's own header and in the
quickstart. Before this ADR, construction order in an entry point was pure narrative.

**3. This part requires *our* User Directory**, at the schema level rather than the type
level. `architecture.md`'s "replaceable by construction: don't build ours, build yours" no
longer composes freely for a deployment using this Messenger: a replacement User Directory
must own `saf_users.users` with the same primary key, or this part will not migrate. The
constructor names the User Directory's own type nominally for this reason, so the dependency
is visible where the call is written rather than at `migrate`.

**4. It can never catch anything else.** The constraint **never fires a cascade**, because
nothing removes a User ([ADR-0029](./0029-users-are-a-part-of-their-own.md)): `on delete` has
no behaviour worth choosing and the referenced row is immortal by construction. Nor does it
guard a User's own post, which is attributed from a Token rather than from a body. So the
three costs above are paid for exactly one check, at one call site, against one mistake: an
agent copying an id wrong. That is the trade, stated as a ratio rather than implied.

Underneath all four sits the thing ADR-0022's rule was protecting. Per-part schemas exist so
that parts migrate independently, and a cross-schema reference couples two folders' histories.
This one couples them in **one direction only**, and along one edge: the HTTP Messenger knows
about Users, and the User Directory knows nothing about Messages. That asymmetry is the whole
of what makes the exception affordable, and it is the property to check before anyone proposes
a second one.

## Considered and rejected

**Leaving it unenforced, as the model already said.** Rejected because the argument for it
was never that the write is harmless, only that nothing removes a User so a dangling
reference cannot appear *later*. That answers deletion and says nothing about a bad id at
insert time, which is the case that actually occurs, and the one the agent is in a position
to cause.

**An application lookup, with or without the constraint.** Rejected as the primary
mechanism. With the constraint it is a second mechanism for one rule. Without it, the check
is a read that a concurrent write could invalidate, and the code has to be right about
performing it on both write paths forever.

**A `check` or a soft reference, validated by a query.** Rejected: it is the application
lookup with more machinery, and it still cannot be enforced by the database.

## Consequences

- **A well-formed uuid naming no User is a 404 on the agent's send, and no row is written.**
  That is the constraint doing its job, and it is the test that proves the hand-edited
  migration shipped.
- **A malformed uuid is a 400, not a 500**, because the id is pattern-validated by the shared
  `idSchema` before PostgreSQL is asked to cast it.
- **A 404 from a write is now an idiom in this repository.** The status describes the
  referenced User, not the route, and it arrives from a caught error class rather than from a
  branch.
- **The exception is this part's alone.** The rule in `data-model.md` stays a rule and gains
  one named exception; a second one is an ADR of its own.
