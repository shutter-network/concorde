# Shared Agent Framework

**[`examples/`](./examples/) holds four deployments and this repository builds none of them.**
Each is an npm application of its own, with its own `package.json`, its own `tsconfig.json`, a
flat directory and a Compose stack, and each resolves `shared-agent-framework` from the
**registry** at `^0.3.0` rather than from this tree. So an example's import lines are the lines a
consumer writes, and a copy of the directory taken anywhere else still runs. They are
independent and not a ladder: `00_minimal` is Users, Password Auth, the Messenger and the HTTP
Channel with one seeded person and the terminal client; `01_scheduler` is the Scheduler alone,
with no Users component anywhere in it, and the only place a Gateway is shown with components
left out; `02_decisions` adds Signatures and Decisions and seeds two people, so two private
Message logs sit beside the one signed log both of them read; and `03_nostr` runs the Nostr
Channel against a strfry Relay in its own stack, driven by `nak`. **There is no longer *the*
reference deployment, and the phrase is retired**: it said something while there was exactly one,
and four numbered directories are examples.

Each `main.ts` is a **consumer** of `createGateway`, which builds the irreducible infrastructure
and hands it to the Operator's `extend`
([ADR-0045](./docs/adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)), so
what is in one is the Runtime, the components that deployment picked built by hand in `extend`,
one Signal Handler and shutdown. Which components those are is the whole difference between the
four. Messaging is two parts: the Messenger owns the log and reaches nobody, and a **Channel** is
what reaches a person over one medium
([ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)).
Authentication is a part again: an **Auth** owns one scheme's secret and turns a request carrying
it into a User
([ADR-0052](./docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)).
One Channel per Messenger is refused at registration, so no deployment runs both Channels and
`03_nostr` is the one that runs the Nostr one
([ADR-0049](./docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)). **Nostr Auth is
the one component no example builds**, and for no such rule: Auths are plural, but the deployment
that speaks Nostr serves nothing over HTTP for a NIP-98 credential to authenticate, and the two
that authenticate anybody at all hold passwords and no Nostr key, so a second scheme nobody there
can present would be in the stack for the documentation rather than for the deployment
([ADR-0053](./docs/adr/0053-nostr-auth-verifies-nip-98-per-request.md)).
`createBareGateway` is the escape one layer down, for a deployment whose infrastructure shape
itself differs, and no example reaches for it.

**Each runs only as a Compose stack and only from its own directory**
([ADR-0039](./docs/adr/0039-the-reference-deployment-runs-in-a-compose-stack.md)):
`cp .env.example .env`, a model key in it, `docker compose up -d --build`. The Gateway is a
container holding the host's Docker socket, so every `main.ts` requires **`RUNTIME_DIR_HOST`** and
hands it to a Mount Table as `runtimeDir`, the one required host path every entry's `path` is
written relative to and the only namespace the declaration has a name for
([ADR-0054](./docs/adr/0054-the-mount-table-takes-one-required-runtime-directory.md)); a leading
`/` on an entry is refused, because `join` would resolve it under the root a second time and fail
at the first Run rather than at construction. The value is `${PWD}` in every `compose.yml`:
brought up from anywhere else the stack resolves the agent's
mounts against a tree nobody is looking at. It is the *host's* path and the daemon's to resolve,
which is what the suffix on the variable is for, and the Gateway process cannot in general reach
that directory itself — anything the Gateway reads comes from its own image or from a path
stated separately, as `02_decisions`' `SIGNING_KEY_FILE` is. Running one with `node` on your
host is not supported. That is one constraint stated four times now rather than once, which is
what four directories cost.
Each owns its migration step
([ADR-0046](./docs/adr/0046-the-operator-owns-migrations.md)): the framework applies no DDL and
nothing in a `main.ts` asks it to, so a one-shot `migrate` service runs the same image with
`drizzle-kit push --force` and the Gateway waits on it with
`condition: service_completed_successfully`. An example's **`drizzle.config.ts`** is also where it
says which components own tables, as a list of component names it turns into `/schema` specifiers:
`00_minimal`'s is four names for five components, the HTTP Channel being the one that owns
nothing. Two facts about that file are recorded in
[ADR-0055](./docs/adr/0055-a-components-tables-are-a-subpath-of-their-own.md) rather than beside
the code, the examples carrying no comments. It resolves with `createRequire(import.meta.url)` and
**not** `import.meta.resolve`, because `drizzle-kit` reads its config by registering `tsx` and
`require`ing it, so the file runs as CommonJS and `import.meta.resolve` is not a function there —
the shape reads like an old spelling somebody will helpfully modernise, and modernising it breaks
all four. And `--force` is not belt-and-braces: `push` asks about a destructive statement on a
TTY, a Compose one-shot has none, and without the flag it applies nothing and **exits 0**, after
which the Gateway starts on the strength of that success and every query fails.

The framework reads no environment at all, so each `main.ts` reads its own, and **one rule decides
what it reads and one criterion decides what that rule catches.** The rule: *the entry point states
no fact about its own surroundings.* Facts about the **agent's** execution model stay in the file,
because a Shared Agent runs its agent in a container and that is the framework's own fact
([ADR-0033](./docs/adr/0033-an-agent-is-a-container-and-one-function.md)); a `main.ts` does not
know that **it** is in one. The criterion: *a value moves to the environment when it has a
counterparty in `compose.yml` that nothing compares it against.* Both listen addresses, the image
tag, the Docker network, the Agent server's URL and the runtime directory have one, so all of them
are read. `tokenTtl` does not — nothing in `compose.yml` has to agree with thirty days — so it
stays a literal, written as `30 * 24 * 60 * 60 * 1000` because the arithmetic is the
documentation. Apply the criterion to a value this list does not name rather than guessing from
the list. A listen address is **two flat variables and not one `host:port` string**, so the four
of them are four of the eleven names a reader of `00_minimal` meets before they meet a component;
the one string would have to be split on the *last* colon, `[::1]:8081` being a legal value, and
that is a parser guarding two fields Fastify takes separately. There is **no helper**: each
variable is `process.env.X` with a `!` where a `string` is
required and `Number(...)` for a port, and the guard that matters is `compose.yml`'s
`${VAR:?message}`, which fires before the container exists and names both the variable and the
fix. Two costs ride with that and are not answered. The `!` is an assertion the file cannot back,
in a file whose whole purpose is to be copied out: copied elsewhere with `DATABASE_URL` unset,
`pg` falls back to its own defaults and the crash names no variable this file reads. And an empty
port string parses to `0`, which binds a random free port, so `compose` publishes to a port
nothing is on and the only symptom is a connection refused. `AGENT_SERVER_URL` is passed through
and not constructed, because a `main.ts` does not know its own service name, and each `AGENTS.md`
refers to `$AGENT_SERVER_URL` rather than to a port — at the cost that the reader of that file is
a language model, to which a literal URL is unambiguous in a way a variable reference is not, and
a model that fails to interpolate gets a failure that reads as a network problem.

`createGateway` takes
a required `databaseUrl` with no `DATABASE_URL` fallback, so where the Db connects is stated at
the call site (ADR-0045), and `02_decisions` loads its PEM itself and hands the key to
`createSignatures`: the framework parses nothing and generates nothing, so a deployment brings
its own identity or does not start
([ADR-0041](./docs/adr/0041-the-shared-agent-has-a-signing-identity.md)). **The key material two
examples carry is committed and worthless, and shouts it at every point of contact.**
`02_decisions/insecure-example-only-signing-key.pem` is a throwaway Ed25519 keypair;
`03_nostr/.env.example` carries three secp256k1 keypairs, the agent's and one per person. Both
exist so that `docker compose up` is the whole setup from a fresh clone, and each is marked
worthless wherever it is met: the PEM's own filename and the two lines of `compose.yml` that pass
and mount it, the block of capitals above the hex in `.env.example`, and both READMEs, every one
of them saying to generate your own. Generating at first boot was the alternative and fails
worse: `docker compose down -v`
mints a fresh signing key, and every Decision published under the old one silently stops
verifying.

**Nothing in `npm run check` type-checks an example, and Biome reads all four.**
`tsconfig.json` includes `src` and `scripts`, and it has no
`paths`, so nothing here type-checks an example and nothing can resolve an example's imports back
into `src` by accident. `npm run lint` is `biome check .` over the whole tree **minus `**/*.svg`**,
which is the whole of `files.includes` in `biome.json` and is not a style choice: Biome parses an
`.svg` as HTML, and `site/public/architecture.svg` fails that parse on its `DOCTYPE` and again on
its root element, so the one command went red over a file Biome has no business reading. Excluded
tree-wide rather than by directory, because there is nothing for Biome to say about an SVG
anywhere. So every example is
formatted and linted by the one command, **and `lint/style/noNonNullAssertion` is off under
`examples/` alone**, which is the one place a rule is switched off by directory. Each `main.ts`
reads its environment with `!`, so the rule had forty things to say — nine, eight, eleven and
twelve across the four — about a spelling the environment rule above chose deliberately and
priced. None of them failed anything, a warning not being an error. What they cost was **the
diagnostic list**: Biome prints twenty and then says `Diagnostics not shown: 20`, and which twenty
it prints **varies between runs**, so any *other* warning arriving anywhere in the tree had a real
chance of landing in the half nobody sees. Forty known warnings were masking up to twenty unknown
ones. `biome check .` now reports nothing on a clean tree, so the next diagnostic prints.
Raising `--max-diagnostics` was the alternative and answers the truncation with forty lines of
noise on every run forever, which teaches a reader to skim. What the override costs is that `!`
is unremarked under `examples/` for **any** reason now, not only for an environment read; four
files of about fifty lines each, read by hand, is what stands in for the rule there.
The one thing under `examples/` the *test suite* reads is the committed key
material: `src/example-signing-key.test.ts` loads `02_decisions`' PEM and `03_nostr`'s hex secret
exactly as those deployments load them, because a decoy that stopped parsing is a worse outcome
than an unmarked one. Everything else is CI's, one step per directory, `npm install && npx tsc
--noEmit` inside it. **That checks an example against the version it pins and not against this
tree.** A change made here is invisible to all four until it is published, and nothing catches
what it broke in between; what those four steps catch is editing rot, and a pin bumped to a
version the example does not work against. **Nothing checks that an example comes up at all**, and
that surface is seven variables wider per directory than it was: `PUBLIC_HOST`, `PUBLIC_PORT`,
`AGENT_HOST`, `AGENT_PORT`, `AGENT_IMAGE`, `AGENT_NETWORK` and `AGENT_SERVER_URL` each have a
counterparty in `compose.yml` that **nothing compares them against**, which is the criterion that
put them there. A wrong port fails at boot; a wrong network or image tag fails at the **first
Run**, which under
[ADR-0017](./docs/adr/0017-failed-runs-are-not-retried.md) is a permanently dead Signal. The only
thing that reads a variable and its counterparty together is `docker compose up -d --build` and a
message round-tripped by hand.

**The package is published and publishing is a hand act**: `npm version patch && npm publish &&
git push --follow-tags`, at `0.3.0` today, with `prepublishOnly` building so that a stale `dist`
is not something to remember. **The version number used to be the one thing `prepublishOnly` does
not build, and `npm version` carries it now.** `src/gateway/gateway.ts` exports
`describedVersion`, the string both OpenAPI documents announce, written out as a literal because
nothing shipped resolves a path out of `import.meta.url` any more and the manifest is therefore
not something `dist/gateway/gateway.js` can read (see the convention below). npm's `version`
lifecycle runs `scripts/stamp-version.ts`, which reads the just-written manifest, writes that
literal and `git add`s the file, and npm commits the index — so the release commit carries both
numbers or neither, and the three-command sequence above is unchanged.
**It took two releases out of three to buy that.** `0.1.0` was published announcing `0.0.0` and
`0.3.0` announcing `0.2.0`, each corrected in `src` one commit later, neither corrected on npm,
and under [ADR-0040](./docs/adr/0040-the-gateway-describes-its-own-http-api.md) that document is
the API documentation, so both artifacts serve the wrong number to a Developer deciding what they
are talking to. `src/gateway/gateway.test.ts` compares the literal to the manifest and stays the
**backstop rather than the guard**: `npm publish` runs `prepublishOnly`, which builds and does not
test, so that test fails `npm run check` on `main` *after* a publish, which is exactly what it did
both times. What now reaches it is a version edited into `package.json` without `npm version`, or
a `describedVersion` declaration the stamp's whole-line match no longer recognises — and the stamp
refuses that case loudly rather than writing nothing. Gating the publish on the test instead was
the other option and costs a PostgreSQL server at publish time.
**No example commits a lockfile** and each installs
with `npm install` rather than `npm ci`, so a patch publish flows into all four with nothing
edited, and a breaking change bumps the minor and forces a deliberate four-place sweep, which is
when each example wants opening anyway. `/examples/*/package-lock.json` is in `.gitignore` for
that reason and not by oversight. What it costs is that an example is not reproducible: each
directory installs whatever satisfies the caret on the day it is built. **At `1.0.0` that stops
being acceptable**, and the fix is a committed lockfile per example with `npm ci` in the four CI
steps and the four Dockerfiles.

**[`docs/api-docs.md`](./docs/api-docs.md) governs the doc comments in `src` and governs nothing
under `examples/`. That is a reversal, and it is written down here because it will otherwise be
applied back by habit.** The single deployment these four replaced was about half comment by
volume with ADR cross-references throughout. The rule under `examples/` is simpler than a
calibration and is now stated as one: **an example carries no code comments.** Not fewer, none —
`main.ts`, `compose.yml`, `drizzle.config.ts`, `tsconfig.json` and every `Dockerfile` in all four
carry not one. Two files are exceptions and each for its own reason. `.env.example` is prose by
nature, and its comments are the shouting about a demo password and about worthless key material
that this file requires at every point of contact. `03_nostr/strfry.conf` is upstream's own
`/etc/strfry.conf.default` with one line changed, so it keeps upstream's sixty comment lines and
would stop being that file without them; what was deleted there was the twelve-line header this
repository wrote.

**A fact that used to live in a comment goes to the README, or to an ADR if no README will have
it.** Three went to READMEs in this sweep and each is now that fact's only home: `01_scheduler`'s
two-name schema list, `03_nostr`'s required `users`, and `00_minimal`'s "which components own
tables". Two went to ADR-0055, having no README home, and they are the two `drizzle.config.ts`
facts above. A README says what the example demonstrates and how to run it, briefly, and
stops; with no comment in any of the four to calibrate a new one against, the habit this
paragraph guards against has more to pull on than it did, not less. **`AGENTS.md` carries what is
true of every Run and a prompt template carries what is true of this Signal**, which is why there
is no `.hbs` in any example any more: each template is a string literal in `main.ts`, cut to what
is true of this Signal, with one extra line naming whose message it is where two people talk to
one agent, and everything standing that the deleted files said was already in the corresponding
`AGENTS.md`, more fully. That split lines up
with editability, `AGENTS.md` being mounted and live where a template is baked into the image.
**The cost priced against it did not land**, and that is worth knowing because the price was
recorded before the templates were written: the fear was that a prompt no longer repeating "answer
by calling, not by replying" leaves a model that skims `AGENTS.md` replying into the void and
looking like it worked, and all three literals kept that line. What they dropped is the route, the
body shape, the polling explanation and the formatting rules, every one of which `AGENTS.md`
states and states better. The terminal client the two HTTP examples run is a `bin` on this package
rather than a subpath of it, and the convention below is where that lives.

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
throwaway project, and checks that **all twenty-three** subpaths resolve there — to the type
checker and to Node both. **There is no root among them**: `package.json` `exports` has no `.`
entry and
`import … from "shared-agent-framework"` resolves to nothing
([ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)). Eleven are components:
`/signals`, `/pi`, `/users`,
`/password-auth`, `/nostr-auth`, `/messenger`, `/http-channel`, `/nostr-channel`, `/signatures`,
`/decisions` and `/scheduler`, each carrying a constructor and its types and **none of them
carrying a table** — which is the half of
[ADR-0047](./docs/adr/0047-a-component-is-one-subpath.md) that stands and the clause ADR-0055
reversed. Eight are `/schema`, one below each component that owns tables, and they are
where the tables are
([ADR-0055](./docs/adr/0055-a-components-tables-are-a-subpath-of-their-own.md)): `/pi`,
`/signatures` and `/http-channel` own none and have none. Four are what the root
used to hold and no component
owns: `/gateway` the assembly, `/logging` the logging seam, `/db` the PostgreSQL client and
`/agent-container` the container plumbing. Those fifteen were eight until
messaging split in two and a second
medium arrived: `/messenger` was **reserved and unreachable**, held for the day a peer of the HTTP
Messenger turned up, and what turned up was a Channel rather than a second Producer, so the
reserved name went to the part that owns the log and `/http-messenger` became `/http-channel`
([ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)).
`/nostr-channel` is the only Channel with tables of its own
([ADR-0049](./docs/adr/0049-the-nostr-channel-speaks-nip-17-to-one-relay.md)). They were thirteen
until authentication became a component again, and the eight `/schema` entries are the newest and
the whole of ADR-0055: `/password-auth` took the scrypt hashes, the Token
table and the login out of `/users`, and `/nostr-auth` arrived beside it, because a plural
mechanism with one member answers no question
([ADR-0052](./docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md),
[ADR-0053](./docs/adr/0053-nostr-auth-verifies-nip-98-per-request.md)). **`Auth` itself is on no
subpath of its own.** The type and its outcome are on `/gateway`, which already owns `Component`
and `serverComponent`, and a bare `/auth` was refused as the first subpath with no constructor in
it. `/signals`
is the Signal Worker's own: its constructor, its options, the vocabulary a Signal
Handler is written in, and `templateHandler` all come off `shared-agent-framework/signals`. The
last step of the check proves the root itself resolves to nothing, which is what would notice a
root export creeping back and making one name reachable two ways. It also collects the exports of
each `/schema` module the way `drizzle-kit` collects them, and proves that the eight yield **eight
distinct schema objects and thirteen tables, and that the component subpaths above them yield
neither** — the assertion the split exists for and the one nothing else in the repository makes,
because a `schema.ts` re-exported from both places puts every table behind two specifiers, and a
`/schema` module that stopped re-exporting one leaves that table queryable and absent from the
DDL. It needs the network, so it stays out
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
is what the site needs. It regenerates the API reference, asserts that every page still holds a
linked signature block, and builds the site. CI runs it as its own step too. So
there are four commands in CI and three of them are not the inner loop.

`npm run docs:dev` and `npm run docs:build` are the API reference: TypeDoc reads the doc
comments out of `src`, writes one markdown page per entry point, two more generators write the
table pages and the route pages after it, and VitePress serves or builds them all. TypeDoc's pages
are fifteen of the export map's twenty-three entries, the eleven components and the four
infrastructure subpaths
([ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)), titled with the specifier a
Developer imports from, and nothing under `examples/` is among them. **The eight `/schema` entries
are deliberately not entry points**, and a generated table page is the one generator that
documents each: for the reason those pages exist at all, below
([ADR-0055](./docs/adr/0055-a-components-tables-are-a-subpath-of-their-own.md)). The Messenger
and each Channel are separate pages for the reason they are separate subpaths, and each Auth is a
page for the same reason: a Developer reads the one they are using. `/nostr-auth`'s page is the only
documentation of that component in the deliverable, no example building it. **Two words the
reference is written in were defined nowhere in it, and the hole is closed.** **Operator** and
**Shared Agent** appear on every page and belong to no component, and the deleted root page's
module comment was the only place the rendered reference defined them; `site/reference/index.md`
is generated from the entry point list and cannot be authored into
([ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)). What closed it is the
handwritten documentation that paragraph predicted: **`site/` carries three authored pages now**,
`index.md`, `guide.md` and `architecture.md`, written for an Operator adopting the framework
rather than for a maintainer, and `index.md` defines both words. `CONTEXT.md` still defines them
and is still not part of what a Developer is handed, so the two definitions are a pair to keep in
step; the site's is the shorter one and says less on purpose.

**Those three pages made the site two things, and three values now state where `reference/`
sits.** `.vitepress/config.ts` sets `srcDir` to `site/`, `typedoc.jsonc` sets `docsRoot` to the
same directory, and `scripts/reference/pages.ts` exports `referenceBase` for the two renderers.
The theme computes its own sidebar links as `path.relative(docsRoot, out)`, which is why those
two were equal while the reference was the whole site and must not be equal again. Set any one of
the three back and that generator's links lose the `/reference` segment. **Nothing fails**:
VitePress reports a dead link written in a page and never one written in a sidebar, so
`check:docs` passes and a reader finds it. `site/README.md` is in `srcExclude`, being a note about
the toolchain that `srcDir` would otherwise serve as a page. The authored pages are **not** under
`site/reference`, which TypeDoc empties on every run; nothing about that directory changed.
[`docs/architecture.md`](./docs/architecture.md) and
[`docs/data-model.md`](./docs/data-model.md) are the maintainer's and stayed where they are: they
carry ADR citations by the clause and are written for whoever edits this tree, which is the
opposite reader, and the site's architecture page is not a replacement for either.

**[`docs/api-docs.md`](./docs/api-docs.md) is what those comments are written against**: which
fact goes in a module comment, which in a constructor, which in a method, and which belongs in a
comment that never renders. It governs the OpenAPI `description` strings too, since those are
the other thing an Operator reads. Prose style is `/simple-english` and is not its subject.
**Signature blocks becoming clickable changed nothing in it, and that is deliberate.** An
automatic link in a block is a second door to a symbol, not a replacement for a link a sentence
wants to make, so `{@link}` on the first occurrence of a symbol a reader will want to jump to
stays the rule it was.

**`site/` is an npm package of its own, with its own lockfile and its own `node_modules`**, and
it buys exactly one thing: a second TypeScript, because TypeDoc peers a compiler up to `6.0.x`
and this package pins 7. `site/README.md` argues that and states the **exit condition** — when
TypeDoc supports the compiler the root pins, the sub-package collapses into the root. All three
root scripts `npm ci` that tree themselves, so a fresh clone needs no separate step.

**`site/reference` is not committed, and it was.** Thirty-two generated markdown pages: fifteen
one per entry point, the `index.md` that lists them and is the site root, eight table pages under
`tables/` and eight route pages under `routes/`, both described below. `.gitignore` covers the
directory in full. Committing them bought one thing: a change to the
public API arrived as a readable diff in review. A signature block is HTML now, and a diff over
`<span>`s and `<a href>`s does not do that, so what was bought is no longer for sale. Three
reduced forms were declined on the same ground. Markup shaped to diff well is still a large
artifact whose diff is mostly markup. A second plain-text digest of the signatures is the same
facts rendered twice out of the same code, which is the artifact that goes stale first. One page
kept as a golden fixture owes an explanation for why that page is worth what all of them were
not. **What is given up is real and is not glossed here**: a reviewer of a doc-comment change can
no longer see the rendered result without running the site locally, which is where the site was
before the reference was committed. Read the missing drift check as that trade rather than as an
oversight, and do not restore it. `typedoc.jsonc` keeps `disableSources: true` for the argument
that outlived the diff: the repository is private, so the file path, line number and commit hash
under every symbol resolve for nobody. Nothing under `reference/` is authored, so a page is never
edited: change the doc comment and regenerate.

**Eight of those pages are not TypeDoc's, and they describe tables.** A doc comment cannot say
what a component creates in a database: `excludeExternals` empties drizzle's type parameter, so
`const tokens: PgTableWithColumns<{}>` is the whole of what TypeDoc knows. A generator of our own
runs after it. `npm run extract:schema` prints one JSON document to stdout and chooses no file,
`scripts/reference/render.ts` turns it into one page per component that owns tables, and `site/`'s
own `generate` is `typedoc && node ../scripts/reference/render.ts`, which is what puts the two in
one command and in that order: TypeDoc empties `site/reference` before it writes. `docs:dev`'s
watching TypeDoc runs with `--cleanOutputDir false` for the same reason, because otherwise the
first rebuild of a dev session deletes the table pages and the sidebar that lists them
(`site/README.md`). The pages land
in `site/reference/tables/`, are gitignored with everything else in there, and are **generated and
never authored**: a page is changed by changing a `schema.ts` and regenerating.
`site/.vitepress/config.ts` composes their sidebar section, which the renderer writes beside them,
with the one TypeDoc writes. Extraction needs no database, no Docker and no network, and
`npm run typecheck` reads it, which is why it lives in `scripts/` rather than in `site/`. Each page
states the PostgreSQL schema the component writes into and, per table, every column with its SQL
type, its nullability and its default, the primary key, the indexes, the unique and check
constraints, and the foreign keys with the schema-qualified table and column they point at. **A
foreign key that leaves the component's own schema gets a sentence at the top of the page**,
naming the columns and the subpath that creates what they point at: there are six of them onto
`saf_users.users.id` from four components, and a `drizzle.config.ts` listing any of those four
`/schema` subpaths without `shared-agent-framework/users/schema` generates a constraint onto a
table nobody creates.

**The structure comes from `generateDrizzleJson`**, `drizzle-kit`'s own snapshot generator and the
same code path an Operator's generation runs (ADR-0046), so a page cannot disagree with the DDL
they apply. Four fields of each snapshot are dropped: `id` and `prevId` are a fresh random pair per
call and would make two runs over an unchanged tree differ, and `version` and `dialect` describe
the format. `schemas`, `tables`, `enums`, `sequences` and `views` are kept. **`drizzle-kit`'s own
types do not survive the trip.** Its snapshot is declared as an inference over a zod this tree does
not resolve to the same major version of, so the whole return type is `any`, and deriving the kept
shape with `Pick` would type-check against nothing. The shape is written out by hand in
`scripts/reference/schema-extraction.ts`, and the five kept names are read off the raw object at
runtime, because a rename inside `drizzle-kit` is the one thing `any` lets through and it would
empty the pages rather than fail.

**The schema modules are listed, and the list is held against `src` both ways.** The spec declined
that guard and asked for the cost to be recorded instead, that a component missing from the list is
silently missing from the reference. It is closed rather than recorded, because both things it was
priced against have moved. It assumed a committed reference, where a page that stopped being
generated at least showed up once as a deleted file in review, and there is none. And the guard it
declined derived the list from the export map, which needs a hand-written list of the components
that legitimately own no tables and so moves the drift one file over. `src/<component>/schema.ts`
needs no exemption, because owning that file is what owning tables is, and the scan is not new
machinery: `src/schemas.test.ts` already holds the same list against the same files. Two more
refusals ride with it, each guarding a page that would otherwise be complete-looking and wrong. A
listed module exporting no table a snapshot can see fails, because that is the `tables` wrapper
trap (ADR-0046) and a component with no tables correctly has no page, so the absence would look
intended. And a snapshot carrying something the renderer does not describe fails, which today is
enums, sequences, views, row policies and row level security.

**Eight more of those pages describe the HTTP API, and the same pipeline writes them.** The route
descriptions already *are* the API documentation (ADR-0040), and until now the only way to read
them was `GET /openapi.json` against a Gateway that is up, so a Developer deciding whether to adopt
the framework had to build and start an example first. `npm run extract:routes`
prints one JSON document to stdout and chooses no file, and `scripts/reference/route-pages.ts`
turns it into one page per component that serves routes, under `site/reference/routes/`. Each page
carries every route's summary and its description **word for word**, the query and path parameters,
the request body, and the shape it answers with per status code. A shape is a nested list and not a
table, because a table cannot nest and a response is an envelope holding an array of records
holding an object with two spellings. The **Agent server and the Public server are separate sections
on the page**, which is the difference between what the agent can call and what a User's client
can. **No page names a mount point**: the extraction registers no prefix, so a path is printed as
its plugin declares it, and the constructor stays the one place a prefix is stated. That is also
what the hand-maintained tables in the `routes.ts` module comments used to do, badly: they were
compared against the routes by nothing, and two of them, the Messenger's and the HTTP Channel's,
had drifted into naming `/messages` for a plugin whose declared path is `/`. They are deleted. Each module comment now says only what a
reader of the source needs and points at the renderer.

**The structure comes from `@fastify/swagger`**, through the same `onRoute` hook a running Gateway
collects its document with. One bare Fastify per plugin, so two plugins cannot collide on a path
and the server is a property of the instance; the plugin registered; `app.ready()`; and
`app.swagger()`. Nothing calls a handler, so the operations ports are one `Proxy` and no Db,
Docker, model or network is involved. **The type checker is what makes those stubs honest, and this
is load-bearing rather than tidy**: a plugin called with one argument too few registers anyway,
with every route present and its `preHandler` `undefined`, and the document looks complete. Only
`npm run typecheck` fails it, which is why the extractor lives in `scripts/` and each plugin is
constructed with its real arguments. Three refusals ride with it, in the shape the table
extractor's have. The plugin list is held against every `src/<component>/routes.ts` both ways. A
document carrying a `$ref` or a JSON Schema keyword the renderer does not print fails the
generation with the keyword named, which is why `SchemaNode` holds fifteen keywords rather than the
whole of JSON Schema: a route that starts declaring `format` fails loudly instead of rendering a
page that is silent about the constraint. And **a route with no summary, no description, no tag or
no response at all fails**, which is ADR-0040's own rule getting a check for the first time, and is
also what covers the one way `@fastify/swagger` could break this quietly: `responses` is read off
the document by name, and renamed it would leave every route rendered with no status codes and the
page looking finished. **One gap is left rather than closed**: the scan counts a `routes.ts` once
however many plugins it exports, so a *second* plugin added to a listed module is absent from the
reference and nothing says so.

**`check:docs` reads none of these pages, and a per-page assertion for them was declined.** The one
it makes about TypeDoc's pages exists because a renderer wired to another package's internals by
name fails silently and beautifully. Nothing in either generator reads another package's internals.
The extractors' refusals fail the generation; a page and its sidebar entry come out of one loop over
one extraction, so they cannot disagree; and a pipeline that skipped the renderer fails at
`config.ts`, which statically imports a sidebar file only the renderer writes, into a directory
TypeDoc has just emptied. Three components correctly have no table page at all: `/pi`,
`/signatures` and `/http-channel` declare no `schema.ts`, the first because it is one function and
two defaults, the second because a Signed Statement is never kept (ADR-0042), and the third because
the log is the Messenger's (ADR-0048). Seven correctly have no route page: `/gateway`, `/logging`,
`/db` and `/agent-container` are infrastructure rather than components, `/pi` serves nothing,
`/nostr-channel` speaks to a Relay (ADR-0049), and `/nostr-auth` verifies a credential on every
request and registers no route on either server (ADR-0053).

`npm run check:docs` is the third command, and it is separate from `npm run check` for exactly
the reason `check:package` is: it installs `site/`'s tree, so it needs the network and the
second compiler. It regenerates `site/reference`, **asserts page by page that the page still
holds a preformatted block with a link inside it, and names every page that does not**, and then
builds the site so a broken configuration fails in a check rather than in a browser. Every step
of it is terminal now. It collected two independent findings while one of them was the drift
comparison against the committed pages; with one kind of failure left there is nothing to
collect. It is also what makes the guard in `site/specifier-titles.mjs` unattended: that guard
holds every entry in `package.json` `exports` against **exactly one generator** — a
`typedoc.jsonc` entry point or a `src/<component>/schema.ts` a table page is written from — both
ways, and fails the generation on any disagreement, an entry documented twice included. Before
this command nothing but a human running TypeDoc fired it. CI runs it as its own step. TypeDoc's
*warnings* fail it, through `treatWarningsAsErrors` in `typedoc.jsonc`. They did not while one
dangling reference was known
and ticketed, on the argument that an export-map change is not something a documentation check
gets to force at an unrelated moment; that reference went away and a tolerance with nothing behind
it hides only the next one. The dangling name was `CursorWindow`, and how it was answered is worth
carrying: it reached the package root to silence this warning, which is the reason ADR-0051 gives
for the root having become a bag of things. It is inlined at both `history` signatures now and
exported nowhere. The per-page assertion cannot cover that case either, because a page naming a
type no specifier exports is honestly rendered rather than unlinked: its blocks still carry
links, the assertion passes, and a Developer reads a name they cannot type into an import. What
the strictness costs is that the
export map is now something a CI step can force, at whatever moment a doc comment reaches for a
symbol that is on no subpath.

**The signature block at the top of every page is HTML this repository writes**, and
`site/expanded-object-methods.mjs` writes it. `useCodeBlocks` wraps a rendered declaration in a
fence, markdown does not parse the inside of a fence, and the plugin's own working links are
stripped out again on the way in. Turning the setting off gives the links back and takes the block
with it: a twenty-member object type arrives as one escaped blockquote line. Most of this public
API is object literals, so for as long as the block was fenced the reference was choosing between
two halves of one thing. The way out is that **a signature block is not source text**. It is a
rendering of a type tree in which every reference is already resolved, so nothing has to
rediscover that `Component` is a type alias with a page of its own. The renderer writes the
declaration into a text buffer, records the character range of each identifier it writes and the
URL the plugin's own router answers with, and hands the characters and the ranges to Shiki. Colour
is a function of the characters. **A link never is.** Shiki is a declared dependency of `site/`
rather than one reached through VitePress, `site/shiki-themes.mjs` names the two themes both
callers use, and no colour value is written down anywhere in this repository.

**Three partials are wrapped and nothing else is**: `declarationTitle`, `signatureTitle` and
`typeAndParent`. The type walk beside them is a hand-written stand-in for the plugin's `someType`
family rather than an override of it, which is what leaves the parameter and property sections
below a block exactly as they were: those sections call the plugin's own partials, and the
plugin's own partials are never touched. Two larger boundaries were refused. Converting the
plugin's emitted markdown back to HTML inside the two wrappers couples to another package's
output text, which is the worse thing to depend on. Owning the whole output through TypeDoc's
custom-output API inherits page structure, anchors, group ordering, the index page and the
sidebar, none of which has anything to do with links.

**A highlighter is not asked to find the links, and a Shiki transformer is the rewrite to refuse
in review.** A transformer sees a token's string and nothing else, so attaching a link there
means resolving a name back to a declaration, and the same name is not always the same thing:
`runStates` is a link inside `type RunState = typeof runStates[number]` and is the declared name
in `const runStates: readonly [...]` further down the same page. Decorations take character ranges
and never need to know what is inside them. The published alternative for fenced markdown,
`expressive-code-links`, fails from the other side for the same reason: it documents that a link
breaks when it spans more than one highlight token, and `Promise<string>` is several. A hyperlink
is not a property of the characters, which is why nothing is encoded into the text.

**The buffer must be valid TypeScript, and that is why parameters carry their types.** Shiki
colours with a TextMate grammar, and a grammar handed text outside the language classifies it
however it falls: `sign(typ, claims): Promise<string>;` colours the whole parameter list as plain
text and `Promise` as a value. So parameters print their types, and a block that is one member
rather than a program is highlighted with `grammarContextCode` set to an opening type literal, so
the fragment is tokenized in the state it belongs to. Narrowing a block by taking the parameter
types out would answer a real complaint about width and silently degrade the colouring of every
page. That is the second thing to refuse in review.

Every option around this gates less than it used to. `expandObjects` stays on and now buys one
thing: an object type prints its members instead of the word `object`. It no longer needs a
widening applied over `helpers.getDeclarationType`, which answers a member carrying signatures
with the return type of its first signature; that helper is never asked, because a member
carrying signatures is rendered as a method here. `useCodeBlocks` stays on and gates the
declaration keyword, the multi-line layout and whether this renderer runs at all; with it off the
plugin's blockquote rendering already links and has no block to lose, so that branch is left
alone. `expandParameters` stays off, because the plugin option widens the parameter tables below
the block as well and only the block was meant to widen.

Four costs were recorded against the widening this renderer replaced, and **all four are
gone**, three of them to this renderer. A parameter carries its type, so `Runtime` reads
`run: (prompt: RunPrompt) => Promise<RunOutcome>`. `readonly` is printed on a member of an
expanded object rather than dropped and left to the section below. And `SignalHandler.handle`
prints its return union on one line, because a union only wraps past seventy characters and this
one is not; when a union does wrap it takes one member per line behind its own bar, and a member
several lines long carries on under
that bar rather than falling back to the margin.
**The fourth went too, and not to the renderer.** It was a `tables` wrapper naming its tables
against empty braces, `PgTableWithColumns<{}>` being drizzle's own type under `excludeExternals`,
and there is no such block on any page now: the tables are on `/schema` subpaths and a `/schema`
subpath is not a TypeDoc entry point (ADR-0055). What went with it is larger than the cost it
closed and is recorded in that ADR — every sentence written above a table in a `schema.ts` is now
a comment for a reader of the source alone, a generated table page carrying structure and not
prose. What replaces the four is one new cost, accepted rather than missed:
**width**. The widest members went from about seventy characters to about a hundred and twenty and
scroll sideways on the method-heavy pages. That is the price of the annotation, not of the
colouring.

**The names read out of another package are what a plugin upgrade breaks.**
`partials.declarationTitle`, `partials.signatureTitle` and `partials.typeAndParent` are wrapped;
`ctx.router` (`getFullUrl`, `hasUrl`), `ctx.urlTo` and `ctx.page.model` answer where a reference
points; `ctx.helpers.getKeyword` and `ctx.helpers.isGroupKind` answer what a block is. Rename any
of them and the override is never called, the plugin's own wrapper runs, and the page renders as a
fenced code block: correctly coloured, entirely unlinked, and indistinguishable from the reference
before this renderer existed. That is the one quiet failure, and the per-page assertion in
`check:docs` is what scans for it. Every other way this design breaks is loud. An overlapping
character range throws during generation, because Shiki verifies that decorations do not
intersect; broken escaping is visible on sight; and a reference that resolves to nothing fails
through TypeDoc's warnings.

**One gap is left uncovered and recorded rather than guarded.** A type kind the walk does not
handle falls through to `String(type)`: a mapped type, a template literal, a type predicate. Every
reference inside one of those renders unlinked, wherever that kind occurs, and the per-page
assertion still passes because other references on those pages still link. Nothing catches it.
Somebody opening a page after touching the renderer does. Same trade as the names above, written
down so that it is a known cost rather than a surprise.

**The one command must stay ignorant of the second compiler.** `npm run check` installs none of
`site/` and **must keep passing on a checkout where `site/node_modules` was never created** —
that is the test, and it is run by moving that directory aside, not by reading the
configuration. `tsconfig.json` does not include `site`, the test glob is `src/**`, and Biome
ignores markdown entirely, which is what lets thousands of lines of generated markdown sit in
the tree without touching `npm run lint`. Verified by running it, not by reading Biome's
configuration. **The exception is JSON, and the generated sidebar is JSON**: Biome formats it,
TypeDoc's theme writes `site/reference/typedoc-sidebar.json` as one minified line, and that file
would fail the one command over something nobody reads. It does not, because `biome.json` sets
`vcs.useIgnoreFile` and `.gitignore` now covers `site/reference` in full. The rule that named that
one file went with the committed pages, and nothing argues an exception inside an ignored
directory. What `npm run check` *does* cover is the authored files in `site/`, because
`biome check .` lints the whole tree; that is wanted, and it costs no documentation toolchain.

`npm run format` applies Biome's fixes; `npm run check` fails on unformatted code
rather than warning.

**The Operator generates and applies the DDL, and this repository holds no `.sql` at
all** ([ADR-0046](./docs/adr/0046-the-operator-owns-migrations.md)). There is no
`migrations:generate` script, no shipped migration folder, no descriptor, no
`db.migrate`, no root `drizzle.*.config.ts` — and therefore neither of the two hand-edits
that a regeneration used to demand. What a component ships is its `schema.ts`, re-exported
from a subpath of its own, `shared-agent-framework/<component>/schema`, below the one carrying
its constructor (ADR-0055): `drizzle-kit`'s config takes **file paths and never objects**, so an
export entry is the only supported way to hand a consumer a stable path into the package, and
the alternative was an Operator writing `node_modules/shared-agent-framework/dist/...` against a
layout this package never promised. A deployment lists the `/schema` specifiers of the
components it runs in its own `drizzle.config.ts` and
applies them with its own `drizzle-kit`: `push` to prototype, `generate` + `migrate` in
production. **No deployment writes a barrel**, and that is what the subpaths bought: a barrel is a
second list of the components a deployment runs, compared against the first by nothing, whose own
first sentence goes stale. Each example under `examples/` is a worked version of that, four of
them: no `schema.ts` of its own, a `drizzle.config.ts` that resolves each specifier with
`createRequire(import.meta.url)` and still **derives** `schemaFilter` by importing those same
specifiers rather than listing it, and a `migrate` service running the deployment's own image with
`drizzle-kit push --force`, which the Gateway waits on with
`condition: service_completed_successfully`. Derived and not listed because a config with no
`schemaFilter` filters both sides of the diff down to `public`, finds no difference, creates not
one table and exits 0.

The tests set their tables up the same way, through `src/test-support/apply-schema.ts`,
which hands the same schema objects to `drizzle-kit`'s `pushSchema`. Nothing in the suite
reaches for a folder, because there is none, and `src/schemas.test.ts` is the one test
that pushes **every** part's schema into a single fresh database, and then compares the
columns that arrived against the columns the parts declare. That is what catches a table
lost to a wrapper export, a schema-name collision between two parts, or a new part whose
schema nobody added to the set.

Two parts have none of any of this, and they are still the same two: Signatures and the HTTP
Channel. Signatures stores nothing
because a Signed Statement is never kept
([ADR-0042](./docs/adr/0042-a-signature-is-a-compact-jws.md)); the HTTP Channel stores nothing
because the log it used to own is the Messenger's now, and HTTP delivery is the User asking, so
there is no queue either
([ADR-0048](./docs/adr/0048-the-messenger-owns-the-log-and-channels-reach-people.md)). Each has
no schema and no tables, each subpath carries a constructor and nothing beside it, and neither has
a `/schema` entry for the same reason `/pi` has none. The Nostr
Channel is the counter-example that says a Channel is not a tableless kind of thing: it owns
**three** tables, because the mapping from a Nostr public key to a User, the set of envelopes it
has already read, and the queue of wraps the Relay has not taken yet are three things only it can
know (ADR-0049). **Neither Auth is tableless either**, and an Auth is the part of the framework
most likely to be assumed stateless: Password Auth owns `passwords` and `tokens`, and Nostr Auth
owns `grants` and `admitted` even though it issues nothing, because a key nobody granted is
refused and a credential is spent once (ADR-0052, ADR-0053). What an Auth owns is a secret, and a
secret is a row. The four infrastructure subpaths own no tables and no config lists them:
`/gateway`, `/logging`, `/db` and `/agent-container` carry constructors, seams and types
([ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)), and `Auth` is on `/gateway`
among them.

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
  `src/logging/index.ts`, and the same shape holds for all twenty-three, a `/schema` subpath
  included: `shared-agent-framework/users/schema` is `src/users/schema/index.ts`, one line
  starring `../schema.ts`, and the declarations stay in `src/<component>/schema.ts` where the
  component's own modules, `src/schemas.test.ts` and the reference extractors all read them
  (ADR-0055). The package root exports
  nothing, so a module written at `src/index.ts` would ship and resolve to nowhere
  ([ADR-0051](./docs/adr/0051-the-package-root-exports-nothing.md)). A new subpath is a new
  directory, its `index.ts`, an `exports` entry, a block in `scripts/check-package.ts`, and
  documentation by exactly one generator — an entry point in `site/typedoc.jsonc`, or, for a
  `/schema` subpath, the `src/<component>/schema.ts` a table page is written from. Two of those
  four are enforced: `site/specifier-titles.mjs` holds `exports` against both generators both
  ways. There is no
  fifth any more, `tsconfig.json` having lost the `paths` that existed for one reader,
  the deployment that used to live in this tree and import the package by name.
- **`src/http-client-tui/` is the one shipped directory that is not a subpath.** It is a
  `bin`, `http-client-tui`, a line-oriented terminal client for the HTTP Channel's two routes
  and Password Auth's login. A `bin` is not importable, so the export map is untouched and there
  are still twenty-three subpaths and no root; it is in no `exports` entry and in no
  `site/typedoc.jsonc`
  entry point, and the guard in `site/specifier-titles.mjs` would fail on either. **It has zero
  dependencies and must keep them**: native `fetch`, `node:readline/promises` and one
  hand-written escape sequence. A dependency added here lands in every consumer's install, and
  the answer to needing one is a second package.
  It imports the framework's own record types, as **types**, so a renamed field fails the
  typecheck rather than reaching a reader as an `undefined`. **It ignores `WWW-Authenticate`
  deliberately**, now that a 401 carries one: it speaks the one scheme it can hold a secret for,
  so learning that the deployment also accepts Nostr changes nothing it could do, and signing a
  NIP-98 event needs a key, a signer and therefore a dependency. Its refusal already names the
  method, the URL, the status and what the Gateway said. `scripts/check-package.ts` runs
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
- **A component's tables are on the component's `/schema` subpath, and they must stay flat.**
  `shared-agent-framework/<component>/schema` is the door an Operator's `drizzle-kit`
  reads through (ADR-0046, ADR-0055), and that tool takes `Object.values` of the module and
  keeps whatever passes `is(x, PgTable)` / `is(x, PgSchema)` — it never looks
  inside a plain object. So gathering the tables up as
  `export const tables = { users }` generates an **empty** migration and says
  nothing about it. `scripts/check-package.ts` imports every table **by name** out
  of the installed tarball for exactly that reason: a namespace import would
  resolve and prove nothing. **No table is reachable two ways**, which is the other half of what
  that check asserts: a component subpath carries the constructor and the types and yields no
  table and no schema object at all. Three of the eleven do still re-export something from their
  `schema.ts` — `/signals` carries `runStates` and `signalStates`, `/messenger`
  `messageDirections`, `/scheduler` `scheduleKinds`, and each carries the union derived from its
  arrays. Eight names, each reachable from two specifiers, and no table among them: an array is
  what a column's check
  constraint is compiled from, so it lives in `schema.ts`, and `SignalRecord.state`,
  `RunRecord.state`, `MessageRecord.direction` and `ScheduleRecord.kind` are declared with the
  unions and go out on the wire, so a reader of a record has to be able to name them. The overlap
  is **permanent**, recorded in ADR-0055 with the three ways of ending it that were declined, and
  it is also held in place by `check:docs`: a record's field declared with a union that no documented specifier
  exports is the dangling reference `treatWarningsAsErrors` fails on, the way `CursorWindow` did.
- **The schema object is `schema` and the wrapper is `tables`, and the prefixes they used to
  carry are history rather than a rule.** `usersSchema` and `usersTables` existed to survive a
  wildcard barrel, because **`export *` drops a name that resolves to more than one binding** and
  eight components exporting a bare `schema` produced a barrel exporting none, an empty derived
  `schemaFilter`, and a `push` that created not one table and exited 0; `drizzle-kit` requires
  each listed schema file separately and merges no namespace, there is no barrel anywhere any
  more, and so the discipline protects nothing (ADR-0055). The table names — `users`, `tokens`,
  `messages` — never carried a prefix and never needed one, each being
  `saf_<component>.<its own name>`, and the near-miss the old rule could not cover is closed with
  it: `tokens` moved from `saf_users.tokens` to `saf_password_auth.tokens`, and while both existed
  a barrel carrying `/users` and `/password-auth` would have dropped the name from **both**, which
  is now impossible rather than uncaught.
- **Four schema modules import `src/users/schema.ts`, and there are six cross-schema
  foreign keys. Every one of them points at `saf_users.users.id` and nothing points back.**
  `src/messenger/schema.ts` declares `messages.user_id`
  ([ADR-0036](./docs/adr/0036-the-http-messengers-user-id-is-a-foreign-key.md), ADR-0046);
  `src/nostr-channel/schema.ts` declares `pubkeys.user_id` and `outbox.user_id` (ADR-0049);
  `src/password-auth/schema.ts` declares `passwords.user_id` and `tokens.user_id` (ADR-0052);
  and `src/nostr-auth/schema.ts` declares `grants.user_id` (ADR-0053). Counted from the
  `references(() => users.id)` calls in `src/*/schema.ts`, which is where the number lives.
  It was forbidden while each part generated a folder of its own,
  because the generator would emit the Users component's `CREATE TABLE` into the
  importing part's folder; with one generation graph it is the whole mechanism, and the
  constraint is free. What it costs a deployment is that a `drizzle.config.ts` listing **any** of
  those four `/schema` subpaths without `shared-agent-framework/users/schema` generates a foreign
  key onto a table it never creates, and an Auth is the
  new way to make that mistake: a deployment can run Nostr Auth, the Nostr Channel and no
  Messenger, and still owe Users to its own list. `03_nostr` is the worked case — nobody logs in
  there and `users` is in the list anyway — and `01_scheduler` is the one example where a short
  list is correct rather than an omission, building none of the four. `src/schemas.test.ts` pushes
  all eight parts' schemas together, which is what keeps the assembled set honest.
- **Three libraries are confined to the one component that owns each, and the rule is
  asserted rather than read.** `pg` is the Db's: parts obtain a handle with
  `db.handle(schema)`, and the one thing that needs a connection of its own — a `LISTEN`
  registration — with `db.listen(channel, listener)`, which keeps that connection inside
  the Db too. `jose` is Signatures': a second party assembling JWS segments is a second
  chance to emit something nobody can verify (ADR-0042). `nostr-tools` and
  `@nostrify/nostrify` are **the two parts that speak Nostr**, the Nostr Channel and Nostr
  Auth, for the reason ADR-0049 makes them
  ordinary `dependencies` rather than peers — nothing from either crosses the API
  boundary, and a third part reaching for one would make them something a consumer has
  to install. `!src/nostr-auth/**` is the newest exclusion and it went into that same one
  entry, never as a second (ADR-0053). All three libraries live in **one** Biome `overrides`
  entry whose `includes` is the
  whole tree minus every owning directory, so a new directory is covered without being
  listed — and the cost of the single entry is that each exclusion frees all three
  libraries there rather than one, so `src/nostr-auth/` may now import `pg` and `jose` as
  well and only review says no. `src/test-support/**` is excluded too, deliberately:
  driving the fake Relay with a real client is the only thing that proves it is a Relay,
  and signing a real NIP-98 event the only thing that proves a forgery is refused.

  **One entry for the confinement, deliberately, and the trap is per rule rather than per
  entry.** Biome applies the *last* matching `overrides` entry for a **rule** and **replaces**
  its configuration rather than merging it, so `pg` in one entry and `jose` in a second leaves
  only `jose` live — which is exactly what had happened, silently, for as long as there were
  two entries. `biome.json` has a second entry again, the one that turns
  `style/noNonNullAssertion` off under `examples/`, and an example file matches both. That is
  safe because the two entries name **different rules**, which is verified rather than read: a
  probe at `examples/00_minimal/` importing `pg` and asserting `process.env.Y!` is answered with
  the confinement error and no assertion warning, so both entries are live at once. Same group,
  `style`, and it makes no difference. A second entry naming a rule the confinement entry
  already names is the thing that breaks, and it breaks in silence. A `//` comment anywhere in
  `biome.json` disables the overrides too, with no parse error and no warning. Neither says
  anything on the console, so `src/import-confinement.test.ts` runs the real Biome over a probe
  at a real path and reads what it says, per library and per specifier — `nostr-tools` ships
  forty subpaths and the component imports two, so the patterns name the subpaths as well as
  the bare package. Add a confinement to that entry and to that test, and never as a third.
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
  or it arrives half-described: those sentences *are* the API documentation now, and each
  example's `AGENTS.md` holds a URL and no route table. An Operator's own route is described
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
- **`src/nostr-auth/nip98.ts` is that file's sibling and refuses the same convenience.**
  `nostr-tools` ships `nip98.validateToken` and nothing calls it. Its freshness check subtracts
  `created_at` from now and asks whether the result is under sixty, so an event stamped in the
  **future** passes and passes forever: a client ten years ahead holds a credential with no
  expiry (ADR-0053). Its top-level entry point also never binds the body to the signature.
  So `verifyEvent` is the primitive and the seven checks above it are ours, with the freshness
  window applied in **both** directions. The test whose whole subject is the absence is in
  `src/nostr-auth/authenticating.test.ts`: the same future-dated bytes go to the library's own
  validator, **which returns true**, and then to the server, which refuses. Nothing else in the
  repository would notice a rewrite through that function.
- **`templateHandler` takes template *source*, never a path, and widening `template` back to
  `string | URL` is the thing to refuse in review.** A path costs a caller one line,
  `template: readFileSync(new URL("./prompt.hbs", import.meta.url), "utf8")`, and costs the
  framework a whole class of failure, because a template read per Signal is a template that first
  fails a *Signal*, and a failed Signal is never retried
  ([ADR-0017](./docs/adr/0017-failed-runs-are-not-retried.md)): the person sent a message and
  nothing comes back. Compiled at construction instead, the same typo fails `createGateway` before
  the Gateway listens. **`Handlebars.compile` defers the parse *and* the code generation to the
  first render**, so `src/signals/template-handler.ts` calls `precompile` above it and throws the
  result away: that is the one entry point which runs both eagerly, and dropping it or reducing it
  to a parse puts the case back on a Signal. `src/signals/template-handler.test.ts`'s "a template
  that does not compile" is the test whose whole subject is its absence, and it holds both halves,
  an unclosed block for the parse and a partial called with two arguments for the code generator.
  The price is that a template is parsed and compiled twice, once per Handler per process. What
  stays a render failure is a helper's complaint about its own arguments, which runs only with a
  context. What the refusal costs is live editing, which the option used to have and the docstring
  says it has lost: changing a prompt is a rebuild. There is **no ADR**, this failing the
  hard-to-reverse test; this line and the `template` docstring are the two homes, and
  [ADR-0027](./docs/adr/0027-prompts-are-handlebars-templates-read-per-run.md) is amended where it
  said per Run.
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
