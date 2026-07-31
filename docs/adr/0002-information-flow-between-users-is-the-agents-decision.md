# Information flow between users is the agent's decision

A Shared Agent may hold context from several users at once. We considered enforcing confidentiality between them in the Gateway — filtering outbound messages against a declared policy, or partitioning context into one confined runtime instance per user — and rejected both. The Gateway does not inspect or restrict what the agent chooses to reveal to whom.

Cross-user inference is frequently the point. A mediating or coordinating agent is expected to reason across everything every party has told it; a framework that structurally prevented this would prevent the use cases that motivate a Shared Agent in the first place.

The Gateway enforces the **channel**, not the **content**: users are authenticated, a user can read only their own Outbox, and no user can reach the agent except by submitting a Signal. Users therefore cannot reconfigure the agent, change its tools or model, or address it outside a defined channel.

## Consequences

- Confidentiality between users is **not a requirement of this framework**. It is a common design goal of individual Shared Agents built on it, expressed through their prompts and configuration, and achieved only at the agent's discretion.
- In a shared-context deployment the agent is a shared confidant: anything a user tells it may surface in its behaviour toward any other user. Deployments must say so to their users.
- A deployment that needs real isolation between two groups runs **two Shared Agents**, not one agent with internal partitions.
