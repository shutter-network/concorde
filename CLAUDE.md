# Shared Agent Framework

[`docs/quickstart.md`](./docs/quickstart.md) takes a reader from a clone to a completed
agent Run, and [`example/`](./example/) is the reference deployment it describes:
`main.ts` is the worked entry point, `compose.yml` the containers, `agent/Dockerfile` the
agent image. It is a **consumer** of `createGatewayWithDefaults` rather than a
demonstration of the assembly it replaced
([ADR-0038](./docs/adr/0038-the-default-assembly-is-a-constructor.md)), so what is left in
it is the Runtime, one Signal Handler and shutdown. Nothing in `example/` ships in the
tarball; `tsconfig.json` type-checks it against `src` through a `paths` mapping, while Node
resolves the same imports to `dist` at runtime — so `node example/main.ts` needs a build
first.

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
