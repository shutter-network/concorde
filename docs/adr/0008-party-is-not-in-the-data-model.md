# Party is not in the data model

A Shared Agent belongs to several parties at once — that premise is the reason this framework exists. Nonetheless the data model contains no Party entity. The User Directory knows Users, and nothing above them ([ADR-0029](./0029-users-are-a-part-of-their-own.md); this ADR originally said the Messenger); the core knows no identity at all ([ADR-0020](./0020-producers-are-trusted-components-of-the-gateway.md)).

The reasoning is that ownership confers no rights here. [ADR-0001](./0001-the-gateway-is-trusted.md) puts the agent's configuration in the hands of the Operator and denies every party the ability to change it, so being an owner grants no mechanical privilege. That leaves Party with only two possible jobs — addressing a group, and routing a group to its own Session — and both are grouping rather than ownership. Grouping is expressible as user attributes that a deployment defines and its Signal Handlers read.

We considered making Party a first-class entity with Users belonging to it. Rejected: a non-operational entity in the data model invites authorization to be hung off it later, which would contradict ADR-0001.

## Consequences

- A Message involves exactly one User, whichever direction it travels. There is no addressing a group and no broadcast primitive; an agent wanting to reach several users sends several Messages.
- Per-group confidentiality is built by a deployment's Signal Handlers reading user attributes and routing Sessions accordingly, not by the Gateway.
- "Party" remains a defined term for describing the framework, and must not appear as a table, an identifier, or an API field.
