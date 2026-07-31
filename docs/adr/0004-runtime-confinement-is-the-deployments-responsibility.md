# Runtime confinement is the deployment's responsibility

The framework does not confine the Agent Runtime. Sandboxing, egress filtering, filesystem restrictions, and whether the agent may modify its own configuration are all left to whoever deploys a Shared Agent.

This is deliberate, not an omission. Some Shared Agents are *meant* to edit their own instructions — the parties may collectively want the agent to revise how it works over time. A framework that forbade self-modification would rule that out. Since the desired setting genuinely differs per deployment, the framework declines to pick one.

## Consequences

- The `pi` runtime ships a `bash` tool running with the full permissions of its process, keeps its system prompt on disk, and stores sessions as readable JSONL files. Deployed unconfined, the agent can rewrite its own instructions, read other sessions' verbatim history, and reach the network without passing through the Gateway. That is a **supported configuration**, not a bug.
- The Gateway mediates the agent's *intended* channels, not every channel available to it. "The Gateway controls access in both directions" holds only for a runtime that has been configured to have no other path out.
- Documentation telling deployers what to configure is the framework's only mitigation here, as it is for injection. See [ADR-0003](./0003-prompt-injection-is-an-accepted-risk.md).
