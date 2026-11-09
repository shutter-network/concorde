# OpenClaw example

One user exchanges messages through the HTTP channel, as in
[the minimal example](../00_minimal/). This version uses the OpenClaw daemon as its agent
implementation.

The daemon runs continuously and accepts authenticated WebSocket connections. Each run presents
a shared token and signs a challenge with a device key. You approve the device once using the
steps below.

`openclaw.json` configures the daemon's model, tools, and workspace. The agent can execute
commands inside the daemon's container without an approval prompt. Its instructions come from
`AGENTS.md`, mounted in the workspace. OpenClaw's own channels are left unconfigured; messages
reach users through the messenger.

Compose sets `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` on the gateway so the client accepts the
daemon's `ws://` address by service name on the private Docker network. Use `wss://` outside
a private network. The daemon's state is kept in a named volume owned by its container user.

## Generate your own device key

The committed `insecure-example-only-device-key.pem` is for demonstration only. Replace it before
using this deployment for anything real:

```sh
openssl genpkey -algorithm ed25519 -out insecure-example-only-device-key.pem
```

The gateway reads the mounted PEM file. Replacing the key creates a new device that needs
its own approval.

## Run

You need Docker with Compose and an Anthropic API key. From this directory:

```sh
cp .env.example .env
```

Set `ANTHROPIC_API_KEY`, choose `USER_PASSWORD`, and choose `OPENCLAW_GATEWAY_TOKEN` in `.env`.
Check the model in `openclaw.json`.

```sh
docker compose up -d --build
docker compose logs -f gateway
```

Copy the user id from the log, then run the client in another terminal:

```sh
docker compose run --rm tui <user-id>
```

### Approve the device once

The run for your first message fails until the device is approved. Find the pairing request id
in the gateway log:

```text
Cannot connect to the OpenClaw daemon at ws://agent:18789: this Gateway's device key is not
approved yet. On the daemon host run `openclaw devices approve <requestId>` ...
```

You can also find the request id in the daemon's pending requests:

```sh
docker compose exec agent node openclaw.mjs devices list --json
```

Approve it:

```sh
docker compose exec agent node openclaw.mjs devices approve <requestId> --json
```

The approval grants `operator.read` and `operator.write`. Send your message again; failed runs
are not retried. Approval survives restarts, but replacing the key or deleting the daemon's
state volume requires another approval.

The public API documentation is at <http://127.0.0.1:8086/docs>.

## How it works

Each inbound message produces a prompt with a fresh run tag. The agent sends that tag as the
`concorde-run-tag` header so the agent server can attribute requests to the run. Session names
include the user id, preserving each user's session across runs. The agent sends replies through
the messenger; final model responses are not delivered to users.

On the first boot, trusted application code creates the user, attributes, and password in one
transaction. Later boots retain them. Changing `USER_PASSWORD` does not update the stored
password, even though the example prints the environment value again.

`schema.ts` selects the four components with tables. The HTTP channel and the runtime have none.
Compose applies the schema before starting the gateway. Dependencies come from the npm registry,
not this checkout.

## Files and storage

The `openclaw` volume holds device approvals, sessions, and the workspace. The database uses a
separate `db` volume. The device key is mounted only into the gateway.

Keep the agent server and the daemon private. For network and credential restrictions, see
[the isolation example](../04_agent_isolation/). The [guide](../../site/guide.md) explains the
shared deployment setup.

Stop with `docker compose down`. Add `-v` to delete the database volume and the daemon's state,
after which the device has to be approved again.
