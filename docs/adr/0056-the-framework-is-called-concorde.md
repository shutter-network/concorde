# The framework is called Concorde

The project was `shared-agent-framework`, which was a description standing in for a name. It is
**Concorde**, and the name is on eight surfaces with eight different costs. This ADR is where the
rename is recorded, because the fifty-five ADRs before it are **not rewritten** and a reader of any
one of them meets the old spelling with nothing on the page to explain it.

```
npm package     shared-agent-framework       →  @shutter-network/concorde
GitHub          jannikluhn/shared-agent-…    →  shutter-network/concorde
version         0.3.1 published              →  0.1.0, unpublished
schemas         saf_users, saf_signals, …    →  concorde_users, concorde_signals, …  (8)
env vars        SAF_GATEWAY_URL, …           →  CONCORDE_GATEWAY_URL, …              (4)
JWS typ         saf-decision+jws, …          →  concorde-decision+jws, …
Token prefix    saf_…                        →  concorde_…
decoration      request.safUser              →  request.concordeUser
the term        Shared Agent                 →  shared agent
```

Three things are renamed and **not** on that list, because they are the same act: the four
examples' Compose project names and image tags, the Postgres role and database each example
creates, and the `/srv/concorde` runtime directory every docstring uses as its example. Each was
`saf` because the project was.

## The npm name is scoped, and not by preference

`concorde` on the public registry is a squatted `0.0.1-dev` placeholder. The alternatives were
`concorde-framework`, which spends a word to say what the `exports` map already says, and a scope.
The scope is what the project is moving to anyway: the repository goes to the `shutter-network`
GitHub organisation, and `@shutter-network/concorde` reads as the project's real name in every
import line rather than as a name that lost an argument with a squatter.

What it costs is one thing that is easy to miss and fails in silence. **A scoped package defaults
to `restricted`**, so the first `npm publish` would go private, exit 0, and leave `npm install` in
all four examples failing with a 404 that reads as a registry problem. `publishConfig.access` is
`public` in the manifest for that reason, which keeps `npm version patch && npm publish && git push
--follow-tags` the constant it has been rather than a sequence with a flag somebody has to remember
on the one release where forgetting it matters.

## The version restarts, and the old name is left alone

`0.1.0`, not `0.4.0`. A version number is a promise about one name, and `@shutter-network/concorde`
has made none: continuing at `0.4.0` would announce three releases that nobody can install under
that name. The cost is that the four versions on the registry as `shared-agent-framework`, `0.1.0`
through `0.3.1`, are not ordered against anything here, and `0.1.0` now names two different
artifacts.

Those four stay **undeprecated, with nothing pointing at the new name**. A deprecation notice is a
message printed at install time, and the message it would carry today names a package that does not
exist on the registry, which is worse than silence. Whoever installed the old name is on a version
that works and is not made worse by being left there.

## `concorde_` costs a migration nobody has to run

Eight PostgreSQL schemas and thirteen tables carry the prefix. Renaming it is a break with **no
migration path shipped**, and this repository ships no DDL at all
([ADR-0046](./0046-the-operator-owns-migrations.md)), so a deployment on the old schemas would owe
itself eight `ALTER SCHEMA` statements that it gets from nowhere.

It is taken anyway, and it is free, because **there are no deployments**. That is the whole of the
argument, and it is the kind of argument that expires: at `1.0.0` the same rename would be a
migration document and a major version. Taken now, `saf_` never becomes a prefix in the reference's
table pages that no page can explain.

## `concorde-decision+jws` is the one rename that is not reversible

The `typ` sits in the protected header of a compact JWS, covered by the signature
([ADR-0042](./0042-a-signature-is-a-compact-jws.md)). An artifact signed under the old label carries
it for as long as the artifact exists, and no rename here reaches it, so in principle a verifier
meets both spellings forever.

In practice it meets one, for the same reason `concorde_` is free. It goes in the **same break** as
the schemas rather than in a second one later, which is the whole reason to do it now: two breaking
renames of a wire label is one more than a verifier should ever see, and ADR-0042 already says the
label is the agent's own claim rather than anything this framework reserves. The default the
framework ships is genuinely just a default.

**The Token prefix is the other wire value and is the one that costs nothing.** A minted Token
reads `concorde_…` where it read `saf_…`, for the reason the prefix exists at all: a leaked Token
should be recognisable as this framework's in a log or a scanner's output, and it cannot be that
under an acronym of a name the project no longer has. It is free because **nothing ever parses
it**. `hashToken` hashes the whole string, prefix included, and verification is a lookup on that
hash, so a Token minted under the old prefix keeps verifying with no migration and no branch. The
prefix is written on mint and read by humans only.

## The term survives and the capitals do not

A **shared agent** is still what this framework builds. What it is no longer is the project's name,
so it stops being a proper noun: `Shared Agent` in a hundred and eighteen places is `shared agent`,
and `Shared Agent Framework` is `Concorde`.

This is the one rename with a cost that is not paid off. `CONTEXT.md` is a glossary where a
capitalised word in running prose is the signal that a term is defined: Party, Operator, Gateway,
Component, Signal, Run, Session, Workspace. `shared agent` is now the **only lowercase entry in
it**, and in the prose of every document it reads as an ordinary noun phrase while every term
around it reads as a definition. That is accepted rather than answered: the alternative is a
project named Concorde whose central concept is still capitalised after the thing it was named for,
which reads as a rename that was not finished.

## The fifty-five ADRs before this one are not rewritten

Not their bodies, not the two filenames that carry the old spelling
([ADR-0041](./0041-the-shared-agent-has-a-signing-identity.md),
[ADR-0050](./0050-the-shared-agent-has-a-nostr-identity-too.md)). An ADR is a dated record of a
decision made under the conditions of its day, and sweeping a name through fifty-five of them
produces a set of documents that claim to have been written about a project that did not have that
name yet.

What it costs is that every specifier, schema name and `typ` quoted in an ADR before this one is
spelled the old way and is not marked as stale on the page. This document is the only thing
standing between that reader and the current spelling, which is why the table at the top is a table
rather than a sentence.

## Considered and rejected

- **`concorde-framework` on the registry.** Free, unscoped, and one word longer than the project's
  name for no reason once the GitHub organisation was decided. A scope also leaves room for a second
  package, which the terminal client is already a candidate for: it is a `bin` today with a
  zero-dependency rule holding it there, and `@shutter-network/concorde-tui` is what that rule
  points at.
- **Deprecating `shared-agent-framework` with a pointer.** Rejected while the new name is
  unpublished. Worth revisiting the day `@shutter-network/concorde@0.1.0` is on the registry, at
  which point the notice would name something a reader can install.
- **Leaving `saf_` on the schemas.** It is the cheapest option today and the most expensive one at
  any later date, and it leaves an acronym in the generated table pages that no page defines.
- **Keeping `Shared Agent` capitalised as a glossary term.** It keeps the glossary's one convention
  intact and is the better-looking option in `CONTEXT.md` alone. It loses everywhere else: the
  capitals were the project's name, and a term capitalised after its project was renamed is a
  leftover rather than a definition.
