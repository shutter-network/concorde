# The Gateway is trusted

> **Amended by [ADR-0041](./0041-the-shared-agent-has-a-signing-identity.md).** A Shared Agent
> now holds a signing identity, so one **output** is portable and undeniable outside the
> Gateway's API. This ADR's argument is intact and its trust boundary has not moved: a
> signature proves that the Operator committed to a string on the agent's behalf, and nothing
> whatever about the agent's conduct. Non-repudiation remains a non-goal **for the
> conversation** — no Party can prove what the agent was told or what it replied. What was
> rejected below was making *the shield* verifiable without trust, and that is still rejected.

A Shared Agent must be shielded so that no single Party can control it or converse with it privately. We considered making that shield verifiable without trust — cryptographic audit logs, remote attestation, threshold or multi-party control of the agent's configuration — and rejected it. The Gateway is a trusted component: every Party accepts its Operator as neutral.

## One trusted role, two kinds of power

Neutrality requires trust in the **Operator**, who both configures a Shared Agent and runs it. That trust covers two kinds of power, and the build-time kind is by far the stronger:

- Signal Handlers construct every Prompt. Nothing reaches the agent in any other form.
- Handlers hold all authorization; there are deliberately no Gateway-level permissions ([ADR-0009](./0009-signal-handlers-are-arbitrary-code.md)).
- Handlers are the only thing standing in front of the agent's full read access ([ADR-0011](./0011-the-agent-has-full-read-access.md)).
- Handlers are arbitrary code with store access, so one can favour a Party's submissions, rewrite them, or drop them silently.

Running a Gateway is observable; writing its handlers is not. Operational assurance therefore addresses only the weaker half of what a Party is trusting.

The uncomfortable case is also the likely one: an organisation initiates a Shared Agent, builds it, and invites the other Parties in. It is then both a Party and the Operator, and "belongs to no single party" is false in the way that matters most — while every decision in this repository remains satisfied.

**Who operates a Shared Agent is governance, and out of scope for this framework.** No mechanism here constrains the role and none is planned: transparency measures would not survive [ADR-0013](./0013-the-core-framework-stays-generic.md), and given [ADR-0003](./0003-prompt-injection-is-an-accepted-risk.md) and ADR-0011 they would not buy a Party much confidence anyway. What is in scope is saying so plainly.

## Consequences

- The framework's guarantees are **enforced by** the Gateway, not **proven to** the Parties. A Party's confidence rests on trusting the Operator, not on verification.
- **Non-repudiation is a non-goal.** No Party needs to be able to prove after the fact what the agent was told or what it replied. Logging exists for operations and debugging, not as evidence.
- "No single entity has direct access to the agent" is more precisely **no single _Party_ has direct access**. The Operator does, necessarily.
- **A Party deciding whether to join a Shared Agent is evaluating its Operator, not this framework.** [architecture.md](../architecture.md) tells them what is structurally possible; it says nothing about whether a particular agent is fair.
