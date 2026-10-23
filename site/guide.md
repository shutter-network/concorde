# Build a shared agent

This guide starts with a working HTTP deployment, then explains the code you change to build
your application. A user logs in, sends a message, and receives an answer from the agent.

The deployment runs PostgreSQL, a gateway, and a pi agent instance in Docker Compose.
You need Docker with Compose, Git, and a model provider credential. The example uses Anthropic.
Node.js 24 or later is needed only if you want to run the TypeScript checks on your host.

## Run the example

Get the minimal example:

```sh
git clone https://github.com/shutter-network/concorde.git
cd concorde/examples/00_minimal
cp .env.example .env
```

Edit `.env`: set `ANTHROPIC_API_KEY` and choose `USER_PASSWORD`. Check `settings.json` for the
model and provider you want the agent instance to use.

```sh
docker compose up -d --build
docker compose logs -f gateway
```

On first startup, the application creates a user and sets its password. The gateway log prints
the user id. Copy it and open the terminal client in another terminal:

```sh
docker compose run --rm tui <user-id>
```

Type a message and press Enter. The client logs in and polls for new messages once a second.
The public server's interactive HTTP documentation is at <http://127.0.0.1:8081/docs>.

Each example is an independent npm application that installs Concorde from the registry.
You can copy this directory into your own project; it does not require the repository's source
at runtime.

Stop the stack with `docker compose down`. Data remains in the PostgreSQL volume and the local
`state/` directory. `docker compose down -v` also deletes the PostgreSQL volume; it leaves
`state/` intact.

## Find the application files

| File | What you configure |
| --- | --- |
| `main.ts` | components, signal handlers, user provisioning, lifecycle |
| `schema.ts` | Database schemas used by your components |
| `drizzle.config.ts` | Connection and schema selection for database changes |
| `compose.yml` | Processes, network access, environment, persistent storage |
| `Dockerfile` | gateway dependencies and entry point |
| `Dockerfile.agent` | pi version and tools available to the agent |
| `AGENTS.md` | Instructions the agent reads in its workspace |
| `settings.json` | Agent model and provider |

Keep your application's dependencies in its own `package.json`. Concorde imports use subpaths,
including `@shutter-network/concorde/gateway` and `@shutter-network/concorde/signals`.
The package root exports no API. Concorde declares `fastify` and `drizzle-orm` as peer dependencies. Include both in your
application's dependencies, as the example does.

## Assemble the gateway

`main.ts` connects a runtime to the agent instance and passes it to `createGateway`:

```ts
const runtime = createPiRuntime({
  host: process.env.AGENT_INSTANCE_HOST!,
  port: Number(process.env.AGENT_INSTANCE_PORT),
  sessionsDir: process.env.AGENT_SESSIONS_DIR!,
});
```

The host and port identify the RPC listener in the agent container. `sessionsDir` is an absolute
path as seen inside that container. It must match the persistent session mount in `compose.yml`.
The runtime opens one connection per run. It does not start the container or choose its model.

`createGateway` builds the db, both HTTP servers, and the signal worker. The example adds four
components in `extend`:

```ts
extend: ({ db, agentServer, publicServer, worker }) => {
  const users = createUsers({ db, agentServer, publicServer });
  const passwordAuth = createPasswordAuth({
    db,
    users,
    publicServer,
    tokenTtl: 30 * 24 * 60 * 60 * 1000,
  });
  const messenger = createMessenger({ db, users, worker, agentServer });
  const httpChannel = createHttpChannel({ db, messenger, publicServer });
  return { users, passwordAuth, messenger, httpChannel };
},
```

Users holds identities. Password auth registers the credential scheme on the public server.
The messenger records messages and emits signals. The HTTP channel registers authenticated
submission and polling routes, and connects itself to the messenger.

These components separate who a user is, how they authenticate, what they exchange with the
agent, and how messages are delivered. You can change the authentication scheme or channel
while retaining user identities and the messenger's message log. Explicit construction shows
which capabilities your deployment installs and which dependencies they receive.

Return components in dependency order. The gateway manages their startup and shutdown and
makes them available on `gateway.components`.

## Define how the agent responds

The messenger emits `messageReceivedKind` for each inbound message. The `handlers` callback
maps that kind to a signal handler. It runs after `extend`, so handlers can use your components.

Replace the example's handler with this configuration:

```ts
handlers: () => ({
  [messageReceivedKind]: templateHandler<MessageRecord>({
    template: `User {{userId}} sent this Message:

{{text}}

Reply to this User through the Gateway messaging API.`,
    session: (signal) => `user_${signal.payload.userId}`,
    data: (signal) => signal.payload,
  }),
}),
```

These names are imported in the example's `main.ts`: `messageReceivedKind` and `MessageRecord`
from `/messenger`, and `templateHandler` from `/signals`.

`templateHandler` renders one prompt from each signal. It uses strict Handlebars with HTML
escaping disabled. Missing template values fail that signal. A syntax error in the main template
fails construction, before the gateway starts.

The session name above gives each user a continuing session. Use `session: () => null` for a
fresh session on every run. This choice controls conversational continuity, not access to data.
The agent can still read other users' messages through the agent server.

For conditional behavior or several prompts, implement a signal handler directly. Its `handle`
method returns an array of prompts. An empty array skips agent execution. The optional `post`
method runs afterward and receives a failure flag. See [execution behavior](./architecture#signals-prompts-and-runs).

The mounted `AGENTS.md` tells the agent how to discover the agent server at
`$AGENT_SERVER_URL/openapi.json` and send messages. Keep those instructions consistent with the
capabilities you install. The framework does not deliver the agent's final model response to
the user automatically.

After editing `main.ts`, rebuild the gateway with `docker compose up -d --build`.
You can also check the application on your host with `npm install` followed by
`npm run typecheck`.

## Provision users from trusted code

The example provisions one user after `gateway.start()` and only when no user exists:

```ts
const { db, users, passwordAuth } = gateway.components;

if ((await users.list({ limit: 1 })).length === 0) {
  await db.tx(async (tx) => {
    const user = await users.create(tx);
    await users.setAttributes(tx, user.id, { name: "Example User" });
    await passwordAuth.setPassword(tx, user.id, password);
  });
}
```

The transaction ensures that the user, attributes, and password commit together. User creation
and credential management are programmatic API operations. Built-in agent routes do not expose
them.

Changing `USER_PASSWORD` after the first startup does not reset the stored password. Set a new
password through trusted application code when you need to change it. The example prints the
environment password on every boot; it can therefore differ from the stored password.

## Manage the database schema

The gateway does not create or migrate tables. The example's migration service applies the
selected Drizzle definitions before the gateway starts.

`schema.ts` lists the components with tables:

```ts
export * from "@shutter-network/concorde/messenger/schema";
export * from "@shutter-network/concorde/password-auth/schema";
export * from "@shutter-network/concorde/signals/schema";
export * from "@shutter-network/concorde/users/schema";
```

The HTTP channel has no tables. Keep `users/schema` when using a component with foreign keys to
users, including messenger, password auth, Nostr auth, and Nostr channel.

`drizzle.config.ts` derives `schemaFilter` from the exported PostgreSQL schemas:

```ts
schemaFilter: Object.values(schema)
  .filter((exported) => is(exported, PgSchema))
  .map((pgSchema) => pgSchema.schemaName),
```

Retain this filter: the tables live in named PostgreSQL schemas rather than `public`.
The example runs `drizzle-kit push --force` for unattended local setup. For a deployed
application, review database changes and use a migration process appropriate to your data.

## Add capabilities

Choose components according to your application:

| Goal | Change |
| --- | --- |
| Wake the agent at a scheduled time | Construct scheduler and handle `scheduleFiredKind` |
| Publish signed decisions | Construct signatures and decisions; supply a private signing key |
| Exchange messages over Nostr | Replace HTTP channel with Nostr channel and record user public keys |
| Accept signed HTTP credentials | Add Nostr auth and grant public keys to users |
| Enforce a policy during a run | Set `Prompt.context` and check `request.concordeRun` in an agent server hook |

For each component with tables, add its `/schema` subpath to `schema.ts` and apply the database
changes before startup. The repository includes separate examples for
[scheduling](https://github.com/shutter-network/concorde/tree/main/examples/01_scheduler),
[decisions](https://github.com/shutter-network/concorde/tree/main/examples/02_decisions), and
[Nostr](https://github.com/shutter-network/concorde/tree/main/examples/03_nostr).

For a custom HTTP route, register a Fastify plugin on the appropriate server before startup.
Use `publicServer.requireUser` on routes that need authentication. Describe request and response
schemas so the route appears correctly in the generated OpenAPI document. Each server serves
its own document at `/openapi.json` and an interactive reference at `/docs`.

## Prepare for deployment

The example is configured for local use. It publishes only the public server on host loopback.
Keep the agent server and the agent instance's RPC listener private: neither authenticates
callers, and both provide privileged access.

The agent container starts `socat`, which launches pi for each runtime connection. Keep pi's
stderr separate from the RPC stream. The example's `--no-approve` flag prevents loading
unapproved configuration from its writable workspace.

Persist the session directory and workspace if their contents must survive container replacement.
Keep the `AGENTS.md` bind source present before starting Compose, and mount instructions and
configuration read-only. Allow enough shutdown time for the active run; the gateway waits for
it before stopping its other components.

The minimal example gives the agent a model credential in its environment. The
[agent isolation example](https://github.com/shutter-network/concorde/tree/main/examples/04_agent_isolation)
uses a model proxy to keep that credential outside the agent container and restricts outbound
network access. Adapt its permissions and network rules to your agent's work.

Replace the demonstration password provisioning and credential logging, provide TLS and rate
limiting for the public server, and set up database backups. Review the
[trust model and deployment responsibilities](./architecture#deployment-responsibilities)
when deciding what the agent may read and do.
