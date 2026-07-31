# Prompt injection is an accepted risk

Signal Handlers embed untrusted user input into prompt templates. Templating does not separate instructions from data — a user's free text and the template's own wording reach the model as one flat sequence — so a determined user can steer the agent contrary to the template's intent.

We considered mitigations: admitting only structured Signals with typed fields, running an input classifier ahead of the agent, and a dual-model pattern in which untrusted text never enters the privileged context. We adopted none. Authors of Signal Handler are responsible for writing careful prompt templates, and the framework offers guidance rather than enforcement.

## Consequences

- **No Signal Handler is a security boundary on content.** Signal Handlers constrain which channels exist and attribute each signal to an authenticated user. They do not constrain intent.
- The framework draws **no formal distinction between structured and free-text Signals**, even though only the former is injection-free. Handler authors must know which kind they are writing.
- A deployment whose design goal includes confidentiality between users cannot rely on its prompt templates to enforce it. See [ADR-0002](./0002-information-flow-between-users-is-the-agents-decision.md).
