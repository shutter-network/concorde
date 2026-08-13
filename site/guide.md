# Build a Shared Agent

This guide builds one working deployment from nothing. At the end, a person logs in over HTTP,
sends a message, and the agent answers.

You build four components of your own: Users, Password Auth, the Messenger, and the HTTP Channel.
`createGateway` builds the infrastructure under them. The whole deployment runs as a Docker
Compose stack with PostgreSQL.

Where a step builds something the [Architecture](./architecture) page explains, it links to that
section. Read this guide first and that page second.

## Before you start

You need three things:

- **Docker**, with Compose. The Gateway starts the agent in a container, so it holds the host's
  Docker socket.
- **Node.js 24 or later**, for the type check. The stack itself runs in containers.
- **An API key for a model provider.** This guide uses Anthropic.

You do not need a PostgreSQL server on your host. The stack runs one.

::: tip A deployment is your own npm application
The framework is a library. Your deployment is a separate npm package that depends on it. It is
not a fork, a template, or a plugin. You own the entry point.
:::

## Step 1: Make the project

Make a directory and write `package.json` into it:

```json
{
  "name": "my-shared-agent",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "migrate": "drizzle-kit push --force",
    "start": "node main.ts"
  },
  "dependencies": {
    "drizzle-orm": "^0.45.2",
    "fastify": "^5.11.0",
    "shared-agent-framework": "^0.3.0"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "drizzle-kit": "^0.31.10",
    "typescript": "^7.0.2"
  }
}
```

`fastify` and `drizzle-orm` are both peer dependencies, so your package declares them.
`drizzle-kit` is yours alone, and step 7 applies the database schema with it.

Write `tsconfig.json` beside it:

```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["main.ts", "drizzle.config.ts"]
}
```

`noEmit` is correct here. Node 24 runs TypeScript directly by removing the types, so nothing
compiles your entry point.

Then install:

```sh
npm install
```

## Step 2: Build the Runtime

The **Runtime** is what a Prompt is handed to. It starts the agent, waits for it, and answers
with an outcome. This deployment runs `pi` in a container.

Start `main.ts`:

```ts
import { createPiRuntime } from "shared-agent-framework/pi";

const runtime = createPiRuntime({
  image: process.env.AGENT_IMAGE!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    AGENT_SERVER_URL: process.env.AGENT_SERVER_URL!,
  },
  networks: [process.env.AGENT_NETWORK!],
  mounts: {
    runtimeDir: process.env.RUNTIME_DIR_HOST!,
    entries: [
      { agentPath: "/workspace", path: "state/workspace" },
      { agentPath: "/home/agent/.pi/agent", path: "state/agent" },
      { agentPath: "/workspace/AGENTS.md", path: "AGENTS.md", readOnly: true },
      { agentPath: "/home/agent/.pi/agent/settings.json", path: "settings.json", readOnly: true },
    ],
  },
});
```

Three facts about this block matter.

**The package has no root export.** Every import names a subpath, such as
`shared-agent-framework/pi`. An import from `"shared-agent-framework"` resolves to nothing.

**Only the environment you name here reaches the agent.** None of the Gateway's own environment
is passed through.

**`runtimeDir` is a path on the host, not in the Gateway container.** The Docker daemon resolves
a bind source on the host. Each entry's `path` is written relative to `runtimeDir`.

::: warning A leading slash on an entry is refused
Write `path: "state/workspace"`, never `path: "/state/workspace"`. The framework joins the entry
onto `runtimeDir`, so a leading slash resolves against the root a second time. Construction fails
with a message that names the entry.
:::

See [Architecture: the Runtime](./architecture#the-runtime-and-the-agent-implementation).

## Step 3: Call createGateway

`createGateway` builds the infrastructure that every deployment needs: the database client, the
two HTTP servers, and the Signal Worker. It hands those four to you, and you build the rest.

Add the call to `main.ts`:

```ts
import { createGateway } from "shared-agent-framework/gateway";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL!,
  runtime,
  publicListen: { host: process.env.PUBLIC_HOST!, port: Number(process.env.PUBLIC_PORT) },
  agentListen: { host: process.env.AGENT_HOST!, port: Number(process.env.AGENT_PORT) },
  extend: ({ db, agentServer, publicServer, worker }) => {
    // step 4 fills this in
    return {};
  },
  handlers: () => ({
    // step 5 fills this in
  }),
});
```

There are two servers, and the difference between them is the whole trust boundary.

| Server | Who reaches it | Authentication |
| --- | --- | --- |
| **Public server** | People, over the network | Every registered Auth |
| **Agent server** | The Agent Implementation only | **None at all** |

::: danger The Agent server has no authentication
Reaching the Agent server port is full read and write access to every route on it. Bind it where
only the agent can reach it. In this stack it is published to nobody, and the agent reaches it by
service name on a private Docker network.
:::

`createGateway` connects to nothing and listens on nothing. That happens in step 6, at
`gateway.start()`.

See [Architecture: the Gateway](./architecture#the-gateway).

## Step 4: Choose your components

`extend` is where you build the components this deployment wants. Each is one `create*` call,
wired from the four infrastructure components you were handed.

Fill in `extend`:

```ts
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, agentServer, publicServer });
    const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl });
    const messenger = createMessenger({ db, users, worker, agentServer });
    const httpChannel = createHttpChannel({ db, messenger, publicServer });
    return { users, passwordAuth, messenger, httpChannel };
  },
```

Add the imports and the token lifetime at the top of `main.ts`:

```ts
import { createHttpChannel } from "shared-agent-framework/http-channel";
import { createMessenger } from "shared-agent-framework/messenger";
import { createPasswordAuth } from "shared-agent-framework/password-auth";
import { createUsers } from "shared-agent-framework/users";

const tokenTtl = 30 * 24 * 60 * 60 * 1000;
```

1. **Users** owns who exists. It takes no component as an argument.
2. **Password Auth** takes `users`, and registers itself with the Public server as an Auth.
3. **The Messenger** takes `users`, owns the Message log, and reaches nobody.
4. **The HTTP Channel** takes `messenger`, and is what reaches a person.

**Two orderings are forced**, because a constructor takes the finished component. Users comes
before Password Auth and before the Messenger. The Messenger comes before its Channel. Password
Auth and the Messenger take nothing from each other, so those two lines can trade places.

The Messenger and the Channel are two components on purpose. The Messenger owns the log. A
Channel delivers over one medium. To speak a different medium, you build a different Channel and
change nothing else.

::: tip Components register themselves
A component handed a server registers its routes inside its own constructor. There is no plugin
system, no registry, and no dependency resolution. You pass the parts to each other.
:::

See [Architecture: core components](./architecture#core-components).

## Step 5: Write the Signal Handler

A **Signal** is an arrival record. An inbound Message makes the Messenger write one. The Signal
Worker takes each Signal and dispatches on its `kind` to exactly one **Signal Handler**.

A Handler turns a Signal into zero or more **Prompts**. Fill in `handlers`:

```ts
  handlers: () => ({
    [messageReceivedKind]: templateHandler<MessageRecord>({
      template: `A message arrived for you from user {{userId}}. They said:

{{text}}

Answer them by sending them a Message. Your final reply here reaches nobody.`,
      session: (signal) => `user_${signal.payload.userId}`,
      data: (signal) => signal.payload,
    }),
  }),
```

Extend the messenger import to carry the kind and the record type:

```ts
import {
  createMessenger,
  type MessageRecord,
  messageReceivedKind,
} from "shared-agent-framework/messenger";
import { templateHandler } from "shared-agent-framework/signals";
```

`session` decides which conversation the Prompt continues. This one gives each person a Session
of their own, so the agent remembers that person and no other.

`template` takes Handlebars **source**, never a file path. It compiles when the Gateway is built.
A template with a typo fails at construction, not at the first message.

::: warning A failed Signal is never retried
There is no retry and no dead-letter queue. If a Handler throws, that Signal is dead and the
person gets nothing. Handle failure in the optional `post` phase, which runs after every Run and
is told whether any of them failed.
:::

See [Architecture: Signals, Runs, and Handlers](./architecture#signals-runs-and-handlers).

## Step 6: Start, seed, and stop

`createGateway` returns a Gateway that has started nothing. Add the rest of `main.ts`:

```ts
await gateway.start();

const { db, users, passwordAuth } = gateway.components;

if ((await users.list({ limit: 1 })).length === 0) {
  await db.tx(async (tx) => {
    const user = await users.create(tx);
    await users.setAttributes(tx, user.id, { name: "the one person here" });
    await passwordAuth.setPassword(tx, user.id, password);
  });
}

for (const user of await users.list()) {
  console.log(`user ${user.id} logs in with the password ${password}`);
}

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
```

Read the password from the environment at the top of the file:

```ts
const password = process.env.USER_PASSWORD!;
```

The seeding block creates the person and sets the password **in one transaction**. A User that
nobody can log in as never reaches the table. The empty-list guard means a restart keeps the id
you copied.

Creating a User and setting a password are **methods, never routes**. The agent cannot call them.
An agent that can create a User and give it a credential has made itself an account.

`gateway.stop()` stops the components in the reverse of the order they started. The Signal Worker
drains first, so a Run in flight finishes.

See [Architecture: start order](./architecture#start-order).

## Step 7: Apply the database schema

**The framework applies no DDL.** It ships schema definitions, and you apply them with your own
`drizzle-kit`. Write `drizzle.config.ts`:

```ts
import { createRequire } from "node:module";
import { defineConfig } from "drizzle-kit";
import { is } from "drizzle-orm";
import { PgSchema } from "drizzle-orm/pg-core";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("set DATABASE_URL to the database this deployment applies its schema to");
}

const requireFrom = createRequire(import.meta.url);

const specifiers = ["users", "password-auth", "messenger", "signals"].map(
  (component) => `shared-agent-framework/${component}/schema`,
);

const schema = specifiers.map((specifier) => requireFrom.resolve(specifier));

const schemaFilter = specifiers
  .flatMap((specifier) => Object.values(requireFrom(specifier)))
  .filter((exported) => is(exported, PgSchema))
  .map((pgSchema) => pgSchema.schemaName);

export default defineConfig({
  dialect: "postgresql",
  schema,
  schemaFilter,
  dbCredentials: { url: databaseUrl },
});
```

A component's tables live on a `/schema` subpath of their own, one below the component. You list
the components your deployment runs. This deployment names four for five: the HTTP Channel owns
no tables, because it stores nothing and queues nothing.

This file holds three traps. Each one fails quietly.

::: danger Never remove --force from the migrate command
`drizzle-kit push` asks about a destructive statement on a terminal. A Compose one-shot has no
terminal. Without `--force` it applies nothing and **exits 0**. The Gateway then starts on that
success, and every query fails.
:::

::: danger Never remove schemaFilter
A configuration with no `schemaFilter` filters both sides of the difference down to `public`. It
finds no difference, creates not one table, and exits 0.
:::

::: danger List users/schema whenever you list a component that references it
Six foreign keys point at `saf_users.users.id`. The Messenger declares one, the Nostr Channel
declares two, Password Auth declares two, and Nostr Auth declares one. If you list any of those
four components without
`shared-agent-framework/users/schema`, the push builds a foreign key onto a table that nothing
creates.
:::

::: tip Why createRequire and not import.meta.resolve
`drizzle-kit` reads this configuration by registering `tsx` and calling `require` on it. The file
therefore runs as CommonJS, where `import.meta.resolve` is not a function. This shape looks like
an old spelling. Do not modernize it.
:::

See [Architecture: data ownership](./architecture#data-ownership).

## Step 8: Write the container files

The Gateway image runs your entry point and holds the Docker CLI. Write `Dockerfile`:

```dockerfile
FROM node:24-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY main.ts drizzle.config.ts ./

CMD ["node", "main.ts"]
```

The agent image is separate. Write `Dockerfile.agent`:

```dockerfile
FROM node:24-alpine

RUN apk add --no-cache curl

RUN npm install -g @earendil-works/pi-coding-agent@0.83.0

WORKDIR /workspace
ENV PI_CODING_AGENT_DIR=/home/agent/.pi/agent

ENTRYPOINT ["pi"]
```

`curl` is there because the agent reads the Agent server's own API document with it.

Write `settings.json`, which step 2 mounts read-only into the agent:

```json
{
  "defaultModel": "claude-sonnet-5",
  "defaultProvider": "anthropic"
}
```

Write `.dockerignore`:

```
node_modules
state
.env
```

## Step 9: Write the Compose stack

The stack has five services: PostgreSQL, a one-shot migration, the agent image build, the
Gateway, and a terminal client held behind a profile. Write `compose.yml`:

```yaml
name: my-shared-agent

x-database-url: &database-url postgres://saf:saf@postgres:5432/saf

services:
  gateway:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:?put your model key in .env}
      DATABASE_URL: *database-url
      USER_PASSWORD: ${USER_PASSWORD:?copy .env.example to .env}
      PUBLIC_HOST: 0.0.0.0
      PUBLIC_PORT: "8081"
      AGENT_HOST: 0.0.0.0
      AGENT_PORT: "7411"
      AGENT_SERVER_URL: http://gateway:7411
      AGENT_IMAGE: my-shared-agent-agent:0.83.0
      AGENT_NETWORK: my_shared_agent_agent
      RUNTIME_DIR_HOST: ${PWD}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./state/workspace:/app/state/workspace
      - ./state/agent:/app/state/agent
    ports:
      - "127.0.0.1:8081:8081"
    networks: [db, agent, public]
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
      agent-image:
        condition: service_completed_successfully
    stop_grace_period: 300s

  migrate:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["npx", "drizzle-kit", "push", "--force"]
    environment:
      DATABASE_URL: *database-url
    restart: "no"
    networks: [db]
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: saf
      POSTGRES_PASSWORD: saf
      POSTGRES_DB: saf
    volumes:
      - db:/var/lib/postgresql/data
    networks: [db]
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "saf", "-d", "saf"]
      interval: 3s
      timeout: 3s
      retries: 20

  agent-image:
    build:
      context: .
      dockerfile: Dockerfile.agent
    image: my-shared-agent-agent:0.83.0
    command: ["--version"]
    restart: "no"
    networks: [agent]

  tui:
    build:
      context: .
      dockerfile: Dockerfile
    profiles: [cli]
    entrypoint: ["npx", "http-client-tui"]
    environment:
      SAF_GATEWAY_URL: http://gateway:8081
      SAF_PASSWORD: ${USER_PASSWORD:?copy .env.example to .env}
    networks: [public]

networks:
  db:
    name: my_shared_agent_db
  agent:
    name: my_shared_agent_agent
  public:
    name: my_shared_agent_public

volumes:
  db:
```

Four details in this file are load-bearing.

**`RUNTIME_DIR_HOST: ${PWD}`.** The Gateway cannot in general reach that directory itself. It
hands the path to the Docker daemon, which resolves it on the host. If you bring the stack up
from another directory, the agent's mounts resolve against a tree nobody is looking at.

**The Gateway waits on the migration** with `condition: service_completed_successfully`. The
schema exists before the first query.

**The Agent server port is never published.** Only `8081` is, and only to `127.0.0.1`.

**`stop_grace_period: 300s`** gives a Run in flight time to finish before Docker kills the
Gateway.

The `tui` service is a line-oriented terminal client. It ships with the framework as a `bin`, so
it needs no separate image.

Write `.env.example` last:

```
ANTHROPIC_API_KEY=
USER_PASSWORD=correct horse battery staple
```

::: warning A password in the environment is a demo affordance
This deployment reads a password from the environment so that `docker compose up` is the whole
setup. A real deployment sets a password out of band and holds none here.
:::

## Step 10: Tell the agent what it can do

`AGENTS.md` is mounted read-only into the agent's Workspace. It is the only thing that tells the
agent that the Agent server exists.

````markdown
# You are a Shared Agent

One person talks to you here, and you act for them through a Gateway that mediates everything
into and out of you. Be brief.

## The Gateway's Agent server

`$AGENT_SERVER_URL`, which your shell tool has in its environment. It is reachable with `curl`
and takes no credential. Read it before you use it:

```sh
curl -s $AGENT_SERVER_URL/openapi.json
```

That document is generated from the routes this Gateway registered, so it is the truth about
what you can call. This file is written by hand and can be out of date.

## Reaching a person

`POST /messages` with `{"userId": "...", "text": "..."}` is the only thing you can do that
leaves the Gateway. Your final reply is read by nobody.

**Take the `userId` out of the Signal that woke you.** Never assemble one.

They read you in a line-oriented terminal, so write plain sentences: no headings, no tables, no
code blocks.
````

The agent reads the Gateway's own OpenAPI document, so `AGENTS.md` never lists routes. Both
servers describe themselves, and that document is generated from the routes each component
registered.

## Run it

```sh
cp .env.example .env      # then put your model key in it
docker compose up -d --build
docker compose logs -f gateway
```

The Gateway prints the User id and the password on every boot:

```
user 0f5c1b3a-... logs in with the password correct horse battery staple
```

Talk to it in a second terminal, with the id it printed:

```sh
docker compose run --rm tui 0f5c1b3a-...
```

Type a line and press enter. The client logs in, prints the log, and asks for new Messages once a
second. The answer arrives a moment after the Run finishes.

The Public server describes itself at <http://127.0.0.1:8081/docs>.

To stop and remove the data:

```sh
docker compose down -v
```

## What to change next

Now that one deployment works, each of these is a small change to `main.ts`:

| Goal | What to do |
| --- | --- |
| Wake the agent on a timer | Build the **Scheduler**, and write a Handler for its one kind. |
| Let the agent commit to something | Build **Signatures** and **Decisions**, and load a signing key. |
| Speak a different medium | Build the **Nostr Channel** in place of the HTTP Channel. |
| Accept a second credential | Build **Nostr Auth** beside Password Auth. |
| Add a route of your own | Register a Fastify plugin on either server. |

Remember two rules when you add a component. Add its `/schema` specifier to
`drizzle.config.ts`, unless it owns no tables. Keep `shared-agent-framework/users/schema` in that
list whenever anything references it.

::: tip Every component is optional
Nothing forces you to build Users. A deployment that reaches nobody, such as one driven only by
the Scheduler, builds no Users, no Messenger, and no Channel.
:::

Read the [Architecture](./architecture) page next. It explains why these parts are separate, and
what each one guarantees.
