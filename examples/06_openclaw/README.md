# OpenClaw example

One user exchanges messages with an agent through the HTTP channel, as in
[the minimal example](../00_minimal/), but the agent implementation is OpenClaw instead of pi.
`main.ts` constructs `createOpenClawRuntime` in place of `createPiRuntime`; everything else in
the application is the same. The example demonstrates what running OpenClaw changes for an
operator: the daemon runs continuously and serves every run, its address is authenticated with a
shared token and a device key the daemon approves once, and the operator configures the daemon's
model, tools and workspace in the daemon's own configuration file.

## What differs from running pi

- **The agent is one long-running process.** pi starts a process per run behind a `socat`
  listener. The OpenClaw daemon is one process that every run connects to over its WebSocket
  protocol, so there is no forwarder and no `socat`, and the daemon's `healthcheck` is what the
  gateway waits for.
- **The daemon's address is authenticated.** Every connection presents the daemon's shared token
  (`OPENCLAW_GATEWAY_TOKEN`, the same value in both services) and signs the daemon's challenge with
  an Ed25519 device key. The daemon refuses the first connection from a key it has not seen and
  opens a pairing request; the operator approves it once, which is the one manual step below.
  Authentication does not make the daemon safe to expose: it is as privileged as pi's listener
  and stays on the private `agent` network.
- **`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` on the gateway service.** OpenClaw's client refuses
  plaintext `ws://` to a hostname that is not an IP literal, `localhost`, `.local` or `.ts.net`.
  The gateway reaches the daemon by its Compose service name over a private Docker network, which
  is the same trust the pi examples place in that network, so the variable states that the
  plaintext is intended. A daemon reached over `wss://` needs nothing.
- **The daemon's configuration is a file, not CLI flags.** `openclaw.json` is mounted read-only
  into the daemon's state directory. It binds the daemon to every interface of its container
  (`gateway.bind: "lan"`, required for the gateway to reach it, and in turn requiring token
  auth), switches the browser control UI off, names the Anthropic provider with the key from
  `.env` and `anthropic/claude-sonnet-5` as the agent's model, declares the one agent `concorde`
  that `main.ts` names as `agentId`, and keeps the daemon from writing its own instruction files
  into the workspace (`skipBootstrap`). Its `tools` entry leaves the agent the `exec` tool and
  the daemon's session status tool and nothing else; `exec` runs commands on the daemon host,
  which is the agent container, with no approval prompt, as pi does under `--no-approve`.
  `${VAR}` in the file is resolved from the daemon's environment.
- **No channels are configured.** The daemon has channels of its own; the runtime sends every
  prompt with delivery switched off, and leaving the channels unconfigured means a reply cannot
  reach a user by a path the messenger never logged. The user hears from the agent through the
  messenger alone, as under pi.
- **The state is a Docker volume, not a `state/` directory.** The image runs as its own `node`
  user and dies at once when run as a host uid, so the daemon's state directory
  `/home/node/.openclaw` is a named volume that Docker initialises with that user's ownership.
  It holds the daemon's SQLite database, where the approved device lives, so the approval
  survives restarts of the daemon and of the whole stack.
- **The agent's instructions are the daemon's workspace file.** `AGENTS.md` is mounted read-only
  into the daemon's workspace, and the daemon injects it into every session. It names the agent
  server at `http://gateway:7411` directly, because the agent's commands run in the daemon's
  environment and not in one the gateway set up.

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

`main.ts` constructs the components and maps `messageReceivedKind` to a `templateHandler`, as the
minimal example does. Each inbound message produces one prompt that carries a fresh run tag, and
`AGENTS.md` tells the agent to send that tag as the `concorde-run-tag` header on every request to
the agent server, so the gateway attributes each request to its run. The session name includes
the user id and becomes the daemon's session key under the `concorde` agent, so later runs
continue that user's conversation on the daemon. The agent sends replies through the agent
server; its final model response is not delivered.

On the first boot, trusted application code creates the user, attributes, and password in one
transaction. Later boots retain them. Changing `USER_PASSWORD` does not update the stored
password, even though the example prints the environment value again.

`schema.ts` selects the four components with tables. The HTTP channel and the runtime have none.
Compose applies the schema before starting the gateway. Dependencies come from the npm registry,
not this checkout.

## Files and storage

- `main.ts`: component setup, the runtime, prompts, provisioning, and shutdown.
- `openclaw.json`: the daemon's configuration; `AGENTS.md`: the agent's instructions, mounted into
  the daemon's workspace.
- `insecure-example-only-device-key.pem`: the gateway's device key, mounted read-only into the
  gateway and never into the agent container.
- `compose.yml` and `Dockerfile`: gateway, the OpenClaw daemon from its published image at one
  pinned version, database, migration, and client.
- The `openclaw` volume: the daemon's state, including the approved device, the agent's sessions
  and its workspace.

Keep the agent server and the daemon private. For network and credential restrictions, see
[the isolation example](../04_agent_isolation/). The [guide](../../site/guide.md) explains the
shared deployment setup.

Stop with `docker compose down`. Add `-v` to delete the database volume and the daemon's state,
after which the device has to be approved again.
