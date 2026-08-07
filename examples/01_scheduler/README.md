# 01_scheduler

A Gateway whose only component is the Scheduler. It shows:

- **Components are opt-in.** There is no Users component here, and no Messenger and no
  Channel, because nothing in this deployment reaches a person. The schema in `schema.ts` is
  two specifiers wide.
- **A Signal Handler written by hand**, not with `templateHandler`. Every Schedule fires
  under one kind, so `main.ts` routes on the `data` each Schedule carried. There is no
  prompt template in this directory.
- **Two standing Schedules**, declared in `main.ts` after `start()`: a `once` about twenty
  seconds out, and a `cron` of `* * * * *`. Both are upserts by name, so a restart converges
  on the same two.
- **The agent scheduling itself.** `AGENTS.md` tells it to create one Schedule of its own
  over the Gateway's Agent server.

## Run it

```sh
cp .env.example .env   # then put your Anthropic API key in it
docker compose up -d --build
docker compose logs -f gateway
```

The first fire arrives about twenty seconds after the Gateway is up, and the `cron` fires on
every minute after that. Each one is a `Schedule fired` line, then a Signal, then a Run.

What the agent writes is in `state/workspace/`.

```sh
docker compose down -v
```

## Look around

- `main.ts` is the whole deployment: the Runtime, the one component, the Handler and the two
  Schedules.
- The Gateway describes its own HTTP API, and the Public server is published at
  <http://127.0.0.1:8080/docs>. Its document lists no routes, because a Channel is what puts
  one there and this example builds none. The Agent server's document is the interesting one,
  and the agent reads it itself.
- `AGENTS.md` is mounted read-only into the agent's Workspace and is the only thing that
  tells it the Agent server exists.
