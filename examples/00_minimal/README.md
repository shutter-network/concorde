# 00_minimal

The smallest deployment that lets a person talk to the agent: Users, Password Auth, the
Messenger and the HTTP Channel, one seeded person, and a terminal client. It shows:

- **What a conversation costs to wire.** `main.ts` builds four components and one Signal
  Handler, and that is the whole entry point.
- **The Messenger and the Channel are two things.** The Messenger owns the Message log and
  reaches nobody; the HTTP Channel is what reaches a person, and it puts a submission and a
  poll on the Public server.
- **Identity and credentials are two components.** Users holds who exists; Password Auth holds
  the password and the Token, registers itself with the Public server, and that server composes
  every registered scheme into the one hook the Channel's routes take.
- **A seeded person, in one transaction.** `main.ts` creates the User and sets their password
  together, so a User nobody can log in as never reaches the table. It is guarded by an empty
  list, so a restart keeps the id you copied.
- **Which components own tables.** `schema.ts` re-exports four components' `/schema` subpaths
  for five components, and `drizzle.config.ts` names that one file. The HTTP Channel has none:
  it stores nothing and queues nothing, because HTTP delivery is the User asking.

## Run it

```sh
cp .env.example .env   # then put your Anthropic API key in it
docker compose up -d --build
docker compose logs -f gateway
```

The Gateway prints the User id and the password on every boot:

```
user 0f5c1b3a-... logs in with the password correct horse battery staple
```

Then talk to it, in a second terminal, with the id it printed:

```sh
docker compose run --rm tui 0f5c1b3a-...
```

Type a line and press enter. The client logs in, prints the log, and asks for more once a
second, so the agent's answer arrives a moment after it is sent. Ctrl-C leaves.

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

- `main.ts` is the whole deployment: the Runtime, four components, one Handler, the prompt that
  Handler renders, and the seeding block.
- The Gateway describes its own HTTP API, and the Public server is published at
  <http://127.0.0.1:8081/docs>. That is 8081 and not 8080, so this stack and the other examples
  can run at the same time.
- `AGENTS.md` is mounted read-only into the Agent Instance's Workspace and is the only thing
  that tells it the Agent server exists.
