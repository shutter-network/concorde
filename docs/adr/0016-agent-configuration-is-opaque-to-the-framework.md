# Agent configuration is opaque to the framework

The framework models nothing about what the agent *is*. Instructions, model choice, and tools are supplied by the deployment in whatever form its Agent Runtime expects, and the Runtime Adapter passes them through without interpreting them. All the framework knows when starting a Run is which Session to target and which Prompt to deliver.

We considered a runtime-neutral configuration shape, so that runtimes would be swappable through configuration alone. Rejected, because the abstraction is illusory: `pi` takes a system prompt at construction or in `AGENTS.md` and has four fixed tools with no MCP, while OpenClaw has per-agent tool allow/deny, skills, MCP blocks, and hot config reload. Any shape covering both collapses to "some instruction text" while presenting itself as more. [ADR-0005](./0005-pi-is-the-primary-agent-runtime.md) already notes the adapter contract is shaped by the weaker runtime; this states it plainly.

We also considered exposing the agent's instructions read-only to Users, so parties could see what the agent they co-own is told to do. Not adopted.

## Consequences

- Swapping Agent Runtime means rewriting the agent's configuration. Signal Handlers, Users, Messages, and the Gateway's own behaviour carry over; nothing about the agent itself does.
- **"Mandate" is retired as a term.** It named something real about why the framework exists but had no operational role, and the framework holds no representation of the agent's purpose. Compare [ADR-0008](./0008-party-is-not-in-the-data-model.md) on Party, with the difference that Party is still needed to explain the framework and Mandate is not.
- The Runtime Adapter's contract is narrow: start a Run against a Session with a Prompt, collect its output, report completion or failure.
