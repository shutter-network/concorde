# The agent reaches the Gateway over HTTP, not through tools

> **Superseded in one detail** by
> [ADR-0032](./0032-components-wire-themselves-at-construction.md). *"Switching one off is
> simply not registering that plugin"* no longer describes the mechanism: a Component
> registers its own routes on whichever servers it is given, so switching an endpoint
> group off is **omitting the server option**. Still an omission rather than a flag, and
> the route plugins stay exported for an Operator who wants their own prefix or Fastify
> encapsulation. Everything else here stands, including that endpoint groups are
> disableable per deployment at all.

The agent has no direct access to the Gateway store. Everything it needs from the Gateway comes from an HTTP API that the Gateway exposes to it: sending Messages, creating and reading Users, and reading prior Signals.

We considered injecting a fixed set of runtime tools instead. Rejected: the API is the contract, and expressing it as tools would bind it to one runtime's tool mechanism. How a given Agent Runtime reaches the API — `curl` from `pi`'s bash tool, a custom tool via the `pi` SDK, MCP under OpenClaw — is a concern of the runtime adapter.

Endpoint groups can be switched off per deployment. A Shared Agent with no use for user management does not expose it. Since there is no plugin system, switching one off is simply not registering that plugin ([ADR-0021](./0021-the-framework-has-no-plugin-system.md)).

## Consequences

- **The Agent server is unauthenticated.** We considered a credential held inside the Agent Runtime, then a secret generated per Gateway process. Both were rejected: a credential is no boundary against the agent, which is the only party meant to reach that server, so the sole thing it defends against is *something else* reaching the port — and that is what network topology is for ([ADR-0004](./0004-runtime-confinement-is-the-deployments-responsibility.md)). Reaching the port therefore *is* access, and the Agent server binds `127.0.0.1` by default so that exposing it requires a deliberate change. The risk accepted here is specific: Docker's `-p` inserts rules in the `DOCKER` iptables chain that **bypass `ufw` and `firewalld`**, so publishing that port by accident is easier than it looks and the consequence is the whole Store readable and writable by anyone who finds it.
- `pi` ships no HTTP client, so agent-side API use is `bash` plus `curl`, and the API's shape has to be described to the agent in its own configuration (`AGENTS.md` or the system prompt).

> **The reasoning above is partly wrong, though the conclusion stands.** "Expressing it as tools would bind it to one runtime's tool mechanism" assumed `pi` had no usable tool mechanism. It does: extensions loaded from the agent directory call `pi.registerTool`, and they work in subprocess mode, so the `pi` adapter *could* ship typed tools that call this API without changing the API or the adapter contract. Keeping HTTP as the contract remains right — it is what an OpenClaw adapter can also target — but tools-as-a-convenience is available and worth revisiting.
- The API is a mediation point, not a security boundary against the agent. It enforces the Gateway's invariants and whatever surface is enabled, and nothing more.
