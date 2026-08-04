# Shared Agent Framework

[`docs/quickstart.md`](./docs/quickstart.md) takes a reader from a clone to a completed
agent Run, and [`example/`](./example/) is the reference deployment it describes:
`main.ts` is the worked entry point, `compose.yml` the whole stack, `gateway/Dockerfile`
the Gateway image, `agent/Dockerfile` the agent image. It is a **consumer** of
`createGatewayWithDefaults` rather than a demonstration of the assembly it replaced
([ADR-0038](./docs/adr/0038-the-default-assembly-is-a-constructor.md)), so what is left in
it is the Runtime, one Signal Handler and shutdown.

**It runs only as a Compose stack**, `cd example && docker compose up -d --build`, from
that directory and not the repository root
([ADR-0039](./docs/adr/0039-the-reference-deployment-runs-in-a-compose-stack.md)). The
Gateway is a container holding the host's Docker socket, so `main.ts` requires
`HOST_DIR` and declares `hostPaths`, and running it with `node` is not supported. It also
requires `SIGNING_KEY_FILE`, a PEM private key it loads itself and hands to
`createGatewayWithDefaults`: the framework parses nothing and generates nothing, so a
deployment brings its own identity or does not start
([ADR-0041](./docs/adr/0041-the-shared-agent-has-a-signing-identity.md)). **Where the stack
gets that file is not settled**: `compose.yml` neither passes the variable nor mounts a key,
so `docker compose up -d --build` does not currently come up, and the one-command promise
above is suspended until it does. The quickstart's arc stops short of Decisions for the same
reason.
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

`npm run check:package` is separate: it builds, packs, installs the tarball into
a throwaway project, checks that the subpaths resolve, and applies a shipped
migration folder to a real database from inside the installed package. It needs
the network and the same PostgreSQL server, so it stays out of the inner loop. CI
runs it as its own step.

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

`npm run migrations:generate` regenerates a part's migration folder from its
schema with `drizzle-kit`, and its output is committed — Operators never run a
schema generation tool. Each part has a config file of its own and passes it with
`--config`, because `out` is one folder and each part owns its own:

```sh
npm run migrations:generate                                              # the Signal Worker
npm run migrations:generate -- --config drizzle.users.config.ts          # the User Manager
npm run migrations:generate -- --config drizzle.http-messages.config.ts  # the HTTP Messenger
npm run migrations:generate -- --config drizzle.decisions.config.ts      # Decisions
```

Read the config before running any of them, because what ships is never quite what was
generated. Every part needs one line **removed**: a generated first migration begins
`CREATE SCHEMA`, and `db.migrate` has already created the descriptor's schema before it
applies the folder. The HTTP Messenger needs a second edit, in the other direction: the
foreign key on `messages.user_id` onto `saf_users.users.id`
([ADR-0036](./docs/adr/0036-the-http-messengers-user-id-is-a-foreign-key.md)) **added
back**, in the migration and in its snapshot both, since `drizzle-kit` reads one schema
file and a reference into another part's is a thing it cannot generate. Every later
regeneration then proposes a `DROP CONSTRAINT` for it, which is deleted from what it
wrote; `drizzle.http-messages.config.ts` has the mechanics.

Those two hand-edits guard different failures, and the addition is the dangerous one. A
forgotten removal is loud: `src/signals/migrations.test.ts` scans every shipped folder
and fails on a stray `CREATE SCHEMA`. A forgotten addition is **silent**: every test
passes against a database that simply does not enforce the constraint, and what it stops
enforcing is the agent's 404 for a Message addressed to nobody. That is why
`src/http-messenger/migrations.test.ts` scans the shipped folder for the constraint
itself.

Signatures has none of any of this, and is the only part of which that is true: it stores
nothing, so it has no schema, no tables, no folder, no descriptor and no config
([ADR-0042](./docs/adr/0042-a-signature-is-a-compact-jws.md)).

Conventions the build depends on:

- **Relative imports carry `.ts` extensions.** Node runs the sources directly by
  stripping types, and `tsc` rewrites the extension to `.js` when it emits.
- **`dist/` mirrors `src/` exactly**, so a path built from `import.meta.url` is
  the same relative path in both. That is what lets shipped migration folders
  resolve from `src/db/…` and `dist/db/…` alike. `build` empties `dist`
  first, because `tsc` never prunes its own output and a deleted module would
  otherwise keep shipping; `npm run check:package` fails on a shipped file whose
  source is gone.
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
- **A shipped migration folder contains no `CREATE SCHEMA`.** `db.migrate`
  creates the descriptor's schema, and the tracking table lives in it, so a
  generated `CREATE SCHEMA` line must be removed after `drizzle-kit` writes it.
  `src/signals/migrations.test.ts` scans every shipped folder and fails on one
  left in.
- **`migrations/http-messages` carries a foreign key `drizzle-kit` cannot
  generate.** `messages.user_id` references `saf_users.users.id`, and
  `src/http-messenger/schema.ts` may not say so: a schema file importing another
  part's makes the generator emit that part's `CREATE TABLE` into this folder
  ([ADR-0036](./docs/adr/0036-the-http-messengers-user-id-is-a-foreign-key.md)).
  So the constraint is added by hand to the generated migration, and the snapshot
  hand-edited to match, on **every** regeneration — which also means the next
  generation proposes dropping it, and that statement is deleted by hand too. This
  hand-edit is the more dangerous of the two: a forgotten `CREATE SCHEMA` removal
  fails loudly on the first migration of a new deployment, while a forgotten
  foreign key is silent — every test passes against a database that simply does
  not enforce it. `src/http-messenger/migrations.test.ts` scans the shipped folder
  for it, and also pins that applying this part before the User Manager fails
  legibly, since registration order is construction order.
- **Nothing outside `src/db/` imports `pg`.** Enforced by a Biome override:
  parts obtain a handle with `db.handle(schema)`, and the one thing that needs a
  connection of its own — a `LISTEN` registration — with `db.listen(channel,
  listener)`, which keeps that connection inside the Db too. The override is on
  the whole tree but `src/db/**`, so a new directory is covered without being
  listed.
- **Exactly one shipped module imports a *value* from `fastify`, and it is
  `dist/default-gateway.js`.** It constructs the default assembly's two servers and
  cannot do it any other way
  ([ADR-0038](./docs/adr/0038-the-default-assembly-is-a-constructor.md)); everywhere
  else names Fastify's types and never its runtime, which is what keeps
  `serverComponent` structural and `fastify` an honest **peer** dependency.
  `scripts/check-package.ts` compares the emitted files that import it against an
  allowlist of that one name rather than against nothing, so a `FastifyListenOptions`
  written without `import type` still fails the packaging check — and nothing else
  would catch it, because the throwaway consumer installs Fastify and the import would
  resolve. A second module that genuinely needs one is a new allowlist entry, and it
  should arrive with the sentence saying why.
- **Both servers describe themselves, and a route declares what it answers with.**
  `createGatewayWithDefaults` registers `@fastify/swagger` and `@fastify/swagger-ui` on
  each instance **before it constructs the first part**, because route discovery is an
  `onRoute` hook and every part registers its routes inside its own constructor
  ([ADR-0040](./docs/adr/0040-the-gateway-describes-its-own-http-api.md)). Move that
  registration below a part and the document is empty, which is why construction order in
  `src/default-gateway.ts` is load-bearing for a third reason, alongside the migration
  registration order and the worker-before-Messenger cycle. So a route arrives with
  `tags`, a `summary`, a `description` and a `response` schema per status it can answer,
  or it arrives half-described: those sentences *are* the API documentation now, and
  `example/AGENTS.md` holds a URL and no route table. An Operator's own route is described
  only if it was `register`ed: one written straight onto the instance after the
  constructor returns is served and absent from the document, and both spellings are
  pinned in `src/default-gateway.test.ts`.
- **A response schema is a serializer, and its drift is silent.** Fastify compiles one
  with `fast-json-stringify`, which drops every field the schema does not declare with no
  warning anywhere and answers 500 for a declared-required field the handler omits. A
  field added to a record type and forgotten in its schema is therefore missing from the
  wire *and* from the document, and no comparison of one HTTP response against another can
  see it, because a uniformly stripped field is stripped on both sides. That is what the
  round-trip assertions in `src/default-gateway.test.ts` are for: each record type is
  produced through its part's own method, read back over HTTP, and the whole body compared
  against a literal the type checker holds to the record type. Same rule as the two
  migration hand-edits: a silent failure gets something that scans for it rather than a
  comment.
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
