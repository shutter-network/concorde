# Shared Agent Framework

[`docs/quickstart.md`](./docs/quickstart.md) takes a reader from a clone to a completed
agent Run, and [`example/`](./example/) is the reference deployment it describes:
`main.ts` is the worked entry point, `compose.yml` the whole stack, `gateway/Dockerfile`
the Gateway image, `agent/Dockerfile` the agent image, and `schema.ts` +
`drizzle.config.ts` + `migrate/Dockerfile` the migration step it owns itself
([ADR-0046](./docs/adr/0046-the-operator-owns-migrations.md)): the framework applies no
DDL and there is nothing in `main.ts` asking it to, so a one-shot `migrate` service
pushes the barrel before the Gateway starts. It is a **consumer** of
`createGateway`, which builds the irreducible infrastructure and hands it to the Operator's
`extend`
([ADR-0045](./docs/adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)), so
what is left in it is the Runtime, the six components built by hand in `extend`, two
Signal Handlers and shutdown. Six because messaging is two parts now: the Messenger owns the log
and reaches nobody, and a **Channel** is what reaches a person over one medium
([ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). The
example builds the HTTP Channel, and **the Nostr Channel is the first component with no entry in
the reference deployment at all**: one Channel per Messenger is refused at registration, so a
deployment runs one medium, and the example keeps the one the quickstart's spine is written in
([ADR-0049](./docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)). The quickstart
therefore gains no Nostr section, because a section for something the stack does not run would
mislead by placement. `createBareGateway` is the escape one layer down, for a
deployment whose infrastructure shape itself differs.

**It runs only as a Compose stack**, `cd example && docker compose up -d --build`, from
that directory and not the repository root
([ADR-0039](./docs/adr/0039-the-reference-deployment-runs-in-a-compose-stack.md)). The
Gateway is a container holding the host's Docker socket, so `main.ts` requires
`BASE_DIR_GATEWAY` and `BASE_DIR_HOST` (the two sides of `hostRoot`, both set in
`compose.yml` beside the binds they must agree with), and running it with `node` is not
supported. It also
requires `SIGNING_KEY_FILE`, a PEM private key it loads itself and hands to
`createSignatures` in `extend`: the framework parses nothing and generates nothing, so a
deployment brings its own identity or does not start
([ADR-0041](./docs/adr/0041-the-shared-agent-has-a-signing-identity.md)). It reads
`DATABASE_URL` itself for the same reason the framework reads no environment at all:
`createGateway` takes a required `databaseUrl` with no `DATABASE_URL` fallback, so where the
Db connects is stated at the call site
([ADR-0045](./docs/adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)). **Where the stack
gets that file is settled**: a throwaway PKCS8 keypair,
`example/insecure-example-only-signing-key.pem`, is committed to the example, `compose.yml`
passes `SIGNING_KEY_FILE` and mounts it read-only, and `docker compose up -d --build` comes up
from a fresh clone with no manual signing-key step, so the one-command promise holds. The key is
a decoy that signs nothing anyone verifies, and it shouts as much at every point of contact: its
filename, `compose.yml`, `main.ts` and the quickstart each mark it worthless and each say a real
deployment generates its own. The quickstart's arc now runs through a Decision published,
fetched, and verified offline against the key set.
The image builds the framework itself, from a context that is the repository root, which is
what `.dockerignore` is for. Nothing in `example/` ships in the tarball; `tsconfig.json`
type-checks it against `src` through a `paths` mapping, while the image resolves the same
imports to the `dist` it just built.

## Toolchain and checks

```sh
mise install    # provisions the pinned Node version from mise.toml
npm ci          # installs dev dependencies from the lockfile
npm run check   # typecheck, build, lint, test: the one command, and what CI runs
```

`npm run check` needs a PostgreSQL server. PostgreSQL is real in every test and
nothing about the Db is mocked ([ADR-0022](./docs/adr/0022-the-store-is-postgresql-through-drizzle.md)),
so a container is a prerequisite rather than an optional extra:

```sh
docker run -d --name saf-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
```

`DATABASE_URL` names the server and defaults to that container's URL,
`postgres://postgres:postgres@localhost:5432/postgres`. The database it names is
only ever connected to in order to create and drop others: no two test files
share a database, and a test whose subject is what a fresh database ends up
containing takes one of its own. See `src/test-support/database.ts`.

`npm run check:package` is separate: it builds, packs, installs the tarball into a
throwaway project, and checks that **all thirteen** subpaths resolve there — to the type checker
and to Node both. **There is no root among them**: `package.json` `exports` has no `.` entry and
`import … from "shared-agent-framework"` resolves to nothing
([ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)). Nine are components, because a
component is one subpath and its tables arrive on it beside its constructor
([ADR-0047](./docs/adr/0047-a-component-is-one-subpath.md)): `/signals`, `/pi`, `/users`,
`/messenger`, `/http-channel`, `/nostr-channel`, `/signatures`, `/decisions` and `/scheduler`,
with no `/schema` specifier among them. Four are what the root used to hold and no component
owns: `/gateway` the assembly, `/logging` the logging seam, `/db` the PostgreSQL client and
`/agent-container` the container plumbing. It was eight until messaging split in two and a second
medium arrived: `/messenger` was **reserved and unreachable**, held for the day a peer of the HTTP
Messenger turned up, and what turned up was a Channel rather than a second Producer, so the
reserved name went to the part that owns the log and `/http-messenger` became `/http-channel`
([ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)).
`/nostr-channel` is the only Channel with tables of its own
([ADR-0049](./docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)). `/signals`
is the Signal Worker's own: its constructor, its options, the vocabulary a Signal
Handler is written in, and `templateHandler` all come off `shared-agent-framework/signals`. The
last step of the check proves the root itself resolves to nothing, which is what would notice a
root export creeping back and making one name reachable two ways. It also assembles an Operator's
barrel out of the component specifiers and proves
it yields **one distinct schema object per component**, which is the assertion the prefixed
schema names exist for — see the flat-exports convention below. It needs the network, so it stays out
of the inner loop; it needs no database at all, because nothing in the package applies
DDL any more ([ADR-0046](./docs/adr/0046-the-operator-owns-migrations.md)). CI runs it
as its own step.

`npm run test:container` is the second separate one: the single end-to-end test
that starts a **real container** running a real `pi` against the real Agent
server. It builds its own image from `src/test-support/pi-image/Dockerfile`, so it
needs Docker and the network, and it takes about ten seconds. `npm run check`
skips it — the variable `SAF_CONTAINER_TESTS` is what opts in, and the skip
reason says so — because everything else about the container and about `pi` is a
fast test and the inner loop should stay one. CI runs it as its own step, so
"skipped by default" does not become "never run". It needs no model
credentials: the model is a scripted OpenAI-compatible server on localhost, and
everything else about the Run is real.

`npm run check:docs` is the third, and it is described with the site below, since what it needs
is what the site needs. It regenerates the committed API reference, fails when that reference
has fallen behind the doc comments, and builds the site. CI runs it as its own step too. So
there are four commands in CI and three of them are not the inner loop.

`npm run docs:dev` and `npm run docs:build` are the API reference: TypeDoc reads the doc
comments out of `src`, writes one markdown page per entry point, and VitePress serves or builds
them. The pages are the thirteen subpaths of the export map
([ADR-0047](./docs/adr/0047-a-component-is-one-subpath.md),
[ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)), titled with the specifier a
Developer imports from, and `example/` is not among them. The Messenger and each Channel are
separate pages for the reason they are separate subpaths: a Developer reads the one they are
using, and the Nostr Channel's page is the only documentation of it anywhere in the deliverable,
the reference deployment not running it. **Two words the reference is written in are now defined
nowhere in it.** **Operator** and **Shared Agent** appear on every page and belong to no
component, and the deleted root page's module comment was the only place the rendered reference
defined them. `site/reference/index.md` is generated from the entry point list and cannot be
authored into, so handwritten documentation is what will close that hole
([ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)). `CONTEXT.md` defines both and
is not part of what a Developer is handed.

**[`docs/api-docs.md`](./docs/api-docs.md) is what those comments are written against**: which
fact goes in a module comment, which in a constructor, which in a method, and which belongs in a
comment that never renders. It governs the OpenAPI `description` strings too, since those are
the other thing an Operator reads. Prose style is `/simple-english` and is not its subject.

**`site/` is an npm package of its own, with its own lockfile and its own `node_modules`**, and
it buys exactly one thing: a second TypeScript, because TypeDoc peers a compiler up to `6.0.x`
and this package pins 7. `site/README.md` argues that and states the **exit condition** — when
TypeDoc supports the compiler the root pins, the sub-package collapses into the root. All three
root scripts `npm ci` that tree themselves, so a fresh clone needs no separate step.

**`site/reference` is committed**, fourteen markdown pages: one per entry point, plus the `index.md`
that lists them and is the site root. That is what makes a change to the public API arrive as a
readable diff in review rather than as something to notice in a source diff, and it only works
because `typedoc.jsonc` sets `disableSources: true`. A file path, a line number and a commit
hash under every symbol would churn the diff on edits that changed no API at all. Nothing under
`reference/` is authored, so a page is never edited: change the doc comment and regenerate.

`npm run check:docs` is the third command, and it is separate from `npm run check` for exactly
the reason `check:package` is: it installs `site/`'s tree, so it needs the network and the
second compiler. It regenerates `site/reference`, **fails on any difference against what is
committed and names the files that differ**, and then builds the site so a broken configuration
fails in a check rather than in a browser. It reports both failures rather than stopping at the
first. It is also what makes the guard in `site/specifier-titles.mjs` unattended: that guard
compares `typedoc.jsonc`'s entry points against `package.json` `exports` both ways and fails
the generation if they disagree, and before this command nothing but a human running TypeDoc
fired it. CI runs it as its own step. TypeDoc's *warnings* fail it, through
`treatWarningsAsErrors` in `typedoc.jsonc`. They did not while one dangling reference was known
and ticketed, on the argument that an export-map change is not something a documentation check
gets to force at an unrelated moment; that reference went away and a tolerance with nothing behind
it hides only the next one. The dangling name was `CursorWindow`, and how it was answered is worth
carrying: it reached the package root to silence this warning, which is the reason ADR-0051 gives
for the root having become a bag of things. It is inlined at both `history` signatures now and
exported nowhere. The comparison against
the committed pages cannot cover that case, because a page naming a type no specifier exports is
honestly rendered rather than stale: it is committed, it matches, the check passes, and a
Developer reads a name they cannot type into an import. What the strictness costs is that the
export map is now something a CI step can force, at whatever moment a doc comment reaches for a
symbol that is on no subpath.

**`expandObjects` and `site/expanded-object-methods.mjs` are one change and have to stay one.**
The setting makes the block above an object type print its members instead of the word `object`.
That block is the first thing on a page and it is what a reader takes the shape from, and most of
this public API is object literals, so collapsed it left the shape to be assembled by hand out of
the sections below on every one of the thirteen pages. Set on its own, though, it is worse than
leaving it off: `typedoc-plugin-markdown` renders each member as `name: <type>` and takes that
type from `helpers.getDeclarationType`, which answers a member carrying signatures with the
**return type of its first signature**, so dozens of methods across `Db`, `Component`,
`Runtime`, `Users`, `Decisions`, `Scheduler`, `Messenger`, `Channel` and `NostrChannel` print as
properties holding their own return value, and `tx: Promise<T>` binds `T` to nothing at all. The word `object` said nothing
and misled nobody; that block would mislead. So the plugin travels with the setting. It defines a
theme, named on `typedoc.jsonc`'s `theme` line because defining one is how a render-context
override is installed, and it widens that one helper for members reached from inside an expanded
object. Two constraints bind any rewrite of it, and the file argues both: the widening applies
only inside an expanded object, because the sections below the block would otherwise print their
parameters twice, and what tracks "inside" counts rather than flips, because an expanded object
can hold another one.

Four costs, recorded rather than solved. **A parameter prints without its type**, so `Runtime`
reads `run: (prompt) => Promise<RunOutcome>` and the reader takes `RunPrompt` from the Methods
section below. That is `expandParameters`, off by default, and it is how every function type in
the reference already printed; turning it on widens far more than these blocks and was not asked
for. **`readonly` is dropped from an expanded member** and stays visible in the section a few
lines below it; restoring it means reimplementing the whole declaration partial instead of
wrapping one helper, which is a much larger patch surface bought for one modifier. **A `*Tables`
variable prints as `{ runs: PgTableWithColumns<{ }>; signals: PgTableWithColumns<{ }> }`**, where
naming the two tables is the gain and the empty braces are drizzle's own type under
`excludeExternals`. And **`SignalHandler.handle` wraps its return union raggedly** across three
lines of one page. The
plugin reads two names out of the render context, `partials.declarationType` and
`helpers.getDeclarationType`, and a future `typedoc-plugin-markdown` that renamed either one, or
that stopped asking the helper for a member's type, would leave the widening wired to nothing and
the methods quietly printing return types again. Nothing here guards against that on purpose:
`check:docs` regenerates and diffs against the committed reference on every CI run, so a
generation that moved fails and names the pages, which is the second thing committing the
reference buys.

**The one command must stay ignorant of the second compiler.** `npm run check` installs none of
`site/` and **must keep passing on a checkout where `site/node_modules` was never created** —
that is the test, and it is run by moving that directory aside, not by reading the
configuration. `tsconfig.json` does not include `site`, the test glob is `src/**`, and Biome
ignores markdown entirely, which is what lets thousands of lines of generated markdown sit in
the tree without touching `npm run lint`. Verified by running it, not by reading Biome's
configuration. **The one exception is JSON, and it is why `site/reference/typedoc-sidebar.json`
stays gitignored**: Biome formats JSON, TypeDoc's theme writes that file as one minified line,
and committing it would fail the one command over a file nobody reads. Every command that reads
it regenerates it first, so what leaving it out costs is that a change to the sidebar alone goes
uncaught, and that is a theme upgrade rather than an API change. What `npm run check` *does*
cover is the authored files in
`site/`, because `biome check .` lints the whole tree; that is wanted, and it costs no
documentation toolchain.

`npm run format` applies Biome's fixes; `npm run check` fails on unformatted code
rather than warning.

**The Operator generates and applies the DDL, and this repository holds no `.sql` at
all** ([ADR-0046](./docs/adr/0046-the-operator-owns-migrations.md)). There is no
`migrations:generate` script, no shipped migration folder, no descriptor, no
`db.migrate`, no root `drizzle.*.config.ts` — and therefore neither of the two hand-edits
that a regeneration used to demand. What a component ships is its `schema.ts`, re-exported
from its own subpath, `shared-agent-framework/<component>`, beside its constructor
(ADR-0047): there is no `/schema` specifier any more, and the tables of a component are
reached the same way everything else about it is. A deployment `export *`s the
components it runs into one barrel, points its own `drizzle.config.ts` at that barrel, and
applies it with its own `drizzle-kit`: `push` to prototype, `generate` + `migrate` in
production. `example/schema.ts`, `example/drizzle.config.ts` and
`example/migrate/Dockerfile` are the worked version, run as a one-shot container the
Gateway waits on with `condition: service_completed_successfully`.

The tests set their tables up the same way, through `src/test-support/apply-schema.ts`,
which hands the same schema objects to `drizzle-kit`'s `pushSchema`. Nothing in the suite
reaches for a folder, because there is none, and `src/schemas.test.ts` is the one test
that pushes **every** part's schema into a single fresh database, and then compares the
columns that arrived against the columns the parts declare. That is what catches a table
lost to a wrapper export, a schema-name collision between two parts, or a new part whose
schema nobody added to the set.

Two parts have none of any of this: Signatures and the HTTP Channel. Signatures stores nothing
because a Signed Statement is never kept
([ADR-0042](./docs/adr/0042-a-signature-is-a-compact-jws.md)); the HTTP Channel stores nothing
because the log it used to own is the Messenger's now, and HTTP delivery is the User asking, so
there is no queue either
([ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). Each has
no schema and no tables, and each subpath carries a constructor and nothing beside it. The Nostr
Channel is the counter-example that says a Channel is not a tableless kind of thing: it owns
**three** tables, because the mapping from a Nostr public key to a User, the set of envelopes it
has already read, and the queue of wraps the Relay has not taken yet are three things only it can
know (ADR-0049). The four infrastructure subpaths own no tables either and no barrel names them:
`/gateway`, `/logging`, `/db` and `/agent-container` carry constructors, seams and types
([ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)).

Conventions the build depends on:

- **Relative imports carry `.ts` extensions.** Node runs the sources directly by
  stripping types, and `tsc` rewrites the extension to `.js` when it emits.
- **`dist/` mirrors `src/` exactly**, so `src/db/db.ts` is `dist/db/db.js` and a
  subpath in `exports` names one file in both trees. `build` empties `dist`
  first, because `tsc` never prunes its own output and a deleted module would
  otherwise keep shipping; `npm run check:package` fails on a shipped file whose
  source is gone. Nothing shipped resolves a path out of `import.meta.url` any
  more — that trick existed only to reach a shipped migration folder, and there is
  none (ADR-0046).
- **Every subpath is a directory with an `index.ts`, and there is no `src/index.ts`.**
  `shared-agent-framework/gateway` is `src/gateway/index.ts`, `/logging` is
  `src/logging/index.ts`, and the same shape holds for all thirteen. The package root exports
  nothing, so a module written at `src/index.ts` would ship and resolve to nowhere
  ([ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)). A new subpath is a new
  directory, its `index.ts`, an `exports` entry, an entry point in `site/typedoc.jsonc` and a
  block in `scripts/check-package.ts`.
- **`src/http-client-tui/` is the one shipped directory that is not a subpath.** It is a
  `bin`, `http-client-tui`, a line-oriented terminal client for the HTTP Channel's two routes
  and the login. A `bin` is not importable, so the export map is untouched and there are still
  thirteen subpaths and no root; it is in no `exports` entry and in no `site/typedoc.jsonc`
  entry point, and the guard in `site/specifier-titles.mjs` compares those two against each
  other and would fail on either. **It has zero dependencies and must keep them**: native
  `fetch`, `node:readline/promises` and one hand-written escape sequence. A dependency added
  here lands in every consumer's install, and the answer to needing one is a second package.
  It imports the framework's own record types, as **types**, so a renamed field fails the
  typecheck rather than reaching a reader as an `undefined`. `scripts/check-package.ts` runs
  the command out of the installed tarball rather than looking for the file: the manifest, the
  `node_modules/.bin` link, the executable bit and the shebang are four separate things, and
  only running it reads all four.
- **No syntax that needs a code transform**: no enums, namespaces, or parameter
  properties. `erasableSyntaxOnly` rejects them, because Node strips types
  rather than compiling them.
- **Anything shipped must be under `files` in `package.json`** and proven by
  `npm run check:package`, not by reading the configuration. Every public export
  must also appear in the annotated `main.ts` that `scripts/check-package.ts`
  writes, and anything reaching for a new runtime dependency must be *imported
  and called* in the runtime step there — that is what proves the dependency is
  declared rather than merely present in our own `node_modules`.
- **`dependencies` carry caret ranges; `devDependencies` are pinned exactly.**
  The lockfile is committed, so exact pins in `dependencies` buy nothing for our
  own reproducibility and cost a consumer real things: a published library that
  pins forces duplicate installs in their tree and holds them at one patch
  version. `devDependencies` are ours alone, where an exact pin is what makes a
  toolchain upgrade a commit rather than a surprise.
- **Tests and their fixtures live beside the code they exercise and never ship.**
  `src/**/*.test.ts` and `src/test-support/` are excluded from
  `tsconfig.build.json`, which the tarball check asserts.
- **A component's tables are on the component's own subpath, and they must stay flat.**
  `shared-agent-framework/<component>` is the door an Operator's `drizzle-kit`
  reads through (ADR-0046, ADR-0047), and that tool takes `Object.values` of the module and
  keeps whatever passes `is(x, PgTable)` / `is(x, PgSchema)` — it never looks
  inside a plain object. So gathering the tables up as
  `export const usersTables = { users }` generates an **empty** migration and says
  nothing about it. `scripts/check-package.ts` imports every table **by name** out
  of the installed tarball for exactly that reason: a namespace import would
  resolve and prove nothing.
- **Every schema object and every `*Tables` wrapper keeps its component's prefix.**
  `usersSchema` and not `schema`, `usersTables` and not `tables`. The tables themselves are
  named for the tables — `users`, `tokens`, `messages` — and are distinct across components
  already, because each is `saf_<component>.<its own name>`. The prefix on the other two
  reads worse at an import site and it is load-bearing (ADR-0047): an Operator's barrel is
  wildcard re-exports of component subpaths, and **`export *` drops a name that resolves to
  more than one binding**, so six components exporting a bare `schema` produce a barrel
  exporting none, an empty derived `schemaFilter`, and a `push` that compares nothing against
  nothing, creates not one table and exits 0. Nothing warns, and the Gateway starts on the
  strength of that success. The prefix keeps the names distinct by construction; the
  packaging check's "one distinct schema object per component" assertion is what notices if
  anyone shortens them anyway.
- **Two schema modules import `src/users/schema.ts`, and there are two cross-schema
  foreign keys.** `src/messenger/schema.ts` declares `messages.user_id` onto
  `saf_users.users.id`
  ([ADR-0036](./docs/adr/0036-the-http-messengers-user-id-is-a-foreign-key.md),
  ADR-0046), and `src/nostr-channel/schema.ts` declares `pubkeys.user_id` onto the same
  column (ADR-0049). `outbox.user_id` is a third reference onto it, so the Nostr Channel
  makes two of the three. It was forbidden while each part generated a folder of its own,
  because the generator would emit the Users component's `CREATE TABLE` into the
  importing part's folder; with one generation graph it is the whole mechanism, and the
  constraint is free. What it costs a deployment is that a barrel carrying **either** the
  Messenger or the Nostr Channel without Users generates a foreign key onto a
  table it never creates. `src/schemas.test.ts` pushes all six parts' schemas together,
  which is what keeps the assembled set honest.
- **Three libraries are confined to the one component that owns each, and the rule is
  asserted rather than read.** `pg` is the Db's: parts obtain a handle with
  `db.handle(schema)`, and the one thing that needs a connection of its own — a `LISTEN`
  registration — with `db.listen(channel, listener)`, which keeps that connection inside
  the Db too. `jose` is Signatures': a second party assembling JWS segments is a second
  chance to emit something nobody can verify (ADR-0042). `nostr-tools` and
  `@nostrify/nostrify` are the Nostr Channel's, for the reason ADR-0049 makes them
  ordinary `dependencies` rather than peers — nothing from either crosses the API
  boundary, and a second part reaching for one would make them something a consumer has
  to install. All three live in **one** Biome `overrides` entry whose `includes` is the
  whole tree minus every owning directory, so a new directory is covered without being
  listed — and the cost of the single entry is that each exclusion frees all three
  libraries there rather than one. `src/test-support/**` is excluded too, deliberately:
  driving the fake Relay with a real client is the only thing that proves it is a Relay.

  **One entry, deliberately.** Biome applies the *last* matching `overrides` entry for a
  rule and **replaces** its configuration rather than merging it, so `pg` in one entry and
  `jose` in a second leaves only `jose` live — which is exactly what had happened, silently,
  for as long as there were two entries. A `//` comment anywhere in `biome.json` disables
  the overrides too, with no parse error and no warning. Neither says anything on the
  console, so `src/import-confinement.test.ts` runs the real Biome over a probe at a real
  path and reads what it says, per library and per specifier — `nostr-tools` ships forty
  subpaths and the component imports two, so the patterns name the subpaths as well as the
  bare package. Add a confinement to that entry and to that test, and never as a second
  entry.
- **Exactly one shipped module imports a *value* from `fastify`, and it is
  `dist/gateway/gateway.js`.** It constructs the two infrastructure servers and
  cannot do it any other way
  ([ADR-0045](./docs/adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md));
  everywhere
  else names Fastify's types and never its runtime, which is what keeps
  `serverComponent` structural and `fastify` an honest **peer** dependency.
  `scripts/check-package.ts` compares the emitted files that import it against an
  allowlist of that one name rather than against nothing, so a `FastifyListenOptions`
  written without `import type` still fails the packaging check — and nothing else
  would catch it, because the throwaway consumer installs Fastify and the import would
  resolve. A second module that genuinely needs one is a new allowlist entry, and it
  should arrive with the sentence saying why.
- **Both servers describe themselves, and a route declares what it answers with.**
  `createGateway` registers `@fastify/swagger` and `@fastify/swagger-ui` on
  each instance **before it calls `extend`**, because route discovery is an
  `onRoute` hook and every part registers its routes inside its own constructor, including
  the parts an Operator builds in `extend`,
  ([ADR-0040](./docs/adr/0040-the-gateway-describes-its-own-http-api.md),
  [ADR-0045](./docs/adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)).
  Move that
  registration below `extend` and the document is empty, which is why construction order in
  `src/gateway/gateway.ts` is load-bearing for a second reason, alongside the
  worker-before-Messenger cycle — migration registration order used to be a third and went
  with the subsystem (ADR-0046). So a route arrives with
  `tags`, a `summary`, a `description` and a `response` schema per status it can answer,
  or it arrives half-described: those sentences *are* the API documentation now, and
  `example/AGENTS.md` holds a URL and no route table. An Operator's own route is described
  only if it was `register`ed: one written straight onto the instance after the
  constructor returns is served and absent from the document, and both spellings are
  pinned in `src/gateway/gateway.test.ts`.
- **A response schema is a serializer, and its drift is silent.** Fastify compiles one
  with `fast-json-stringify`, which drops every field the schema does not declare with no
  warning anywhere and answers 500 for a declared-required field the handler omits. A
  field added to a record type and forgotten in its schema is therefore missing from the
  wire *and* from the document, and no comparison of one HTTP response against another can
  see it, because a uniformly stripped field is stripped on both sides. That is what the
  round-trip assertions in `src/gateway/gateway.test.ts` are for: each record type is
  produced through its part's own method, read back over HTTP, and the whole body compared
  against a literal the type checker holds to the record type. Same rule as the flat table
  exports and the prefixed schema objects above: a silent failure gets something that scans
  for it rather than a comment.
- **`src/nostr-channel/envelope.ts` unwraps the NIP-59 envelope by hand, over the
  encryption primitive, and that is not an optimisation.** `nostr-tools`' own `unwrapEvent`
  decrypts both layers and returns the rumor, **discarding the seal** — so `seal.pubkey` never
  reaches a caller and NIP-17's one `MUST`, that the rumor's author equals the seal's, is not
  merely omitted but inexpressible through it. Without that comparison any sender impersonates
  any other by changing the pubkey on an unsigned rumor (ADR-0049). Sealing goes the other way
  and *is* the library's one call, since a rumor the agent wrote carries the agent's key by
  construction; both halves live in that one file so they cannot drift apart. The check has one
  test whose whole subject is its absence, `src/nostr-channel/receiving.test.ts`'s forged
  envelope, and rewriting the unwrap through a convenience function is the thing to refuse in
  review.
- **Nothing in `src/agent-container/` knows about an Agent Implementation.** That
  directory is the Agent Container, the Mount Table and the process handling —
  what `docker run` takes and what to do with it — and it is exported from
  **`shared-agent-framework/agent-container`**, because the whole point of it is that a
  second Agent Implementation needs it unchanged
  ([ADR-0033](./docs/adr/0033-an-agent-is-a-container-and-one-function.md)). It sat at the
  package root until that root was emptied, and it is named for the two glossary terms it
  holds ([ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)).
  `src/pi/` is the other half and is one function plus two defaults; it imports
  from `src/agent-container/` and nothing imports back. Not enforced by a lint rule —
  an import of `../pi/` from there is the thing to refuse in review.
  Argument composition is tested in `src/agent-container/agent-container.test.ts`
  through `commandFor` on a constructed Runtime, and the one test that starts a
  real container stays in `src/pi/container.test.ts`.

## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/<feature>/` — no remote
tracker, no external contributors. See `docs/agents/issue-tracker.md`.

### Triage labels

Two statuses only, written as a `Status:` line at creation: `ready-for-agent` and
`needs-human`. No untriaged state; rejected issues are deleted, done issues move
to `.scratch/<feature>/done/`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root plus `docs/adr/`. See
`docs/agents/domain.md`.
