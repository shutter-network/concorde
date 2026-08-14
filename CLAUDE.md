# Concorde

A framework for building AI agents that serve several parties at once. Four documents carry what
this one does not, and none of it is repeated here:

- **[`README.md`](./README.md)** — what the framework is, and the table of the four examples
- **[`site/architecture.md`](./site/architecture.md)** — what the parts are and why they are separate
- **[`CONTEXT.md`](./CONTEXT.md)** — the glossary. Use its terms; its `_Avoid_:` lines are banned
  synonyms, not discouraged ones
- **[`docs/adr/`](./docs/adr/)** — the decisions, with the alternatives that were refused

This file is for somebody **editing this tree**, and holds only what such a reader cannot reach
from the code: the commands, the failures that are silent, and the rules no tool enforces.

## Toolchain and checks

```sh
mise install    # provisions the pinned Node version from mise.toml
npm ci          # installs dev dependencies from the lockfile
npm run check   # typecheck, build, lint, test: the one command, and what CI runs
```

`npm run check` needs a PostgreSQL server. PostgreSQL is real in every test and nothing about the Db
is mocked, so a container is a prerequisite rather than an optional extra:

```sh
docker run -d --name concorde-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
```

`DATABASE_URL` defaults to that container's URL. The database it names is only ever connected to in
order to create and drop others: no two test files share a database. See
`src/test-support/database.ts`.

Three further commands are each their own CI step, kept out of the inner loop because each needs
Docker or the network:

- **`npm run check:package`** packs the tarball, installs it into a throwaway project, and proves
  every `exports` subpath resolves there for Node *and* the type checker. It is also the only thing
  anywhere that holds the thirteen table names apart, and the only proof that the root still
  resolves to nothing.
- **`npm run test:container`** is the single end-to-end test: a real container running real `pi`
  against the real Agent server, with a scripted model on localhost, so it needs no model
  credentials. About ten seconds. `CONCORDE_CONTAINER_TESTS` opts in.
- **`npm run check:docs`** regenerates `site/reference`, asserts every page still holds a
  preformatted block with a link inside it, and builds the site.

`npm run format` applies Biome's fixes; `npm run check` fails on unformatted code rather than
warning.

## `site/`

An npm package of its own, buying exactly one thing: a second TypeScript, because TypeDoc peers a
compiler up to `6.0.x` and this package pins 7. `site/README.md` states the exit condition. All
three root `docs:*` scripts `npm ci` that tree themselves.

**`npm run check` must keep passing on a checkout where `site/node_modules` was never created** —
test that by moving the directory aside, not by reading the configuration.

`site/reference/` is generated and gitignored. Nothing in it is authored: to change a page, change
the doc comment and regenerate.

Two tripwires, both silent:

- **`srcDir` (`.vitepress/config.ts`), `docsRoot` (`typedoc.jsonc`) and `referenceBase`
  (`scripts/reference/pages.ts`) must not be set equal.** The theme computes sidebar links as
  `path.relative(docsRoot, out)`, so making any two agree drops the `/reference` segment. VitePress
  reports a dead link written in a page and never one written in a sidebar, so `check:docs` passes
  and a reader finds it.
- **Attaching the signature-block links with a Shiki transformer does not work.** A transformer sees
  a token's string and nothing else; the same name is not always the same thing. Decorations take
  character ranges, which is why nothing is encoded into the highlighted text.

## `examples/`

Four independent npm applications resolving `@shutter-network/concorde` from the **registry** at
`^0.1.0`, never from this tree. **A change in `src/` is invisible to all four until it is
published**, so running an example proves nothing about an edit you just made — use
`npm run check:package`. They carry **no code comments**; a fact worth writing down goes in that
example's README. What each one is: [`README.md`](./README.md).

## Migrations

**The framework applies no DDL and this repository holds no `.sql` at all.** A component ships its
tables on a `/schema` subpath; a deployment stars the ones it runs into a barrel and applies them
with its own `drizzle-kit`. The tests do the same through `src/test-support/apply-schema.ts`.

Four ways that fails quietly, all of them a deployment's to get right:

- **`drizzle-kit push` without `--force`** meets a prompt it cannot show on a TTY-less one-shot,
  applies nothing, and **exits 0**. The Gateway then starts on the strength of that success.
- **A config with no `schemaFilter`** filters both sides of the diff down to `public`, finds no
  difference, creates not one table and exits 0. Deriving it from the barrel is why the five lines
  of `is` and `PgSchema` are not deletable.
- **A barrel missing `@shutter-network/concorde/users/schema`** while carrying any of the four
  components that reference it generates a foreign key onto a table nobody creates.
- **A table gathered into a `<component>Tables` wrapper and not also flat-exported** is dropped in
  silence: `drizzle-kit` keeps what passes `is(x, PgTable)` and never looks inside a plain object.

## Conventions the build depends on

- **Every subpath is a directory with an `index.ts`, and there is no `src/index.ts`.**
  `@shutter-network/concorde/users/schema` is `src/users/schema/index.ts`, and the tables are
  declared in it. The package root exports nothing, so a module at `src/index.ts` would ship and
  resolve to nowhere. A new subpath is a new directory, its `index.ts`, an `exports` entry, a block
  in `scripts/check-package.ts`, and documentation by **exactly one** generator — a `typedoc.jsonc`
  entry point, or, for a `/schema` subpath, the `src/<component>/schema/` a table page is written
  from. `site/specifier-titles.mjs` enforces the last of those both ways.
- **A component's tables are on its `/schema` subpath and must stay flat**, for the wrapper reason
  above. **No table is reachable two ways**: a component subpath carries the constructor and the
  types and yields no table and no schema object at all. The exception is eight names and no table
  among them — the four enum arrays and the unions derived from them, which a reader of a record has
  to be able to name. That overlap is permanent.
- **The schema object is `<component>Schema` and the wrapper is `<component>Tables`.** A name every
  schema module declares carries a component prefix, because **`export *` drops a name that resolves
  to more than one binding**: eight components exporting a bare `schema` yield a barrel exporting
  none, `schemaFilter` derives to one schema, and `push` prints `Changes applied` having created one
  component's tables. Two names are in that class and no more; the thirteen table names and the four
  enum arrays are not prefixed.
- **The table names are guarded by `scripts/check-package.ts`, which imports all eight `/schema`
  specifiers un-aliased into one module scope.** A duplicate is a `TS2300` and a `SyntaxError`
  naming both import lines. **An alias added to one of those lines removes the check for that
  name** — the one way this guard fails quietly.
- **Six cross-schema foreign keys all point at `concorde_users.users.id` and nothing points back.**
  Declared by the Messenger, the Nostr Channel (two), Password Auth (two) and Nostr Auth, in the
  `references(() => users.id)` calls. `src/schemas.test.ts` pushes every part's schema together,
  which is what keeps the assembled set honest.
- **Three libraries are confined to the component that owns each, in one Biome `overrides`
  entry.** `pg` is the Db's, `jose` is Signatures', and `nostr-tools`/`@nostrify/nostrify` belong to
  the two parts that speak Nostr. **Add a confinement to that entry and never as a second one**:
  Biome applies the *last* matching entry per rule and **replaces** its configuration rather than
  merging, so a second entry naming the same rule silently disables the first. A `//` comment
  anywhere in `biome.json` disables the overrides too, with no parse error. Neither says anything on
  the console, so `src/import-confinement.test.ts` runs real Biome over a probe and reads what it
  says — extend that test with the entry.
- **Exactly one shipped module imports a *value* from `fastify`, `dist/gateway/gateway.js`.**
  Everywhere else names Fastify's types and never its runtime, which is what keeps `serverComponent`
  structural and `fastify` an honest peer dependency. `scripts/check-package.ts` holds the emitted
  imports against an allowlist of that one name, and nothing else would catch a
  `FastifyListenOptions` written without `import type`.
- **A route arrives with `tags`, a `summary`, a `description` and a `response` schema per status, or
  it arrives half-described.** Those sentences *are* the API documentation. `createGateway`
  registers `@fastify/swagger` **before it calls `extend`**, because discovery is an `onRoute` hook
  and every part registers inside its own constructor; move it below `extend` and the document is
  empty. An Operator's own route is described only if it was `register`ed.
- **A response schema is a serializer, and its drift is silent.** `fast-json-stringify` drops every
  field the schema does not declare with no warning, and answers 500 for a declared-required field
  the handler omits. No comparison of one HTTP response against another can see it, because a
  uniformly stripped field is stripped on both sides — which is what the round-trip assertions in
  `src/gateway/gateway.test.ts` are for: build the record in process, read it back over the wire,
  compare the whole body.
- **`src/nostr-channel/envelope.ts` unwraps the NIP-59 envelope by hand, and rewriting it through
  `nostr-tools`' `unwrapEvent` is the thing to refuse in review.** That function returns the rumor
  and discards the seal, so NIP-17's one `MUST` — the rumor's author equals the seal's — is not
  merely omitted but inexpressible through it, and any sender impersonates any other.
  `src/nostr-channel/receiving.test.ts`'s forged envelope is the only thing that would notice.
- **`src/nostr-auth/nip98.ts` refuses the same convenience.** `nip98.validateToken`'s freshness
  check is one-sided, so an event stamped in the **future** passes and passes forever. `verifyEvent`
  is the primitive and the checks above it are ours, with the window applied in **both** directions.
  `src/nostr-auth/authenticating.test.ts` sends the same future-dated bytes to the library, **which
  returns true**, and then to the server, which refuses.
- **`templateHandler` takes template *source*, never a path; widening `template` back to
  `string | URL` is the thing to refuse in review.** A template read per Signal first fails a
  *Signal*, and a failed Signal is never retried. Compiled at construction, the same typo fails
  `createGateway` before the Gateway listens. **`Handlebars.compile` defers the parse *and* the code
  generation to the first render**, so `src/signals/template-handler.ts` calls `precompile` above it
  and throws the result away; dropping that puts the case back on a Signal. What it costs is live
  editing: changing a prompt is a rebuild.
- **Nothing in `src/agent-container/` knows about an Agent Implementation.** That directory is what
  `docker run` takes and what to do with the result; `src/pi/` is the other half and imports from
  it. Nothing imports back, no lint rule enforces that, and an import of `../pi/` from there is the
  thing to refuse in review.
- **`src/http-client-tui/` is the one shipped directory that is not a subpath.** It is a `bin`, so
  the export map is untouched. **It has zero dependencies and must keep them**: a dependency added
  here lands in every consumer's install, and the answer to needing one is a second package.
- **`dependencies` carry caret ranges; `devDependencies` are pinned exactly.** The lockfile is
  committed, so exact pins in `dependencies` buy nothing and cost a consumer duplicate installs.
- **Anything shipped is proven by `npm run check:package`, not by reading `files`.** Every public
  export must appear in the annotated `main.ts` that check writes, and anything reaching for a new
  runtime dependency must be *imported and called* in its runtime step — that is what proves the
  dependency is declared rather than merely present in our own `node_modules`.
- **Publishing is a hand act**: `npm version patch && npm publish && git push --follow-tags`.
  `prepublishOnly` builds; the `version` lifecycle runs `scripts/stamp-version.ts`, which writes
  `describedVersion` in `src/gateway/gateway.ts` and `git add`s it, so the release commit carries
  both numbers or neither. `gateway.test.ts` holds that literal against the manifest and is a
  backstop rather than a guard: `prepublishOnly` does not run tests, so it fails on `main` *after* a
  bad publish, which is what it did twice.

## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/<feature>/` — no remote
tracker, no external contributors. See `docs/agents/issue-tracker.md`.

### Triage labels

Two statuses only, written as a `Status:` line at creation: `ready-for-agent` and
`needs-human`. No untriaged state; rejected issues are deleted, done issues move
to `.scratch/<feature>/done/`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
