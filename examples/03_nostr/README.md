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

## The two services

This deployment is two containers that matter, and the Gateway is one of them. `gateway` serves
the people and decides what the agent is asked; `agent` is the **Agent Instance**, which the
Operator runs and the Gateway merely connects to. Nothing here mounts a container runtime
socket and no host path is written anywhere, so the Gateway cannot start a container and has no
name for a directory the Docker daemon would resolve. That is the whole arrangement: the
Gateway holds a TCP address and nothing else about the agent.

What `agent` starts is a listener rather than the agent:

```yaml
    command:
      - socat
      - TCP-LISTEN:4000,reuseaddr,fork
      - EXEC:pi --mode rpc --no-approve
```

`fork` means one `pi` process per TCP connection, and the Gateway opens one connection per Run
and closes it when the agent has settled. So a Run is still a process of its own, started for it
and gone with it; what carries over from one Run to the next is this container and the
directories mounted into it, which is the Operator's arrangement and nobody else's. Four things
in those three lines are load-bearing:

- **No commas may appear in the `EXEC:` argument.** Comma is `socat`'s own option separator, so
  a comma anywhere in it is read as an option rather than as part of the command, and what runs
  is quietly not what was written. The command is a list and not a string for the neighbouring
  reason: no shell is involved, and `socat` splits `EXEC:` on spaces itself.
- **`--no-approve` is the Operator's to pass**, and this line is the only place it now appears.
  It is the flag that stops a Run arranging for the next one to load configuration out of the
  writable Workspace, and the framework cannot fasten it to a command line it does not write.
- **`PI_OFFLINE` was a framework default** back when the framework started the container. It is
  an environment variable in this file now, and there is nowhere else left for it to be.
- **`socat`'s `stderr` option must never be added.** `EXEC` wires stdin and stdout to the
  socket, and `pi` writes its diagnostics to `socat`'s stderr; merging the two puts non-JSON
  into the record stream and fails every Run.

`Dockerfile.agent` is that container's image: `pi` at a pinned version, `socat` to listen with,
and `curl`, because `pi` ships no HTTP client and reaching the Agent server is the agent's own
shell tool plus `curl`. It declares no `ENTRYPOINT`, since the process this container starts is
the listener and the agent is what the listener starts.

**There is no healthcheck on `agent`, deliberately.** With `fork`, every connection starts a
`pi`, so a probe on an interval would boot and discard one for ever. A plain `depends_on` is
enough: an instance that is not listening is an ordinary failed Run carrying the address, not a
boot failure, and a Gateway that refused to start over it would take every other Party's access
down with the agent's.

**The agent's environment is the Operator's, whole.** The image, the model credential, the files
`pi` reads, the flags it is started with: every one of them is written on `agent` in
`compose.yml`, and the Gateway is given none of it. `ANTHROPIC_API_KEY` is set there and in no
other service. `AGENTS.md` and `settings.json` are mounted read-only out of this directory,
which is how the agent learns that the Agent server exists and which model to talk to, and
mounting them read-only is what keeps a Run from rewriting the instructions the next Run reads.

**The Gateway is told three things about the instance and nothing else:**

```yaml
      AGENT_INSTANCE_HOST: agent
      AGENT_INSTANCE_PORT: "4000"
      AGENT_SESSIONS_DIR: /sessions
```

`AGENT_SERVER_HOST` and `AGENT_SERVER_PORT` beside them point the other way entirely: they are
where the Gateway's own Agent server listens for the agent's `curl`. Two addresses cross on the
same network and the names are long so that neither can be read as the other.

`AGENT_SESSIONS_DIR` is **the path the Agent Instance sees**, and it is the same string as the
target of the `./state/sessions:/sessions` mount on `agent`. It is written twice because nothing
can check it once: one end is resolved by `pi` and the other by the Docker daemon, and neither
can see the other's filesystem. A Session named `user_abc` is `/sessions/user_abc.jsonl` inside that
container and `state/sessions/user_abc.jsonl` here, which is where to read a transcript.

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
- `AGENTS.md` is mounted read-only into the Agent Instance's Workspace and tells it that a
  Message it sends travels as an encrypted direct message to somebody's Nostr client.

## The keys are worthless

All three keypairs in `.env.example` are committed to this repository, so everyone who has read
it can be the agent, be Alice and be Bob. They are there so that `docker compose up` is the
whole setup. Generate your own before any of this reaches a real relay.
