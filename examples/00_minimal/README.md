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

## Look around

- `main.ts` is the whole deployment: the Runtime, four components, one Handler, the prompt that
  Handler renders, and the seeding block.
- The Gateway describes its own HTTP API, and the Public server is published at
  <http://127.0.0.1:8081/docs>. That is 8081 and not 8080, so this stack and the other examples
  can run at the same time.
- `AGENTS.md` is mounted read-only into the agent's Workspace and is the only thing that tells
  it the Agent server exists.
