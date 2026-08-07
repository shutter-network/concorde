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

## One fact, one home

| Where | Renders | Holds |
| --- | --- | --- |
| `docs/adr/` | no | the decision, its alternatives, and the argument |
| `index.ts` `@module` | **yes** | the component: purpose, internals, construction, surface, lifecycle |
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

## A component's module comment

Seven slots, in this order. Skip a slot that is empty. Signatures stores nothing, so it has no
slot 2.

1. **Purpose.** What the component holds or does. Name it "the Users component". Define the
   domain terms it owns, because there is no glossary and `CONTEXT.md` is not published.
2. **Internals, where a caller can observe them.** What it stores, what it issues, what it
   derives. The test is whether the fact changes what a reader expects, not whether it is
   interesting. That a Token row carries an expiry the database clock reads is in. Which index
   serves the lookup is not.
3. **Construction.** `Use {@link createUsers} to make an instance, and add it to the Gateway.`
   Nothing about the options. Add the ordering constraint only where getting it wrong costs
   something real: `Other components take this instance as a constructor option, so make it
   before them.`
4. **What it adds, and what for.** Endpoints per server, tables, timers. Also what the import
   itself adds to the Operator's program, which is where the exported tables for their
   `drizzle-kit` barrel go, and where a type declaration like `request.safUser` goes. Every
   clause carries its purpose. Not "registers `/auth`", but "adds endpoints to the Public
   server, so that a User trades a password for a Token".
5. **The API, and what each part is for.** What the instance carries that a caller reaches for.
   Never the components that consume it: describe the surface, not somebody else's code.
6. **Lifecycle.** What the constructor does, and what `start` and `stop` do.
7. **What survives the lifecycle.** A Token outlives a shutdown. This gets its own paragraph
   and is never a clause inside slot 6.

One `@example` per subpath, at the end of the module comment. It is the only example on the
page.

## The other altitudes

**The constructor.** One sentence on what it builds and registers. A `@throws` for each distinct
refusal at construction. No example, and nothing about the options.

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
   ask for orientation and leave the index to the generator. We take Go's, because TypeDoc
   already prints every export on the page.
