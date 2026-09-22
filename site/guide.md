# Build a shared agent

This guide builds one working deployment from nothing. At the end, a person logs in over HTTP,
sends a message, and the agent answers.

You build four components of your own: Users, Password Auth, the Messenger, and the HTTP Channel.
`createGateway` builds the infrastructure under them. The whole deployment runs as a Docker
Compose stack: PostgreSQL, the Gateway, and the agent, which you run yourself and the Gateway
connects to.

Where a step builds something the [Architecture](./architecture) page explains, it links to that
section. Read this guide first and that page second.

## Before you start

You need three things:

- **Docker**, with Compose. Every part of this deployment is a service in one stack, the agent
  included. Nothing here reaches the Docker daemon: the Gateway starts no container and is given
  no socket.
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
    "@shutter-network/concorde": "^0.1.0"
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
  "include": ["main.ts", "drizzle.config.ts", "schema.ts"]
}
```

`noEmit` is correct here. Node 24 runs TypeScript directly by removing the types, so nothing
compiles your entry point.

Then install:

```sh
npm install
```

## Step 2: Point the Runtime at the agent

The **Runtime** is what a Prompt is handed to. For each one it opens a connection to the agent,
prompts it, waits until the agent has settled, and answers with an outcome.

**It does not start the agent.** You do. The agent is a second service in the same Compose stack,
which step 9 writes, and it is yours from the image down: yours to build, yours to give a model
key to, yours to pass flags to. The Gateway is told where it is and nothing else about it.

Start `main.ts`:

```ts
import { createPiRuntime } from "@shutter-network/concorde/pi";

const runtime = createPiRuntime({
  host: process.env.AGENT_INSTANCE_HOST!,
  port: Number(process.env.AGENT_INSTANCE_PORT),
  sessionsDir: process.env.AGENT_SESSIONS_DIR!,
});
```

Three facts about this block matter.

**The package has no root export.** Every import names a subpath, such as
`@shutter-network/concorde/pi`. An import from `"@shutter-network/concorde"` resolves to nothing.

**Three values are the whole of the agent's configuration here, and there is no fourth.** No
image, no model, no provider, no credential, no flag. Every one of those is written on the agent
service in step 9, and none of them is ever given to the Gateway, the model key included.

**`sessionsDir` is a path the agent sees**, and neither a path on your host nor one inside the
Gateway container. The Gateway never opens it and does not need to be able to reach it. A Session
named `user_abc` is the file `<sessionsDir>/user_abc.jsonl` in the agent's own filesystem, which
is where you read a transcript. You write this string twice, here and as a mount target in step 9,
and nothing can check that the two agree: one end is resolved by `pi` and the other by the Docker
daemon, and neither can see the other's filesystem.

::: warning sessionsDir must be absolute, and is refused when the Gateway is built
Not at the first message. A relative path would be resolved against a working directory nothing in
this process can see, so it is refused in the file where you wrote it.
:::

::: tip An agent that is not listening is a failed message, never a failed boot
`createPiRuntime` connects to nothing and probes nothing. If the agent service is down, the
Gateway still starts and everybody can still log in and read their log; each Run fails with the
address in its message. A Gateway that refused to start over it would take every person's access
down along with the agent's.
:::

See [Architecture: the Agent Instance](./architecture#the-agent-instance).

## Step 3: Call createGateway

`createGateway` builds the infrastructure that every deployment needs: the database client, the
two HTTP servers, and the Signal Worker. It hands those four to you, and you build the rest.

Add the call to `main.ts`:

```ts
import { createGateway } from "@shutter-network/concorde/gateway";

const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL!,
  runtime,
  publicListen: { host: process.env.PUBLIC_HOST!, port: Number(process.env.PUBLIC_PORT) },
  agentListen: {
    host: process.env.AGENT_SERVER_HOST!,
    port: Number(process.env.AGENT_SERVER_PORT),
  },
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

The agent's own RPC port is the same arrangement pointing the other way, and it takes no
credential either. The private network is what protects both.
:::

::: warning Two addresses cross on that network, so both names are long
`AGENT_SERVER_HOST` and `AGENT_SERVER_PORT` here are where **this** Gateway listens for the agent.
`AGENT_INSTANCE_HOST` and `AGENT_INSTANCE_PORT` in step 2 are where the **agent** listens for this
Gateway. A short `AGENT_HOST` could be read as either one.
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
import { createHttpChannel } from "@shutter-network/concorde/http-channel";
import { createMessenger } from "@shutter-network/concorde/messenger";
import { createPasswordAuth } from "@shutter-network/concorde/password-auth";
import { createUsers } from "@shutter-network/concorde/users";

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
} from "@shutter-network/concorde/messenger";
import { templateHandler } from "@shutter-network/concorde/signals";
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
`drizzle-kit`. It takes two files.

A component's tables live on a `/schema` subpath of their own, one below the component. List the
ones your deployment runs in a `schema.ts` of your own:

```ts
export * from "@shutter-network/concorde/messenger/schema";
export * from "@shutter-network/concorde/password-auth/schema";
export * from "@shutter-network/concorde/signals/schema";
export * from "@shutter-network/concorde/users/schema";
```

This deployment names four for five: the HTTP Channel owns no tables, because it stores nothing
and queues nothing. That file is the only place the list appears, and `drizzle.config.ts` points
at it:

```ts
import { defineConfig } from "drizzle-kit";
import { is } from "drizzle-orm";
import { PgSchema } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("set DATABASE_URL to the database this deployment applies its schema to");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  schemaFilter: Object.values(schema)
    .filter((exported) => is(exported, PgSchema))
    .map((pgSchema) => pgSchema.schemaName),
  dbCredentials: { url: databaseUrl },
});
```

`schemaFilter` is derived from the barrel rather than written out, so the list stays in one place.
Every name a `/schema` subpath exports is unique across components, which is what makes one
`export *` barrel safe: each schema object carries its component's name, `usersSchema` and
`messengerSchema` and so on, and no two components declare a table under the same name.

These two files hold three traps. Each one fails quietly.

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
Six foreign keys point at `concorde_users.users.id`. The Messenger declares one, the Nostr Channel
declares two, Password Auth declares two, and Nostr Auth declares one. If you list any of those
four components without
`@shutter-network/concorde/users/schema`, the push builds a foreign key onto a table that nothing
creates.
:::

See [Architecture: data ownership](./architecture#data-ownership).

## Step 8: Write the container files

Two images, one for each of the two services that matter, and neither holds anything of the
other's.

The Gateway image runs your entry point. Write `Dockerfile`:

```dockerfile
FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY main.ts drizzle.config.ts schema.ts ./

CMD ["node", "main.ts"]
```

No Docker CLI in it, and step 9 gives it no socket to talk to one with. The Gateway starts no
container.

The agent image is the other one. Write `Dockerfile.agent`:

```dockerfile
FROM node:24-alpine

RUN apk add --no-cache curl socat

RUN npm install -g @earendil-works/pi-coding-agent@0.85.1

WORKDIR /workspace
ENV PI_CODING_AGENT_DIR=/home/agent/.pi/agent
```

`socat` is the listener the Gateway connects to, and step 9 is where it is started. `curl` is
there because `pi` ships no HTTP client, and reaching the Agent server is the agent's own shell
tool plus `curl`.

**There is no `ENTRYPOINT`.** The process this container starts is the listener, and the agent is
what the listener starts, once per connection.

Write `settings.json`, which step 9 mounts read-only into the agent:

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

Five services: the Gateway, the **Agent Instance**, PostgreSQL, a one-shot migration, and a
terminal client held behind a profile. Write `compose.yml`:

```yaml
name: my-shared-agent

x-database-url: &database-url postgres://concorde:concorde@postgres:5432/concorde

services:
  gateway:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: *database-url
      USER_PASSWORD: ${USER_PASSWORD:?copy .env.example to .env}
      PUBLIC_HOST: 0.0.0.0
      PUBLIC_PORT: "8081"
      AGENT_SERVER_HOST: 0.0.0.0
      AGENT_SERVER_PORT: "7411"
      AGENT_INSTANCE_HOST: agent
      AGENT_INSTANCE_PORT: "4000"
      AGENT_SESSIONS_DIR: /sessions
    ports:
      - "127.0.0.1:8081:8081"
    networks: [db, agent, public]
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
      agent:
        condition: service_started
    stop_grace_period: 300s

  agent:
    build:
      context: .
      dockerfile: Dockerfile.agent
    command:
      - socat
      - TCP-LISTEN:4000,reuseaddr,fork
      - EXEC:pi --mode rpc --no-approve
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:?put your model key in .env}
      AGENT_SERVER_URL: http://gateway:7411
      PI_OFFLINE: "1"
      PI_CODING_AGENT_DIR: /home/agent/.pi/agent
    volumes:
      - ./state/workspace:/workspace
      - ./state/agent:/home/agent/.pi/agent
      - ./state/sessions:/sessions
      - ./AGENTS.md:/workspace/AGENTS.md:ro
      - ./settings.json:/home/agent/.pi/agent/settings.json:ro
    networks: [agent]

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
      POSTGRES_USER: concorde
      POSTGRES_PASSWORD: concorde
      POSTGRES_DB: concorde
    volumes:
      - db:/var/lib/postgresql/data
    networks: [db]
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "concorde", "-d", "concorde"]
      interval: 3s
      timeout: 3s
      retries: 20

  tui:
    build:
      context: .
      dockerfile: Dockerfile
    profiles: [cli]
    entrypoint: ["npx", "http-client-tui"]
    environment:
      CONCORDE_GATEWAY_URL: http://gateway:8081
      CONCORDE_PASSWORD: ${USER_PASSWORD:?copy .env.example to .env}
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

**What `agent` starts is a listener, not the agent.** `socat` accepts on 4000 and starts one `pi`
per connection, and the Gateway opens one connection per Run and closes it when the agent has
settled. So a Run is still a process of its own, started for it and gone with it. What carries
over from one Run to the next is this container and the directories mounted into it, which is your
arrangement and nobody else's.

::: danger No commas in the `EXEC:` argument
A comma is `socat`'s own option separator, so a comma anywhere in the `EXEC:` argument is read as
an option rather than as part of the command, and what runs is quietly not what you wrote. For
the same reason, never add `socat`'s `stderr` option: `EXEC` wires stdin and stdout to the
socket, `pi` writes its diagnostics to stderr, and merging the two puts non-JSON into the record
stream and fails every Run.
:::

`--no-approve` is yours to pass, and this line is the only place it appears. It is the flag that
stops a Run arranging for the next one to load configuration out of the writable Workspace, and no
framework can fasten a flag to a command line it does not write. `PI_OFFLINE` is the same kind of
thing: an environment variable on this service, because there is nowhere else left for it to be.

Six further details in this file are load-bearing.

**The model key is on `agent` and on no other service.** So is the image, so are the flags, and so
are the files `pi` reads. The Gateway is given a host, a port and a directory name, and nothing
else about the agent at all.

**`AGENT_SESSIONS_DIR` and the `/sessions` mount target are the same string, written twice.**
Nothing can check that they agree, because one end is resolved by `pi` and the other by the Docker
daemon. A Session named `user_abc` is then `/sessions/user_abc.jsonl` in the agent's container and
`state/sessions/user_abc.jsonl` here, which is where you read a transcript.

**There is no healthcheck on `agent`, deliberately.** With `fork`, every connection starts a `pi`,
so a probe on an interval would boot and discard one for ever. A plain `depends_on` is enough,
because an instance that is not listening is an ordinary failed Run and not a boot failure.

**The Gateway waits on the migration** with `condition: service_completed_successfully`. The
schema exists before the first query.

**The Agent server port is never published.** Neither is the agent's. Only `8081` is, and only to
`127.0.0.1`.

**`stop_grace_period: 300s`** gives a Run in flight time to finish before Docker kills the
Gateway.

The `tui` service is a line-oriented terminal client. It ships with the framework as a `bin`, so
it needs no separate image.

::: warning Write `AGENTS.md` before you bring the stack up
Step 10 writes it, and `compose.yml` mounts it. Docker creates a missing bind source as an empty
**directory**, so a first `docker compose up` with no `AGENTS.md` beside `compose.yml` leaves you
with a directory of that name and an agent that was told nothing.
:::

Write `.env.example` last:

```
ANTHROPIC_API_KEY=
USER_PASSWORD=correct horse battery staple
```

The model key in it is the agent's, and reaches only the `agent` service.

::: warning A password in the environment is a demo affordance
This deployment reads a password from the environment so that `docker compose up` is the whole
setup. A real deployment sets a password out of band and holds none here.
:::

## Step 10: Tell the agent what it can do

`AGENTS.md` is mounted read-only into the agent's Workspace. It is the only thing that tells the
agent that the Agent server exists.

````markdown
# You are a shared agent

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
`schema.ts`, unless it owns no tables. Keep `@shutter-network/concorde/users/schema` in that
list whenever anything references it.

::: tip Every component is optional
Nothing forces you to build Users. A deployment that reaches nobody, such as one driven only by
the Scheduler, builds no Users, no Messenger, and no Channel.
:::

Read the [Architecture](./architecture) page next. It explains why these parts are separate, and
what each one guarantees.
