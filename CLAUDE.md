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
what is left in it is the Runtime, the four opinionated parts built by hand in `extend`, one
Signal Handler and shutdown. `createBareGateway` is the escape one layer down, for a
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
throwaway project, and checks that **all eight** subpaths resolve there — to the type checker
and to Node both. Eight, because a component is one subpath and its tables arrive on it
beside its constructor ([ADR-0047](./docs/adr/0047-a-component-is-one-subpath.md)):
the root, `/signals`, `/pi`, `/users`, `/http-messenger`, `/signatures`, `/decisions` and
`/scheduler`, with no `/schema` specifier and no reserved `/messenger` among them. `/signals`
is the Signal Worker's own: its constructor, its options and the vocabulary a Signal
Handler is written in come off `shared-agent-framework/signals` and **not** the package
root. The check imports the
Worker from there and then proves the root refuses the same name, which is the only thing
that would notice a root re-export creeping back and making one component reachable two
ways. It also assembles an Operator's barrel out of those component specifiers and proves
it yields **one distinct schema object per component**, which is the assertion the prefixed
schema names exist for — see the flat-exports convention below. It needs the network, so it stays out
of the inner loop; it needs no database at all, because nothing in the package applies
DDL any more ([ADR-0046](./docs/adr/0046-the-operator-owns-migrations.md)). CI runs it
as its own step.

`npm run test:container` is the other separate one: the single end-to-end test
that starts a **real container** running a real `pi` against the real Agent
server. It builds its own image from `src/test-support/pi-image/Dockerfile`, so it
needs Docker and the network, and it takes about ten seconds. `npm run check`
skips it — the variable `SAF_CONTAINER_TESTS` is what opts in, and the skip
reason says so — because everything else about the container and about `pi` is a
fast test and the inner loop should stay one. CI runs it as its own step, so
"skipped by default" does not become "never run". It needs no model
credentials: the model is a scripted OpenAI-compatible server on localhost, and
everything else about the Run is real.

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

Signatures has none of any of this, and is the only part of which that is true: it stores
nothing, so it has no schema and no tables, and its subpath carries a constructor and
nothing beside it
([ADR-0042](./docs/adr/0042-a-signature-is-a-compact-jws.md)).

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
  more than one binding**, so five components exporting a bare `schema` produce a barrel
  exporting none, an empty derived `schemaFilter`, and a `push` that compares nothing against
  nothing, creates not one table and exits 0. Nothing warns, and the Gateway starts on the
  strength of that success. The prefix keeps the names distinct by construction; the
  packaging check's "one distinct schema object per component" assertion is what notices if
  anyone shortens them anyway.
- **`src/http-messenger/schema.ts` imports `src/users/schema.ts`.** That import is
  how `messages.user_id` references `saf_users.users.id`
  ([ADR-0036](./docs/adr/0036-the-http-messengers-user-id-is-a-foreign-key.md),
  ADR-0046). It was forbidden while each part generated a folder of its own,
  because the generator would emit the User Manager's `CREATE TABLE` into the
  Messenger's folder; with one generation graph it is the whole mechanism, and the
  constraint is free. What it costs a deployment is that a barrel carrying the
  Messenger without the User Manager generates a foreign key onto a table it never
  creates. `src/schemas.test.ts` pushes all five parts' schemas together, which is
  what keeps the assembled set honest.
- **Nothing outside `src/db/` imports `pg`.** Enforced by a Biome override:
  parts obtain a handle with `db.handle(schema)`, and the one thing that needs a
  connection of its own — a `LISTEN` registration — with `db.listen(channel,
  listener)`, which keeps that connection inside the Db too. The override is on
  the whole tree but `src/db/**`, so a new directory is covered without being
  listed.
- **Exactly one shipped module imports a *value* from `fastify`, and it is
  `dist/gateway.js`.** It constructs the two infrastructure servers and
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
  `src/gateway.ts` is load-bearing for a second reason, alongside the
  worker-before-Messenger cycle — migration registration order used to be a third and went
  with the subsystem (ADR-0046). So a route arrives with
  `tags`, a `summary`, a `description` and a `response` schema per status it can answer,
  or it arrives half-described: those sentences *are* the API documentation now, and
  `example/AGENTS.md` holds a URL and no route table. An Operator's own route is described
  only if it was `register`ed: one written straight onto the instance after the
  constructor returns is served and absent from the document, and both spellings are
  pinned in `src/gateway.test.ts`.
- **A response schema is a serializer, and its drift is silent.** Fastify compiles one
  with `fast-json-stringify`, which drops every field the schema does not declare with no
  warning anywhere and answers 500 for a declared-required field the handler omits. A
  field added to a record type and forgotten in its schema is therefore missing from the
  wire *and* from the document, and no comparison of one HTTP response against another can
  see it, because a uniformly stripped field is stripped on both sides. That is what the
  round-trip assertions in `src/gateway.test.ts` are for: each record type is
  produced through its part's own method, read back over HTTP, and the whole body compared
  against a literal the type checker holds to the record type. Same rule as the flat table
  exports and the prefixed schema objects above: a silent failure gets something that scans
  for it rather than a comment.
- **Nothing in `src/container/` knows about an Agent Implementation.** That
  directory is the Agent Container, the Mount Table and the process handling —
  what `docker run` takes and what to do with it — and it is exported from the
  **package root**, because the whole point of it is that a second Agent
  Implementation needs it unchanged
  ([ADR-0033](./docs/adr/0033-an-agent-is-a-container-and-one-function.md)).
  `src/pi/` is the other half and is one function plus two defaults; it imports
  from `src/container/` and nothing imports back. Not enforced by a lint rule —
  an import of `../pi/` from there is the thing to refuse in review.
  Argument composition is tested in `src/container/agent-container.test.ts`
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
