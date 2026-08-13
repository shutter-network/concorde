# shared-agent-framework

A framework for AI agents that act for more than one party at the same time, and are controlled
by none of them individually.

## What a Shared Agent is

A **Shared Agent** is an AI agent that acts for several parties at once. No single party owns it,
and no party can reach it privately. Every message into the agent and out of it goes through a
**Gateway** that you run.

Two people who share a household budget are a good example. Both talk to the same agent. Both
need to trust that the agent does not take instructions from one of them in secret. The Gateway
is what makes that structure real. It holds the Message log and the agent's signing key. It is
the only path between a person and the agent.

An **Operator** is whoever runs and configures a Shared Agent. Every party trusts the Operator.
The Operator writes the entry point, holds the keys, owns the database, and runs the stack. Most
of this site is written for that reader.

![The parts of a Shared Agent. A dashed boundary encloses the Gateway, holding the Db, the Signal
Worker, the Agent server and the Public server, together with the Messenger and its two Channels
and Users with its two Auths. Outside it are the Agent Implementation, a person's client, and a
Nostr Relay.](/architecture.svg)

Everything inside the dashed boundary is the Gateway. The [Architecture](./architecture#the-shape)
page reads the picture part by part.

## Where to start

| Page | What it answers |
| --- | --- |
| [Build a Shared Agent](./guide) | How do I get a working deployment from nothing? |
| [Architecture](./architecture) | What are the parts, and why are they separate? |
| [API reference](./reference/) | What is the exact signature of this function? |

Read the guide first. It builds one small deployment step by step, and it links to the
architecture page wherever a step needs the reasoning behind it.

## What the framework gives you

- A **Gateway** that mediates all traffic between people and the agent.
- A **serial Signal Worker**, so the agent does one thing at a time.
- **Messaging** over HTTP or Nostr, with one Message log per person.
- **Authentication** as a component, with passwords or Nostr keys.
- **Signed Decisions**, so the agent can commit to something that a third party can check.
- **Scheduling**, so time can wake the agent.

You choose which of these your deployment builds. The framework builds only the infrastructure
that every deployment needs, and you construct the rest by hand.

## What you must provide yourself

The framework does not do these things, and each omission is deliberate:

- **Confidentiality between parties.** The agent reads every Message and decides what to send to
  whom.
- **Resistance to prompt injection.** This risk is accepted, not solved.
- **Confinement of the Agent Implementation.** Your deployment confines it.
- **Rate limiting.** The login route is unthrottled.

The [Architecture](./architecture#what-you-must-provide-yourself) page states the full list. Read
it before you deploy.
