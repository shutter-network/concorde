# 04_agent_isolation

`00_minimal` with the three things an Operator adds before leaving a deployment running: a restart
policy, a healthcheck, and an agent that holds no credential and can reach nothing.

One person talking to one agent over HTTP, exactly as in `00_minimal`. Everything below is about
the `compose.yml` around it.

```sh
cp .env.example .env     # and put your model credential in it
docker compose up -d --build
docker compose run --rm tui <the user id the gateway printed>
```

## What it shows

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
the Db is reachable, the Signal Worker is draining, or the Agent Instance is alive — **a dead agent
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
told. The healthcheck above tells the *Operator* something is wrong; this tells the *person*.

**What it does not catch:** a Run that *succeeds* having sent no Message. `outcome.failed` is false
then, so `post` stays quiet and the person still hears nothing. Catching that means checking the
log after the Run — which is the kind of thing `post` is arbitrary code in order to allow.

### An agent that holds no credential and reaches nothing

This is the part worth copying, and the part with the most caveats.
Three separate things:

**1. The agent is on an `internal: true` network.** It reaches the Gateway and the proxy, and
nothing else — no other host, no other port, no internet. `internal` is a Docker network property,
so it holds regardless of what the agent tries.

**2. The credential never enters the agent.** `ANTHROPIC_BASE_URL` on the `agent` service points
pi's built-in provider at the proxy instead of the provider — an **address, not a credential**. The
proxy holds the real key and sets the auth header on the way out. `settings.json` is byte-identical
to every other example's: the whole redirection is one environment variable. Check it yourself:

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
its own environment** — that is what point 2 is for, and the two are often confused.

## What none of this fixes

Read this before copying the pattern.

- **The agent can still tell a person a secret.** Nothing above touches the reply channel. If the
  agent learns something it should not have, it can put it in a Message. Network isolation is not
  a confidentiality boundary.
- **The proxy is a credential boundary, not an authorization one.** It adds a header to whatever
  the agent sends. The agent still decides what to ask the model, and how often.
- **The proxy forwards to one upstream.** It is not an allowlisting egress proxy. If your agent
  legitimately needs other hosts — a dashboard, an internal API — add them deliberately, one at a
  time, rather than putting the agent back on a network with a route to everything.
- **`internal: true` would break a deployment that needs the open internet.** That is the whole
  reason the proxy exists here: the agent stays caged, and exactly one way out is drilled through
  it. Reaching for `internal: true` without something like this leaves the agent unable to reach
  its model at all.
- **A scoped, short-lived credential is still worth having.** The proxy stops the agent *reading*
  the key; it does not stop the agent *spending* it.
- Everything on the framework's own list still applies: no confidentiality between parties, no
  resistance to prompt injection, no rate limiting.

## The proxy

`model-proxy.ts`, about sixty lines, no dependencies, run from the same image as the Gateway. It
forwards method, path, body and headers to `MODEL_UPSTREAM_URL`, dropping hop-by-hop headers and
replacing `MODEL_AUTH_HEADER` with `MODEL_AUTH_VALUE`. Streaming responses pass through, which
matters because the agent's model calls are server-sent events.

It **preserves the path**: whatever the agent requests is appended to `MODEL_UPSTREAM_URL`. So that
URL must not repeat a segment the agent's own base URL already carries — Anthropic's SDK asks for
`/v1/messages`, so the upstream is the bare origin, while an OpenAI-compatible base URL ending in
`/v1` needs an upstream that stops before it.

It is deliberately dull. A real deployment would likely want request logging, a timeout, and a
rate limit on it; all three are the Operator's to add.
