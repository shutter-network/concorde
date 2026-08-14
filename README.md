# Concorde

A framework to build shared agents.

> **Expect breaking changes.** This is `0.1.0` and the public API is not settled. Subpaths get
> renamed, components get split, and a minor version bump can require edits in your entry point.

## What a shared agent is

A **shared agent** is an AI agent that serves several parties at once. No single party owns it,
and no party can reach it privately. The idea is set out in full in
[On Shared Agents](https://blog.shutter.network/on-shared-agents/).

Two people who share a household budget are the short example. Both talk to the same agent. Both
need to know that the agent takes no instruction from the other one in secret.

Every message into the agent and out of it goes through a **Gateway** that a trusted operator
runs. Keeping the parties off the agent itself is the reason the Gateway exists. A party with
direct access to the agent has full control of it: they can change its instructions, read and
edit its memory, and tell it things the others never see. Whatever the agent does for the other
parties is then theirs to decide, and nothing stops them from using it against the others'
rights. Through the Gateway every party gets the same one way in and one way out, and the record
of what was said sits where no party can rewrite it.

## What the framework gives you

The framework gives you the Gateway. You state what your deployment is made of, and
`createGateway` assembles and runs it.

A Gateway is a set of components. Four are core, and every deployment gets them:

- A **Db**, the PostgreSQL connection every other component stores its state through.
- A **Signal Worker** that runs the agent, one thing at a time and never two at once.
- An **Agent server**, the HTTP API the running agent calls back into.
- A **Public server**, the HTTP API the parties' own clients talk to.

Beyond the core, the framework ships components for what a particular shared agent needs. A
deployment constructs the ones it wants and leaves the rest out:

- **Users**, which is who exists, and **Password Auth** or **Nostr Auth**, which is how one of
  them proves it.
- A **Messenger**, which owns one Message log per person, and an **HTTP Channel** or a **Nostr
  Channel**, which is what reaches a person over a medium.
- **Signatures** and **Decisions**, so the agent can commit to something a third party can check.
- A **Scheduler**, so time can wake the agent.

And a deployment can add components of its own. A component is a `start` and a `stop` and nothing
more, so anything that follows that shape goes into the Gateway beside the rest, is started and
stopped with it, and can serve its own routes on either server.

![The parts of a shared agent. A dashed boundary encloses the Gateway, holding the Db, the Signal
Worker, the Agent server and the Public server, together with the Messenger and its two Channels
and Users with its two Auths. Outside it are the Agent Implementation, a person's client, and a
Nostr Relay.](./site/public/architecture.svg)

Everything inside the dashed boundary is the Gateway. The
[architecture page](https://shutter-network.github.io/concorde/architecture) reads the picture
part by part.

Some things the framework deliberately does not give you: confidentiality between the parties,
resistance to prompt injection, confinement of the agent, and rate limiting. The
[architecture page](https://shutter-network.github.io/concorde/architecture) states the full list.

## The code

Your deployment is one entry point. It builds the agent Runtime, calls `createGateway`, and
constructs the components it wants inside `extend`:

```ts
import { createGateway } from "@shutter-network/concorde/gateway";
import { createHttpChannel } from "@shutter-network/concorde/http-channel";
import {
  createMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "@shutter-network/concorde/messenger";
import { createPasswordAuth } from "@shutter-network/concorde/password-auth";
import { createPiRuntime } from "@shutter-network/concorde/pi";
import { templateHandler } from "@shutter-network/concorde/signals";
import { createUsers } from "@shutter-network/concorde/users";

const tokenTtl = 30 * 24 * 60 * 60 * 1000;

const runtime = createPiRuntime({
  image: process.env.AGENT_IMAGE!,
  env: { AGENT_SERVER_URL: process.env.AGENT_SERVER_URL! },
  networks: [process.env.AGENT_NETWORK!],
  mounts: {
    runtimeDir: process.env.RUNTIME_DIR_HOST!,
    entries: [
      { agentPath: "/workspace", path: "state/workspace" },
      { agentPath: "/workspace/AGENTS.md", path: "AGENTS.md", readOnly: true },
    ],
  },
});

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL!,
  runtime,
  publicListen: {
    host: process.env.PUBLIC_HOST!,
    port: Number(process.env.PUBLIC_PORT),
  },
  agentListen: {
    host: process.env.AGENT_HOST!,
    port: Number(process.env.AGENT_PORT),
  },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, agentServer, publicServer });
    const passwordAuth = createPasswordAuth({
      db,
      users,
      publicServer,
      tokenTtl,
    });
    const messenger = createMessenger({ db, users, worker, agentServer });
    const httpChannel = createHttpChannel({ db, messenger, publicServer });
    return { users, passwordAuth, messenger, httpChannel };
  },
  handlers: () => ({
    [messageReceivedKind]: templateHandler<MessageRecord>({
      template: `A message arrived for you from user {{userId}}. They said:

{{text}}

Answer them by sending them a Message. Your final reply here reaches nobody.`,
      session: (signal) => `user_${signal.payload.userId}`,
      data: (signal) => signal.payload,
    }),
  }),
});

await gateway.start();
```

That is close to the whole of a working deployment. It waits for a message, and runs the agent in
a container each time one arrives. What
[`examples/00_minimal/main.ts`](./examples/00_minimal/main.ts) adds to it is the block that seeds
the first person and a signal handler for shutdown.

Each component is its own import subpath, and the package root exports nothing. A component that
owns tables ships them on a `/schema` subpath, which your own `drizzle.config.ts` applies. Your
deployment owns its migrations; the framework applies no DDL.

## Examples

[`examples/`](./examples/) holds four deployments. Each is a self-contained npm application with
its own Compose stack, and each runs with `cp .env.example .env` and
`docker compose up -d --build` from its own directory. They resolve the framework from the
registry, so an example's import lines are the lines you write.

| Example                                    | What it shows                                           |
| ------------------------------------------ | ------------------------------------------------------- |
| [`00_minimal`](./examples/00_minimal/)     | One person talking to the agent over HTTP               |
| [`01_scheduler`](./examples/01_scheduler/) | Time waking the agent, with no Users component at all   |
| [`02_decisions`](./examples/02_decisions/) | Two people, and a signed log both of them read          |
| [`03_nostr`](./examples/03_nostr/)         | Messaging over Nostr, against a Relay in the same stack |

Start with `00_minimal`. They are four independent examples and not a ladder.

## Documentation

The [documentation site](https://shutter-network.github.io/concorde/) is the place to read next:

- [Build a shared agent](https://shutter-network.github.io/concorde/guide) — one deployment, step
  by step.
- [Architecture](https://shutter-network.github.io/concorde/architecture) — what the parts are and
  why they are separate.
- [API reference](https://shutter-network.github.io/concorde/reference/) — the exact signature of
  every export, the tables each component creates, and the routes each one serves.

## Work on the framework

```sh
mise install    # the pinned Node version
npm ci
docker run -d --name concorde-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
npm run check   # typecheck, build, lint, test
```

PostgreSQL is real in every test and nothing about the database is mocked, so that container is a
prerequisite rather than an extra. `CLAUDE.md` is the full account of the toolchain.
