# Usage limits example

Alice and Bob talk to one agent over HTTP. Each user has a daily model token limit. When Alice
reaches her limit, the gateway replies to her next message without calling the model. Bob can
still get answers. This example defines the daily limit in `main.ts`. The framework records
Usage and stops individual Runs when they exceed their Usage limit.

## Requirements

This example requires Usage support in `@shutter-network/concorde`, so `package.json` specifies
`^0.2.0`. Until that release is published to npm, `npm install` and `docker compose up --build`
will fail. The example installs Concorde from the npm registry, not from this checkout.

## Run

You need Docker with Compose and an Anthropic API key. From this directory:

```sh
cp .env.example .env
```

Set `ANTHROPIC_API_KEY`, `ALICE_PASSWORD`, and `BOB_PASSWORD` in `.env`. `DAILY_TOKEN_LIMIT` is
the number of model tokens each user may use per UTC day. The value in `.env.example` is small
so you can reach the limit with a few messages. Check the model in `settings.json`.

```sh
docker compose up -d --build
docker compose logs -f gateway
```

The log lists each user's id and name. Open the two clients in separate terminals:

```sh
docker compose run --rm tui-alice <alice-id>
docker compose run --rm tui-bob <bob-id>
```

Send messages as Alice until the agent stops answering and she receives "Your daily usage limit
is reached. It resets at 00:00 UTC." Every further message from her that day gets the same
answer from the gateway, and the model is not called. Then send a message as Bob: his Usage is
counted separately, so he still gets answers.

The public API documentation is at <http://127.0.0.1:8085/docs>.

## How it works

`main.ts` uses a custom Signal Handler for `messageReceivedKind`. The handler checks Usage
before deciding whether to prompt the agent, so it does not use `templateHandler`.

- `handle` calls `usage.total` to count the sender's tokens since 00:00 UTC today. If the total
  is at or above `DAILY_TOKEN_LIMIT`, it sends the limit message through the Messenger and
  returns no Prompt, so no Run starts. Otherwise, it returns one Prompt with the sender's
  `userId` and sets `usageLimit` to their remaining daily token allowance. The Run's Usage is
  added to that user's total.
- `post` receives the Run's outcome. If `limited` is true, the Run exceeded its Usage limit
  and the handler sends the limit message. For any other failure, it sends "I could not complete
  that request. Please try again in a minute."

The Prompt's `userId` comes from the Message authenticated by the Gateway. It never comes from
text written by a model or sender. The Session name includes the user id, so later Runs continue
that user's Session. Stopping a Run at its Usage limit preserves the Session. The user's next
allowed message on the following day continues the same Session.

On the first start, trusted application code creates both users with their names and passwords
in one transaction. Restarts keep the saved users and passwords. Changing passwords in `.env`
does not change the saved passwords, even though the example prints the `.env` values again.

## Limit behavior and requirements

- **Usage can exceed the limit by one model response.** Usage is counted when each response
  ends. The Run stops once its total exceeds `usageLimit`, but the provider still charges for
  that response. A user's daily total can therefore exceed `DAILY_TOKEN_LIMIT`. The gateway
  replies to their next message without calling the model.
- **The model server must report usage.** The counts are the ones the model provider returns
  with each response, copied by `pi`. Some self-hosted and OpenAI-compatible servers report no
  usage. Those responses are recorded as 0 tokens, so the limit never takes effect. If you
  configure another provider in `models.json`, check that it reports usage before relying on
  the limit. Responses interrupted mid-stream can also report fewer tokens than were used.
- **The counts are tokens, not money.** `DAILY_TOKEN_LIMIT` is compared with the total of input,
  output, cache read, and cache write tokens. Providers price those categories differently, so
  equal token totals can cost different amounts.
- **Most of the count is cache read tokens.** Every model call sends the agent's whole context
  again: the system prompt, `AGENTS.md`, the tool definitions, and the conversation so far. The
  provider serves most of that context from its cache and reports it as cache read tokens. A
  reply is usually a few hundred output tokens, but one message can count 4,000 to 10,000 tokens
  in total, and the count per message grows as the conversation gets longer. Providers usually
  charge about a tenth of the normal input price for cache reads, but `DAILY_TOKEN_LIMIT` counts
  them at full weight. Choose the limit with that in mind. To count the categories differently,
  calculate your own number in the Signal Handler from the fields that `usage.total()` returns,
  instead of using `totalTokens`.
- **Each user has a separate limit.** Runs without a `userId` do not count toward any user's
  total. To set a hard spending cap for the whole deployment, enforce it at the model provider
  or a model proxy that holds the credential, as in
  [the isolation example](../04_agent_isolation/).

## Files and storage

- `main.ts`: component setup, the daily limit handler, user creation, and shutdown.
- `AGENTS.md`: mounted agent instructions; `settings.json`: model configuration.
- `compose.yml` and the Dockerfiles: gateway, pi RPC listener, database, migration, and two
  clients.
- `schema.ts`: tables for the four components. Usage records are part of the Signals schema,
  so they need no separate schema setup.
- `state/workspace/` and `state/sessions/`: persistent agent files and session records.

Keep the agent server and RPC listener private. The [guide](../../site/guide.md) explains the
shared deployment setup.

Stop with `docker compose down`. Add `-v` to delete the database volume, which also deletes the
recorded Usage; local `state/` files remain.
