# Nostr messaging example

Alice and Bob exchange encrypted direct messages with one agent through a relay in the Compose
stack. The Nostr channel handles delivery; the messenger stores the durable message logs.

Users are provisioned with public keys from trusted application code. Messages from other keys
are dropped. This example installs no HTTP auth or HTTP channel.

## Run

You need Docker with Compose and an Anthropic API key. From this directory:

```sh
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env`. The included Nostr keys are public demonstration keys; use
new keys and matching public keys before connecting real users or an external relay.

```sh
docker compose up -d --build
docker compose logs -f gateway
```

The log prints the agent's public key and both user ids. Send a message from another terminal:

```sh
docker compose run --rm nak-alice "What should I work on today?"
```

For Bob, open another terminal:

```sh
docker compose run --rm nak-bob "What should I work on today?"
```

Each command sends the text, then streams incoming messages as JSON. Run it without an argument
to listen only. Press Ctrl-C to stop listening.

## How it works

`main.ts` creates users, the messenger, and a Nostr channel. On first startup, it creates Alice
and Bob and records their public keys in one transaction. Later changes to the environment keys
do not update existing mappings.

`send.sh` uses `nak` to create a kind-14 message, seal and gift-wrap it, and publish it to the
relay. It then subscribes for the recipient's gift wraps and decrypts them. The gateway records
valid inbound messages only for known keys. The agent replies through the messaging API, and the
channel queues encrypted outbound envelopes for the relay.

Relay acceptance does not confirm that a recipient read a message. Session files are in
`state/sessions/`; the database holds the message logs.

## Configuration

- `schema.ts` includes signals, users, messenger, and Nostr channel tables.
- `strfry.conf` disables the image's default write-policy plugin, whose sample whitelist would
  otherwise reject this example's writes. The gateway still checks sender keys.
- The local relay is published at `ws://127.0.0.1:7777`.
- The public server at <http://127.0.0.1:8083/docs> has no application routes.
- `AGENTS.md` tells the agent to answer only the user who sent the triggering message.

Nostr channel mappings authorize messaging. They do not grant HTTP authentication through Nostr
auth, which is a separate component.

See [the guide](../../site/guide.md) for the shared container setup. This example installs the
library from the npm registry, not this checkout.

Stop with `docker compose down`. Add `-v` to delete the database volume; local `state/` files remain.
