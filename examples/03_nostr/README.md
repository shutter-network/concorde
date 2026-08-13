# 03_nostr

Two people talking to one agent over Nostr, against a relay this stack runs. It shows:

- **The Nostr Channel.** The Messenger owns the Message log and reaches nobody; the Channel is
  what reaches a person, and here it exchanges NIP-17 private direct messages over one relay.
  It registers no route, and no Auth is built here either, so the only thing on the Public
  server is the API document.
- **A third-party client.** `nak` is written by the author of the NIPs, so a round trip through
  it says something about NIP-17 conformance rather than about our two halves agreeing.
- **Admission by preregistered public key.** `main.ts` records Alice's and Bob's public keys
  from trusted code. A message from anybody else is dropped, with nothing stored for it, and no
  route anywhere admits a stranger.
- **The Operator never sees a secret.** `main.ts` reads the two **public** keys. Each secret
  goes to that person's own `nak` container and nowhere else.
- **A Channel with tables of its own.** The other Channel that ships has none.
  `schema.ts` is four specifiers wide because of the three in `concorde_nostr_channel`, two of
  which reference `concorde_users.users.id`. `users` is in that list although nobody logs in here:
  leave it out and the push builds a foreign key onto a table nothing creates.

**This example is less pleasant to use than the other three, and that is deliberate.** No
terminal client does NIP-17, so talking to the agent is a script and a stream of JSON rather
than a chat window; writing the missing client is larger than everything else here combined.

## Run it

```sh
cp .env.example .env   # then put your Anthropic API key in it
docker compose up -d --build
docker compose logs -f gateway
```

The Gateway prints the agent's public key and both User ids on every boot.

Then say something, in a second terminal. It sends, and then it stays open and prints whatever
the agent says back:

```sh
docker compose run --rm nak-alice "what is on my plate today?"
docker compose run --rm nak-bob "and what about mine?"
```

Run either with no argument to listen and say nothing. Ctrl-C stops listening.

```sh
docker compose down -v
```

## Look around

- `main.ts` is the whole deployment: the Runtime, three components, one Handler, the prompt that
  Handler renders, and the seeding block that creates both people and admits them in one
  transaction.
- `send.sh` is the pipeline `nak-alice` and `nak-bob` run: a kind 14 rumor, sealed and gift
  wrapped, handed to the relay, and then a subscription for wraps coming the other way.
- `strfry.conf` is the relay image's own `/etc/strfry.conf.default` with one line changed:
  `writePolicy.plugin` is empty. The shipped value names a script whose whitelist holds
  placeholder pubkeys, so a relay started on it looks healthy and rejects every write. Read the
  template it came from with
  `docker run --rm --entrypoint cat dockurr/strfry:1.1.1 /etc/strfry.conf.default`.
- The relay is published at `ws://127.0.0.1:7777`, so your own tooling can reach it. Nothing in
  this stack needs that: every container reaches it by service name.
- The Gateway describes its own HTTP API at <http://127.0.0.1:8083/docs>.
- `AGENTS.md` is mounted read-only into the agent's Workspace and tells it that a Message it
  sends travels as an encrypted direct message to somebody's Nostr client.

## The keys are worthless

All three keypairs in `.env.example` are committed to this repository, so everyone who has read
it can be the agent, be Alice and be Bob. They are there so that `docker compose up` is the
whole setup. Generate your own before any of this reaches a real relay.
