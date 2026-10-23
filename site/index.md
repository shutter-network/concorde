# Concorde

Concorde is a TypeScript library for building shared agents: AI agents that serve several
parties without giving any one party direct control. A trusted operator runs the agent and a
gateway that mediates its interactions with users.

Your application chooses the components, defines how incoming signals become prompts, and
controls which capabilities the agent can call over HTTP. Concorde provides persistent
messaging, serial execution, authentication, scheduling, and signed decisions.

## Get started

[Build a shared agent](./guide) runs an HTTP deployment and shows how to adapt it.
You need Docker with Compose and a model provider credential.

[Architecture](./architecture) explains the components, execution model, and deployment
responsibilities. Use the [API reference](./reference/) when writing your application.

## Choose your components

| Need | Components |
| --- | --- |
| Identify users and accept credentials | users, password auth, Nostr auth |
| Exchange messages | messenger with an HTTP channel or Nostr channel |
| Run the agent at a scheduled time | scheduler |
| Sign and retain commitments | signatures, decisions |

`createGateway` supplies the db, signal worker, agent server, and public server.
You construct the other components in your application. Import each from its package subpath,
such as `@shutter-network/concorde/messenger`.

## Understand the trust model

Users access the gateway rather than the agent instance. The operator controls both and is
trusted by all parties. The agent server and the agent instance's RPC listener require private
network access: neither authenticates callers.

Concorde does not prevent prompt injection or enforce confidentiality between users.
Read [deployment responsibilities](./architecture#deployment-responsibilities) before exposing
an application beyond your development environment.
