# Writing the API reference

This governs the doc comments in `src` that TypeDoc renders into `site/reference`, and the
route `description` strings that Fastify renders into the OpenAPI document. Both are read by an
Operator. Runtime strings, meaning a thrown `Error` message or a stored failure reason, are not
covered here beyond the prohibition in [Never in a rendered
comment](#never-in-a-rendered-comment).

Prose style is `/simple-english`. This file is about content and organization: which fact goes
in which comment.

## The reader is the Operator

Every rendered comment is written for the person consuming the API. Not for the maintainer, and
not for a reviewer. The maintainer's reader is the file header and the inline comment, neither
of which TypeDoc renders.

That split is the reason a component has two module-level comments. The one in `index.ts`
carries the `@module` tag and is the page. The one at the top of the implementation file is for
whoever edits that file. Nothing belongs in both.

## Three tests every rendered sentence passes

A sentence stays only if all three hold.

1. **It is true of this symbol and not of every symbol like it.** "Only trusted code holds the
   instance" is true of every component, so it says nothing about this one.
2. **A reader can act on it.** It changes what they write, what they expect, or what they will
   debug. This is the test that removes a sentence with clean grammar and no fact in it.
3. **The signature does not already say it.** The signature is part of the documentation and
   renders directly above the prose. No "Required", no "Optional", no "Asynchronous because the
   library is", no `@returns` that restates `Promise<string>`.

## Sometimes the answer is no comment

The three tests take sentences out. On a small symbol they take all of them, and what is left is
not a short comment but none. Delete it.

An alias, a record of three named fields, a function the signature already describes: the heading
and the types render either way, and they were the documentation. Prose on top of them says the
name a second time. `Handle` is a handle to these tables. `ListeningServer` is a server that
listens. A reader who reads that sentence has paid for it and holds what they held before.

This is not a licence to leave the hard symbols bare. A component, its constructor, its options
and its methods carry facts no signature holds, and the three tests never empty those. It applies
where the type is the whole fact.

## One fact, one home

| Where | Renders | Holds |
| --- | --- | --- |
| `docs/adr/` | no | the decision, its alternatives, and the argument |
| `index.ts` `@module` | **yes** | orientation: what the subpath is, what is in it, and the relationships nothing else can state |
| implementation file header | no | what a maintainer must not undo, and why the code has this shape |
| symbol doc comment | **yes** | that symbol, at its own altitude |
| inline `//` | no | why this line, this index, this ordering |

A fact appears at one altitude only. The module comment links to the constructor with
`{@link createUsers}` instead of listing its options, because the options have their own home.

Some repetition between a summary and the detail below it is normal and is not what this rule
prohibits. What it prohibits is one fact maintained in two places that are edited separately.

## The first sentence

It is what a reader takes the symbol from on a skim. Make it stand alone, make it short, and do
not repeat the name of the symbol in it.

TypeDoc in this repository renders the whole comment in place and extracts no summary index, so
this is a readability rule and not a mechanical one. It still applies. A comment whose first
sentence is `Sets the tool tip text.` on `setToolTipText` has told the reader nothing they did
not read in the signature.

Use the third person and omit the subject. Write `Signs the claims and answers with one compact
JWS.` Do not write `This method signs the claims.` and do not write the imperative `Sign the
claims.`

This one rule is the doc comments' alone. An OpenAPI `description` renders in Swagger UI with no
symbol beside it, and it addresses a caller rather than describing a symbol, so the second person
belongs there: "the `typ` is yours, and nothing is reserved". Everything else in this guide holds
for both.

## The module comment

It orients, and it does not explain. The substance belongs on the exported symbols, which
TypeDoc prints on the same page under their own headings. A module comment that describes them
again is one fact maintained in two places.

Three jobs, and nothing else.

1. **What this subpath is.** A sentence or two. Define any domain term it owns that no exported
   type carries, because there is no glossary and `CONTEXT.md` is not published. Name a component
   as "the Users component".
2. **What is in here, and which one you start from.** The core type and the entry function, with
   `{@link}`s. Not every export: the page lists those below. Neutral in tone, and not in emphasis.
   Naming the export a reader starts from is a judgment, and it is the most useful thing on the
   page. A comment that lists six exports evenly has made the reader rank them with less
   information than the author had.
3. **The relationships nothing else can state.** What this must be built before or after, and
   what is deliberately absent and where it lives instead. No single symbol owns a relationship,
   so this is the only content with no lower home. State a construction order only where getting
   it wrong costs something real.

Then one `@example`. It stays here rather than on the constructor because it is the fastest
orientation on the page, and because it shows exports working together, which is job 3 written in
code.

```ts
/**
 * Users, the component that holds the identities a Gateway authenticates. A User is an opaque id,
 * a set of Attributes that the Operator writes, and a set of Tokens.
 *
 * {@link createUsers} makes one. {@link Users} is what comes back, and it carries the methods and
 * the `requireUser` hook that the rest of a deployment reaches for. Other components take that
 * hook, so build this one before them.
 *
 * The subpath also exports the `users` and `tokens` tables, for the barrel an Operator's
 * `drizzle-kit` reads, and importing it declares `request.safUser` on every `FastifyRequest` in
 * the program.
 *
 * @example ...
 * @module
 */
```

The shape fits a subpath that is not a component without a special case. The root carries what
belongs to no component, so job 2 is most of it, and a bulleted overview naming what each part is
for is job 2 done well. `/pi` is one function an Operator calls, so job 3 carries the weight:
what is deliberately absent, and where it lives instead.

## The other altitudes

**The constructor.** One sentence on what it builds and registers. A `@throws` for each distinct
refusal at construction. No example, and nothing about the options.

**The type a constructor answers with.** `Users`, `Signatures`, `Db`. This is where the substance
the module comment does not carry lands: what the component stores, what it issues, what it
derives, and what survives a shutdown. Internals go in only where a caller can observe them. That
a Token row carries an expiry the database clock reads is in. Which index serves the lookup is
not.

**An options property.** What the value means and what it changes about behavior. The values the
type cannot express, such as a range, a unit, or a set of allowed strings. The default, and what
changing it costs. Never "Required" or "Optional".

**A method.** The first sentence says what it does and what comes back. Then what it refuses,
and when: at construction, at the first call, or per request. Then what it does *not* do that a
caller will assume it does. That last part is usually the most valuable sentence in the comment.
`setPassword` revokes nothing. `revoke` removes no User. A `read` cannot see the caller's own
uncommitted write.

**Anything else.** An exported type, a record shape, a plugin. Same three tests. Say what it
represents, not that it is a type.

## The implementation file header

The block at the top of `users.ts`, which TypeDoc never renders. Every sentence the three tests
reject goes here, so it carries real traffic and is not a leftover.

It holds what a maintainer must not undo, and why the code has this shape: an alternative that
was weighed and lost, a library that owns a behavior we deliberately do not reimplement, an
ordering that is load-bearing. Where such a fact has an observable consequence, the consequence
goes in the rendered comment and the reason stays here. `jose` checks key and algorithm
compatibility asynchronously, so a wrong algorithm is refused at the first signing rather than at
construction. The timing of that refusal is rendered. "Do not write a second compatibility check"
is not.

It is not a second module comment. Nothing that passes the three tests belongs here, and nothing
here is repeated in `index.ts`.

## Tags

- `@module` on `index.ts` only, and once per subpath.
- `@example` once per subpath, on the module comment. Delete it from constructors. Examples here
  are not compiled, so every one of them is prose that can rot in silence. One is a cost worth
  paying and five are not.
- `@throws` once per distinct cause.
- `@param` and `@returns` only when they carry a fact the signature does not. Prefer a sentence
  in the prose that names the parameter. A `@returns` that restates the return type is noise.
- `{@link}` on the first occurrence of a symbol a reader will want to jump to, and not on every
  occurrence. TypeDoc fails the build on a link it cannot resolve, which is what keeps these
  honest.

## Never in a rendered comment

- **A citation of an ADR, of `CONTEXT.md`, or of any file outside `site/reference`.** The site
  publishes the reference and nothing else, and the repository is private, so a reader cannot
  follow the link. Nothing in the build checks a relative markdown path or a bare `(ADR-0047)`,
  so these decay in silence. An ADR also carries a status and can be superseded, and a reference
  page describes current state. This holds for the OpenAPI `description` strings too, and for a
  thrown `Error`, where the citation reaches somebody who already has a problem.
- **A sentence true of every component, or of every piece of code.**
- **A non-interaction.** "It knows nothing about the Signal Worker" describes nothing.
- **A named consumer.** Describe the API and its purpose, not who calls it.
- **Why an alternative was rejected, or what must not be reintroduced.** That is the file header.
- **An internal name.** A private helper, an index, a column, a SQL construct.
- **A phrasing more elaborate than the path the reader is on.** "Add it to the Gateway", not
  "keep it in the Gateway record under a key of your own".

## What these rules cost

Recorded rather than solved.

- **The reference cannot point a reader at the argument.** Diátaxis prescribes a link out to
  explanation rather than silence, and there is nowhere to link: `docs/` is not published. So a
  reader who wants to know why a key is a `KeyObject` has no route to the answer.
- **Two terms have no owning component.** Operator and Shared Agent are used throughout and
  belong to no subpath, so the root module comment is the only place they can be defined. Every
  other domain term is either an exported type or owned by one component.
- **A bare symbol and a forgotten symbol look the same.** The page renders a heading and a
  signature in both cases, so a reader cannot tell that somebody decided there was nothing to say.
  We take that, because a comment written to fill the space is paid for by every reader, and the
  blank is paid for by the one who wondered.
- **Nothing checks any of this.** `check:docs` catches a stale page and an unresolvable
  `{@link}`. It does not read prose. The one rule a machine could see is the ADR citation, and
  no check for it exists yet.

## Where these rules come from

The sources are Diátaxis on reference and explanation, Oracle's *How to Write Doc Comments for
the Javadoc Tool*, Go's *Go Doc Comments*, the Rust API Guidelines documentation chapter, the
rustdoc book, Google's API reference comment guidance and AIP-192, the Microsoft Writing Style
Guide on reference documentation, and TSDoc. They agree on more than they disagree: document
every public symbol, make the first sentence stand alone, never restate the name or the type,
and state what the type cannot say.

The first of those four is the one place this guide breaks with all of them at once. They ask for
a comment on every public symbol; [Sometimes the answer is no
comment](#sometimes-the-answer-is-no-comment) does not. Javadoc and rustdoc are the reason they
can: both generate a summary index, where a blank cell is a visible hole in a table of names.
TypeDoc renders in place here and extracts no index, so a symbol with no comment costs a reader
nothing they can see.

They disagree in five places, and this guide takes a side in each.

1. **Mood.** Javadoc requires the third person and the omitted subject. PEP 257 requires the
   imperative. Go requires the symbol as an explicit subject, for grep and for a detached
   summary. We take Javadoc's, because TypeDoc renders the comment beside the symbol and the
   subject is never lost.
2. **`@param` and `@returns`.** Javadoc mandates them even when redundant with the prose. Go
   abolishes them and names parameters in the sentence that describes the operation. We take
   Go's, because the signature renders directly above the comment and a TypeScript type says
   more than a Java one.
3. **Rationale in a method comment.** Google tells you to explain why and how to use the method
   there. Diátaxis says justification belongs in a different document. We split the word: *why
   you would reach for this* is in, and *why it was built this way* is out. That line is also
   what the Rust guidelines say an example is for.
4. **Examples.** Rust requires one on every public item, which is affordable because doctests
   compile them. TypeScript has no doctest here, so we take Google's shape instead: one example,
   at the top level, and none below it.
5. **Whether a module comment lists its exports.** PEP 257 requires an enumeration. Go and Rust
   ask for orientation and leave the index to the generator. We take Go's, which is not the same
   as listing nothing. Go asks a package comment for "a brief overview of the most important
   parts of the API", so a curated overview naming what each part is for is in, and a mechanical
   inventory of every export is out. TypeDoc prints the inventory below it anyway.
