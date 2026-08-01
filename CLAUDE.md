# Shared Agent Framework

[`docs/quickstart.md`](./docs/quickstart.md) takes a reader from a clone to a completed
agent Run, and [`example/`](./example/) is the reference deployment it describes:
`gateway.ts` is the worked entry point, `migrate.ts` the same migration call as a step of
its own, `compose.yaml` the containers, `agent/Dockerfile` the agent image. Nothing in
`example/` ships in the tarball; `tsconfig.json` type-checks it against `src` through a
`paths` mapping, while Node resolves the same imports to `dist` at runtime — so
`node example/gateway.ts` needs a build first.

## Toolchain and checks

```sh
mise install    # provisions the pinned Node version from mise.toml
npm ci          # installs dev dependencies from the lockfile
npm run check   # typecheck, build, lint, test: the one command, and what CI runs
```

`npm run check` needs a PostgreSQL server. PostgreSQL is real in every test and
nothing about the Store is mocked ([ADR-0022](./docs/adr/0022-the-store-is-postgresql-through-drizzle.md)),
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
reason says so — because everything else about the `pi` adapter is a fast test and
the inner loop should stay one. CI runs it as its own step, so "skipped by
default" does not become "never run". It needs no model credentials: the model is
a scripted OpenAI-compatible server on localhost, and everything else about the
Run is real.

`npm run format` applies Biome's fixes; `npm run check` fails on unformatted code
rather than warning.

`npm run migrations:generate` regenerates a part's migration folder from its
schema with `drizzle-kit`, and its output is committed — Operators never run a
schema generation tool. Each part has a config file of its own and passes it with
`--config`, because `out` is one folder and each part owns its own:

```sh
npm run migrations:generate                                        # the Core
npm run migrations:generate -- --config drizzle.users.config.ts    # the User Directory
```

Read the config before running either: a generated first migration needs one line
removed by hand.

Conventions the build depends on:

- **Relative imports carry `.ts` extensions.** Node runs the sources directly by
  stripping types, and `tsc` rewrites the extension to `.js` when it emits.
- **`dist/` mirrors `src/` exactly**, so a path built from `import.meta.url` is
  the same relative path in both. That is what lets shipped migration folders
  resolve from `src/store/…` and `dist/store/…` alike. `build` empties `dist`
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
- **A shipped migration folder contains no `CREATE SCHEMA`.** `store.migrate`
  creates the descriptor's schema, and the tracking table lives in it, so a
  generated `CREATE SCHEMA` line must be removed after `drizzle-kit` writes it.
  `src/core/migrations.test.ts` scans every shipped folder and fails on one left
  in.
- **Nothing outside `src/store/` imports `pg`.** Enforced by a Biome override:
  parts obtain a handle with `store.handle(schema)`, and the one thing that needs a
  connection of its own — a `LISTEN` registration — with `store.listen(channel,
  listener)`, which keeps that connection inside the Store too.

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
