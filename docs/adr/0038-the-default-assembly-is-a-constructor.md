# The default assembly is a constructor

`createGatewayWithDefaults` builds the Db, both Fastify servers, the User Manager, the
HTTP Messenger and the Signal Worker, wires them to each other, puts them in an order, and
returns a Gateway ([ADR-0037](./0037-the-gateway-is-a-record-of-components.md)). It is the
canonical path, and `example/main.ts` is a consumer of it rather than a demonstration of
what it replaced.

```ts
type DefaultComponents = {
  db: Db;
  agentServer: Component & { readonly fastify: FastifyInstance };
  publicServer: Component & { readonly fastify: FastifyInstance };
  users: Users;
  messenger: HttpMessenger;
  worker: SignalWorker;
};                                            // and that is the start order

function createGatewayWithDefaults<
  E extends Record<string, Component> & { [K in keyof DefaultComponents]?: never },
>(options: {
  databaseUrl: string;
  runtime: Runtime;
  tokenTtl: number;
  agentListen: FastifyListenOptions;
  publicListen: FastifyListenOptions;
  extend?: (components: DefaultComponents) => E;
  handlers: (components: DefaultComponents & E) => SignalHandlers;
  logger?: Logger;
}): Gateway<DefaultComponents & E>;
```

This reverses ADR-0021's "the Operator's entry point *is* that assembly", and it is worth
being clear about what was actually lost when that was true. The reference deployment
carried eighteen lines of comment justifying a four-item list, one sentence of which
existed only to say that the obvious grouping of the two servers is wrong. That reasoning
was correct, unavoidable and identical in every deployment that uses our parts, and asking
each Operator to reproduce it was asking them to rediscover a fact we already knew. The
same is true of the four wiring facts and of the construction order that
[ADR-0036](./0036-the-http-messengers-user-id-is-a-foreign-key.md) forces.

An Operator who needs a different answer to any of it calls `createGateway` with a record
of their own. That escape is not cheap, and its cost is stated in the consequences.

## What it declines to construct

**The Runtime.** It is an option, not a spec, so nothing here imports
`shared-agent-framework/pi` and the package root stays agnostic about the Agent
Implementation. [ADR-0033](./0033-an-agent-is-a-container-and-one-function.md) says
swapping `pi` for another one is "this import and this function name, and nothing below",
and taking a container spec instead would have made that false for everyone on the default
path. It would also have defaulted nothing: the image, the environment, the networks and
the Mount Table are four deployment-specific values, and forwarding them is pass-through
dressed up as convenience. The Mount Table in particular is where the reference deployment
keeps its two real hazards, and hiding it behind an options key would suggest the framework
had an opinion about the agent when it has none.

**Fastify's constructor options.** The two servers are built with `Fastify()` and no
options, and the only thing an Operator states is where each one listens. There is no
bring-your-own-instance escape. That is a real limit rather than an oversight: a Public
server behind a reverse proxy wants `trustProxy`, which is not exotic, and getting it means
leaving the defaults constructor entirely. The alternative, an optional `fastify` on each
server option, was considered and dropped as one more key on the common path to serve an
uncommon one. `serverComponent` stays exported and the instances remain reachable at
`gateway.components.publicServer.fastify`, so routes, plugins and hooks are unaffected;
only what `Fastify()` itself takes is out of reach.

**A `tokenTtl` default.** ~~`src/users/users.ts` refuses one on the grounds that the trade
is the deployment's, since a long lifetime is fewer re-authentications and a longer window
for a stolen Token. A convenience constructor is not a reason to reverse a deliberate
refusal, so the option is required and forwarded.~~

**Reversed, together with `databaseUrl`, when the reference deployment moved into its own
Compose stack ([ADR-0039](./0039-the-reference-deployment-runs-in-a-compose-stack.md)).**
`tokenTtl` defaults to thirty days and `databaseUrl` to `DATABASE_URL` in the environment;
both options remain, and a deployment that states either gets what it asked for. What the
original paragraph got wrong was not the trade but whose it is. `createUsers` still requires
a lifetime, because a part is constructed by a caller who has already decided; this
constructor exists to answer the questions whose answer is the same in every deployment
using these parts, and it was requiring two callers in a row to type an answer they had no
information to vary. The cost is recorded rather than defended: `createGatewayWithDefaults`
became the only shipped module that reads `process.env`, which is an input its caller cannot
see at the call site, and it is confined to one variable.

**Migrations.** `start` does not apply them, and
[ADR-0032](./0032-components-wire-themselves-at-construction.md) stands in full. The
Operator calls `gateway.components.db.migrate()` between construction and `start`, which is
the same call the reference deployment already made. Applying at start was considered:
`drizzle-orm`'s migrator takes no advisory lock, but we could take one ourselves, so
concurrency is not the surviving objection. The surviving objections are that `db.start()`
exists to refuse a database that is behind, and migrating at start would make that check
unreachable a release after it was added; and that a pre-deploy migration step must remain
possible, which would then need a flag to switch start-migration off.

## Two callbacks, and why `handlers` runs second

`extend` receives the default Components and returns Components of its own. `handlers`
receives the defaults *and* the extension, and returns the `kind`-to-Handler map. Both are
callbacks for the same reason: they need objects this function constructs in its own body.

There is a genuine construction cycle behind `handlers`. The Signal Worker takes its
Handler map at construction (ADR-0031), the HTTP Messenger takes the Signal Worker
(ADR-0034), and a Handler's `post` phase calls `messenger.send` to tell somebody their Run
failed, which is the only path by which a failed Run reaches the person waiting
([ADR-0017](./0017-failed-runs-are-not-retried.md)). So the worker needs the handlers, the
handlers need the Messenger, and the Messenger needs the worker.

It is broken by construction order and one mutation, inside this function: the worker is
built with an empty map, the Messenger is built against the worker, `extend` runs,
`handlers` runs, and the result is written into the map the worker holds. The worker reads
`handlers[signal.kind]` at dispatch, so nothing about it changes. Nothing can dispatch
before `start`, and `handlers` is a required option, so "a Signal Worker with no Handlers
is unconstructable" survives with the same force it had.

`handlers` runs *after* `extend` because a Signal Handler may well need an Operator's own
Component, and the reverse ordering would be strictly less useful. `extend` therefore
cannot see the handlers, which is the correct direction: a Component that needed a Handler
would be a Component that wanted to be a Signal Worker.

**The Gateway is not passed to the Handler.** It was considered, and
[ADR-0024](./0024-signal-handlers-receive-only-the-signal.md) already rejected the smaller
version of it: a context object carrying the Messenger "would put messaging in the Core's
handler contract". Two things make it worse now than when that was written. `Gateway` is
generic in its record and the Signal Worker is *inside* that record, so a Handler parameter
typed `Gateway<C>` defines `C` in terms of itself; the only escape is
`Gateway<Record<string, Component>>`, which erases the record and hands a Handler a
`messenger` with no `send` on it. And a Handler would stop being a function of a Signal
plus whatever its factory was given, so testing one would need a fake Gateway where today
it needs an object literal. A callback gives the Handler's *author* every part, named and
precisely typed, one step earlier and at no cost.

## The order, and the one rule it comes from

```
start:  db -> agentServer -> publicServer -> users -> messenger -> worker -> extend
stop:   extend -> worker(drain) -> messenger -> users -> publicServer -> agentServer -> db
```

The rule is this. **The Signal Worker's `stop` is the only stop that does work.** Every
other one releases something. The worker's waits for the Run in flight and never cancels
it, and that Run reads the Db, calls the Agent server that `example/AGENTS.md` gave it the
URLs for, and reaches the Messenger through the `post` phase. So the drain goes **first**,
while every server is still listening, the Messenger is still live and the pool is still
open. Everything the drain needs outlives it because nothing has closed yet.

That is a different way of satisfying the constraint than ADR-0031 chose, and it lands
somewhere ADR-0031 explicitly moved away from:

> **This inverts the shutdown order the reference deployment used**, which closed both
> servers together after the drain and so kept the Public server accepting submissions
> throughout it.

The two servers are together again and the Public server accepts submissions throughout
the drain, which ADR-0031 treated as the defect it was fixing. **The trade is taken
deliberately and here is what it costs.** A Message submitted while the Gateway is shutting
down is stored, and its Signal commits with it (ADR-0034) and stays `pending`; the worker's
`stop` closes the `LISTEN` connection and clears the ticker before it waits, so nothing new
starts, and the next boot picks the Signal up. What the person gets is silence until the
Gateway is back rather than a refused connection now. Nothing is lost, and the alternative
order buys only a smaller window in which the Gateway accepts work it has already decided
not to do this run.

`users` and `messenger` are between the servers and the worker. Both are no-ops today, so
only the Messenger's position is reasoned: it must outlive the drain, because that is when
`post` sends its failure notice.

## Consequences

- **`example/migrate.ts` is deleted**, and the example becomes a single `main.ts` that
  constructs, migrates and starts. Nothing in the repository demonstrates migrating as a
  step of its own any more, which is the shape ADR-0032 argues is the only one that works
  for a rolling deploy. The quickstart keeps a short section showing the script an Operator
  writes, and the three migration descriptors stay individually exported for it. Neither a
  `defaultMigrations` array nor a `registerDefaultMigrations` helper ships: getting the
  order wrong fails loudly with `schema "saf_users" does not exist` (ADR-0036), and
  omitting a descriptor is caught by `db.start()`.
- **The escape hatch is expensive, and that is the price of this ADR.** Needing one Fastify
  constructor option, or a different position for one Component, means writing
  `createGateway` with all six entries by hand, including the ADR-0036 construction order
  that the defaults path makes unexpressible-wrongly. There is no partial exit.
- **An Operator's Components stop before the drain.** `extend` appends, so they are the
  first thing stopped. That is right for a Producer, which should stop producing before the
  worker drains, and wrong for a resource the drain uses, such as an outbound client the
  Handlers call. The second case is the one `extend` cannot express, and the answer is
  `createGateway`.
- **The package root now imports `./users` and `./http-messenger`.** The subpath exports are
  organisation rather than optionality, so a deployment that constructs no Messenger still
  loads the module. It does **not** import `./pi`, and that edge is the one worth keeping
  absent.
- **Two Fastify instances exist that the Operator did not create.** ADR-0021 chose Fastify
  for its plugin ecosystem and accepted that handing out instances makes a Fastify major
  version a breaking change for every deployment. That is unchanged: the instances are
  reachable, and only their construction is ours.
- **The Db is reached at `gateway.components.db`,** like everything else. It carries
  `migrate` and a schema-typed handle beside `start` and `stop`, and no field is hung off
  the Gateway for it. A convenience field was considered twice during design and dropped
  once the User Manager and the HTTP Messenger became Components, since the exception it
  was an exception to had gone.
