# Agent isolation example

The minimal HTTP application with restricted agent networking, a model proxy, and failure
messages to the user. The proxy holds the model credential; the agent container receives only
a placeholder.

## Run

You need Docker with Compose and an Anthropic API key. From this directory:

```sh
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` and choose `USER_PASSWORD` in `.env`.

```sh
docker compose up -d --build
docker compose logs -f gateway
```

Copy the user id from the log and open the client in another terminal:

```sh
docker compose run --rm tui <user-id>
```

The public API is at <http://127.0.0.1:8081/docs>. This example uses the same host port as
`00_minimal`; stop that stack before running this one.

The password is stored on first boot only. Changing `USER_PASSWORD` later does not change it,
even though the example prints the environment value again.

## Credential and network setup

The `agent` service belongs to an internal Docker network shared with the gateway and LiteLLM.
It has no direct internet route. LiteLLM also belongs to an egress network and forwards model
requests with the real credential.

`models.json` sets pi's provider base URL to the proxy. Configure that file rather than relying
on `ANTHROPIC_BASE_URL`, which pi overrides. `litellm-config.yaml` maps the requested model to
the upstream provider. Keep its model alias consistent with `settings.json`.

Inspect the agent environment:

```sh
docker compose exec agent printenv ANTHROPIC_API_KEY
```

It should print `not-a-real-key`. The working credential belongs only to LiteLLM. An agent with
a shell can read its environment, so do not put secrets there unless it needs them.

The agent and proxy also drop Linux capabilities, disable privilege escalation, and set process
and memory limits. These controls supplement the network and credential restrictions.

## Failure handling and monitoring

`main.ts` gives the message handler a post phase. If a run fails, trusted gateway code sends a
short failure message through the messenger. A successful run that sends no message does not
trigger this fallback. Failed signals are not automatically retried.

Long-running services use `restart: unless-stopped`. The gateway healthcheck requests
`/openapi.json`; it checks HTTP availability, not database connectivity, queue progress, or agent
health. An unhealthy status alone does not restart a Docker container.

Use `docker compose ps` and the gateway and proxy logs to investigate failures. LiteLLM runs
with telemetry disabled in this example.

## Limits

The agent can still access the gateway capabilities you expose and send information in a
message. Network restrictions do not enforce confidentiality between users or prevent prompt
injection. `main.ts` fences each message with `quote`, which makes injection harder but not
impossible; see [the guide](../../site/guide.md#define-how-the-agent-responds).

The proxy keeps the credential out of the agent's filesystem and environment, but the agent can
still incur model usage through it. Apply provider limits appropriate to your deployment.
The proxy forwards model requests; it is not a general host allowlist for other network access.

Persisted agent files are under `state/`. See [the guide](../../site/guide.md) for the shared
application setup. This example installs the library from the npm registry, not this checkout.

Stop with `docker compose down`. Add `-v` to delete the database volume; local `state/` files remain.
