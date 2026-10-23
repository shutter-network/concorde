# Scheduler example

A scheduled agent writes files without any users or messaging components. This example adds
only a scheduler to the gateway infrastructure and implements a signal handler directly.

## Run

You need Docker with Compose and an Anthropic API key. From this directory:

```sh
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env` and check the model in `settings.json`.

```sh
docker compose up -d --build
docker compose logs -f gateway
```

About twenty seconds after startup, the first run appends to `state/workspace/log.md`.
A recurring schedule asks the agent to update `state/workspace/heartbeat.md` every minute.
Session records are stored in `state/sessions/`.

## How it works

`main.ts` handles `scheduleFiredKind`. It reads the task from the signal payload and returns a
prompt in a session named for the schedule. Its post phase logs failures.

After startup, the application creates or replaces two schedules:

| Name | Timing | Action |
| --- | --- | --- |
| `hello-once` | Twenty seconds after startup | Append to `log.md` |
| `every-minute` | `* * * * *` in UTC | Append to `heartbeat.md` |

Reusing a name updates that schedule. Restarting therefore schedules `hello-once` again.
Missed occurrences during downtime are skipped.

`AGENTS.md` also asks the agent to create one follow-up schedule on its first wake. This shows
how agent-server routes can schedule future work. There is no channel, so results are written
to the workspace rather than sent to a person.

## Customize

Change the timing and `data.task` values in `main.ts`, or replace the handler with your own
logic. `schema.ts` includes only signal and scheduler tables; users are not required.

The public server at <http://127.0.0.1:8080/docs> has no application routes. The agent reads its
own server's OpenAPI document. Keep that server and the RPC listener private.

See [the guide](../../site/guide.md) for the shared container setup. This example installs the
library from the npm registry, not this checkout.

Stop with `docker compose down`. Add `-v` to delete the database volume; local `state/` files remain.
