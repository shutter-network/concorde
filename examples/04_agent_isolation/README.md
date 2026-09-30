# 04_agent_isolation

## Motivation

Give an agent a provider key and it will eventually read it back to you.

It has a shell. Asked an innocent question about itself, such as *"which model are you running?"*,
a model will run `env`, and the key is then in its answer, in its transcript on disk, and in the
context sent to your provider. Nobody has to attack it for this to happen.

This example is the same minimal deployment with the credential taken away from the agent:

- the **model credential lives in a proxy**, and the agent holds a placeholder worth nothing
- the agent sits on an **`internal: true` network**, so the only thing it can reach is that proxy
  and the Gateway
- ordinary container hardening bounds what an escape would reach

None of it stops the agent putting a secret in a Message, and this README says where that line is.
It reduces what the agent *holds* and what it can *reach*; the layers above it are a separate
question.

```sh
cp .env.example .env     # and put your model credential in it
docker compose up -d --build
docker compose run --rm tui <the user id the gateway printed>
```

One person talking to one agent over HTTP, exactly as in `00_minimal`. Everything below is about the
`compose.yml` around it.

## What it shows

### An agent that holds no credential and reaches nothing

This is the part worth copying, and the part with the most caveats.
Three separate things:

**1. The agent is on an `internal: true` network.** It reaches the Gateway and the proxy and
nothing else: no other host, no other port, no internet. `internal` is a Docker network property,
so it holds regardless of what the agent tries.

**2. The credential never enters the agent.** [`models.json`](./models.json) points pi's built-in
`anthropic` provider at the proxy instead of the provider. It is four lines carrying an **address,
not a credential**. The proxy holds the real key and sets the auth header on the way out.
`settings.json` is byte-identical to every other example's.

`ANTHROPIC_BASE_URL` will not do this job, though it looks like it should. The SDK `pi` bundles
reads that variable only as a default, and `pi` passes its own `baseUrl`, so the variable has no
effect: the agent keeps dialling the real provider, and the Run fails with `Connection error` while
the proxy's log stays empty.

Check it yourself:

```sh
docker compose exec agent env | grep -i -E 'key|token|secret'
# ANTHROPIC_API_KEY=not-a-real-key   <- a placeholder the SDK insists on, and worth nothing
```

That matters because **an agent can read its own environment.** It has a shell, and a model asked
an innocent question about itself will run `env` and put the result in its answer. Anything you
put in the agent's environment is something you have handed to the agent, its transcript on disk,
and its model provider.

**3. Ordinary container hardening**, on the agent and the proxy:

```yaml
cap_drop: [ALL]
security_opt: [no-new-privileges:true]
pids_limit: 512
mem_limit: 2g
```

Cheap, and worth having. They bound what an escape reaches. **They do not stop the agent reading
its own environment**, which is what point 2 is for, and the two are often confused.

### A failure that reaches the person

`templateHandler` has no post phase, so a failed Run is silence: the person waits for an answer
that cannot come, because a Signal is never retried. This example spreads it and adds one.

```ts
const answer: SignalHandler<MessageRecord> = {
  ...templateHandler<MessageRecord>({ /* template, session, data */ }),
  async post(signal, outcome) {
    if (!outcome.failed) return;
    await db.tx((tx) => messenger.send(tx, signal.payload.userId, "Sorry - ..."));
  },
};
```

It matters more here than in `00_minimal`, because the proxy is a new single point of failure: a
wrong credential or an unreachable provider fails **every** Run, and without this nobody waiting is
told. The healthcheck below tells the *Operator* something is wrong; this tells the *person*.

**What it does not catch:** a Run that *succeeds* having sent no Message. `outcome.failed` is false
then, so `post` stays quiet and the person still hears nothing. Catching that means checking the
log after the Run, which is the kind of thing `post` is arbitrary code in order to allow.

## Also here, because a deployment left running needs them

Neither is about isolation. They are the two things an Operator adds before walking away
from any deployment, and they are here because this example is the one meant to be run
rather than read.

### A restart policy

`restart: unless-stopped` on every long-running service: the Gateway, the agent, the proxy and
PostgreSQL. The one-shot `migrate` keeps `restart: "no"`.

Without it Docker's default is `no`, so a crashed Gateway stays down until somebody notices. It
also covers the ordinary case of a host reboot: `migrate` does not run again, and the Gateway
restarts until PostgreSQL is accepting connections.

`unless-stopped` rather than `always`, so a deliberate `docker compose stop` stays stopped.

### A healthcheck

The Gateway serves `/openapi.json` on the Public server, which is enough to say the HTTP server is
answering. A Compose healthcheck calls it:

```yaml
healthcheck:
  test: [CMD, node, -e, "fetch('http://127.0.0.1:8081/openapi.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 60s
  timeout: 5s
  retries: 3
  start_period: 20s
```

`node -e` rather than `curl`, because the Gateway image already has Node and nothing else needs
installing for it.

**This is a process-level check and nothing more.** It says the server is up. It does **not** say
the Db is reachable, the Signal Worker is draining, or the Agent Instance is alive. **A dead agent
still reports healthy here.**

A deployment that wants a real readiness check registers its own route through `extend`, which
receives `publicServer.fastify` and `agentServer.fastify`:

```ts
extend: ({ db, publicServer }) => {
  publicServer.fastify.register(async (health) => {
    health.get("/health", async (_request, reply) => {
      try {
        await db.handle({}).execute(sql`select 1`);
        return { status: "ok" };
      } catch {
        reply.code(503);
        return { status: "unhealthy" };
      }
    });
  });
  // …
}
```

Register it rather than writing it onto the instance, so it appears in `/openapi.json` like every
other route. Concorde ships no built-in `/health` on purpose: it cannot know whether your Telegram
poller, your Relay or your own tables are working, and a check that answered for them would be
lying.

**A healthcheck alone restarts nothing.** Docker's restart policy reacts to a container *exiting*,
not to an unhealthy status. What `unhealthy` buys you is that `docker compose ps` and your
monitoring can see it. Acting on it is an orchestrator's job.

## What none of this fixes

Read this before copying the pattern.

- **The agent can still tell a person a secret.** Nothing above touches the reply channel. If the
  agent learns something it should not have, it can put it in a Message. Network isolation is not
  a confidentiality boundary.
- **The proxy is a credential boundary, not an authorization one.** It adds a header to whatever
  the agent sends. The agent still decides what to ask the model, and how often.
- **The proxy forwards to one upstream.** It is not an allowlisting egress proxy. If your agent
  legitimately needs other hosts, such as a dashboard or an internal API, add them deliberately,
  one at a time, rather than putting the agent back on a network with a route to everything.
- **`internal: true` would break a deployment that needs the open internet.** That is the whole
  reason the proxy exists here: the agent stays caged, and exactly one way out is drilled through
  it. Reaching for `internal: true` without something like this leaves the agent unable to reach
  its model at all.
- **A scoped, short-lived credential is still worth having.** The proxy stops the agent *reading*
  the key; it does not stop the agent *spending* it.
- Everything on the framework's own list still applies: no confidentiality between parties, no
  resistance to prompt injection, no rate limiting.

## The proxy

[LiteLLM](https://docs.litellm.ai/docs/proxy/deploy), pinned at `v1.103.1`. It is MIT-licensed,
needs no account and no database for this, and its whole configuration is
[`litellm-config.yaml`](./litellm-config.yaml):

```yaml
model_list:
  - model_name: claude-sonnet-5          # what settings.json already asks for
    litellm_params:
      model: anthropic/claude-sonnet-5   # what it really is, and the agent never learns it
      api_key: os.environ/ANTHROPIC_API_KEY
```

`model_name` is an alias you choose.

It runs with `--telemetry False`. LiteLLM reports usage home by default, and an agent that reaches
nothing should not sit behind something that does.
