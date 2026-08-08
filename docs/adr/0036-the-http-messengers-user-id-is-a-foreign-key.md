# The HTTP Messenger's `user_id` is a foreign key

> **The foreign key stands; two of the four costs of having it are retired by
> [ADR-0046](./0046-the-operator-owns-migrations.md).** The constraint, the `23503` caught,
> the 404 with no lookup in front of it, and the one-directional coupling that makes the
> exception affordable are all exactly as decided below.
>
> What changed is that the framework no longer generates or applies any migration, so
> there is one schema graph rather than one per part. **Cost 1 is gone whole**: the import
> of `../users/schema.ts` that this ADR had to forbid is now precisely the mechanism —
> `src/http-messenger/schema.ts` declares the reference in code, `drizzle-kit` generates
> the constraint, and there is no hand-edit, no snapshot to match by hand, and no folder
> for a test to scan. **Cost 2 is gone as stated**: there are no descriptors and no
> registration order, and `drizzle-kit` orders the statements within the single
> generation, so construction order is no longer load-bearing at `migrate`. It survives
> one layer up and with a different failure — an Operator's barrel carrying this part
> without the User Manager generates a reference to a table it never creates, and dies on
> the same `schema "saf_users" does not exist`. **Cost 3 is untouched**, only relocated:
> a replacement User Manager must still own `saf_users.users` with the same primary key,
> and the dependency now surfaces at generation rather than at `migrate`. **Cost 4 is
> untouched**, and the ratio it states improves, since the price is now three costs rather
> than four.

`messages.user_id` references `saf_users.users.id`, across schemas and across parts. This is
the one exception to [ADR-0022](./0022-the-store-is-postgresql-through-drizzle.md)'s flat
rule that no table references another part's, which `data-model.md` recorded as settled:
"Not a foreign key: Users are the User Directory's, and no part references another's tables.
Nothing therefore enforces that this names a real User, which is safe only because nothing
removes one." (Quoted as written; the User Directory is now the **User Manager**
([ADR-0029](./0029-users-are-a-part-of-their-own.md)).)

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
User Manager's table. So the constraint is added by hand to the generated migration and
the snapshot is hand-edited to match, on **every** regeneration. `CLAUDE.md` already
documents one such hand-edit, the `CREATE SCHEMA` line that must be removed; this is a
second, and unlike the first it is an *addition*, so a forgotten one leaves a silently
unenforced constraint rather than a loud failure. It is pinned by a test that scans the
shipped folder, the way the first one is.

**2. Construction order becomes load-bearing at `migrate`.** `db.migrate()` applies
descriptors in registration order, which is construction order
([ADR-0032](./0032-components-wire-themselves-at-construction.md)), so the User Manager
must be constructed before the HTTP Messenger. Nothing checks this. The failure is
PostgreSQL's `schema "saf_users" does not exist`, because `db.migrate` creates each
descriptor's schema immediately before applying that descriptor's folder, so a User Manager
that has not been reached yet has no schema either. `relation "saf_users.users" does not
exist` is the same mistake against a database where that schema is already there and its
table is not. Either message names the missing thing plainly enough to leave alone, and
both are recorded in the part's own header. Before this ADR,
construction order in an entry point was pure narrative.

**3. This part requires *our* User Manager**, at the schema level rather than the type
level. `architecture.md`'s "replaceable by construction: don't build ours, build yours" no
longer composes freely for a deployment using this Messenger: a replacement User Manager
must own `saf_users.users` with the same primary key, or this part will not migrate. The
constructor names the User Manager's own type nominally for this reason, so the dependency
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
about Users, and the User Manager knows nothing about Messages. That asymmetry is the whole
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
