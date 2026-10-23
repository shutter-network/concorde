# Minimal HTTP example

One user exchanges messages with an agent through the HTTP channel. The application combines
users, password auth, a messenger, and an HTTP channel with one message handler.

## Run

You need Docker with Compose and an Anthropic API key. From this directory:

```sh
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` and choose `USER_PASSWORD` in `.env`. Check the model in `settings.json`.

```sh
docker compose up -d --build
docker compose logs -f gateway
```

Copy the user id from the log, then run the client in another terminal:

```sh
docker compose run --rm tui <user-id>
```

Type a line to send it. The client polls for new messages once a second. Press Ctrl-C to exit.
The public API documentation is at <http://127.0.0.1:8081/docs>.

## How it works

`main.ts` constructs the components and maps `messageReceivedKind` to a `templateHandler`.
Each inbound message produces one prompt. The session name includes the user id, so later runs
continue that user's session. The agent sends replies through the agent server; its final model
response is not delivered automatically.

On the first boot, trusted application code creates the user, attributes, and password in one
transaction. Later boots retain them. Changing `USER_PASSWORD` does not update the stored
password, even though the example prints the environment value again.

`schema.ts` selects the four components with tables. The HTTP channel has none. Compose applies
the schema before starting the gateway. Dependencies come from the npm registry, not this checkout.

## Files and storage

- `main.ts`: component setup, prompts, provisioning, and shutdown.
- `AGENTS.md`: mounted agent instructions; `settings.json`: model configuration.
- `compose.yml` and the Dockerfiles: gateway, pi RPC listener, database, migration, and client.
- `state/workspace/` and `state/sessions/`: persistent agent files and session records.

Keep the agent server and RPC listener private. For network and credential restrictions, see
[the isolation example](../04_agent_isolation/). The [guide](../../site/guide.md) explains the
shared deployment setup.

Stop with `docker compose down`. Add `-v` to delete the database volume; local `state/` files remain.
