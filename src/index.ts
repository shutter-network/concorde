export type { Component, Gateway, ListeningServer } from "./components.ts";
export { createBareGateway, serverComponent } from "./components.ts";
export type {
  AgentContainer,
  AgentContainerRuntime,
  AgentContainerRuntimeSpec,
  ComposedCommand,
  Mount,
  MountTable,
  RunPlan,
} from "./container/index.ts";
export { createAgentContainerRuntime, mountArguments } from "./container/index.ts";
export type { ChannelListener, Db, Handle, Listening, Transaction } from "./db/index.ts";
export { openDb } from "./db/index.ts";
// The infrastructure constructor, from the package root — and it imports **none** of `./users`,
// `./http-messenger`, `./signatures` or `./decisions`: those four are the Operator's now, built
// in `extend` and reached through their own subpath exports, so constructing none of them loads
// none of them. What the root reaches is the Db, the servers and the Signal Worker and nothing
// about the four parts, and — as before — **not** `./pi`, the one import edge worth keeping
// absent ([ADR-0045](../docs/adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)).
export type { GatewayExtension, GatewayOptions, InfraComponents } from "./gateway.ts";
export { createGateway } from "./gateway.ts";
export type { LogFields, Logger } from "./logging.ts";
export { defaultLogger } from "./logging.ts";
// The Signal Worker is not re-exported here. It owns tables, and a component that owns tables
// has a subpath of its own: `shared-agent-framework/signals` carries its constructor, its
// options and the whole vocabulary a Signal Handler is written in
// ([ADR-0047](../docs/adr/0047-a-component-is-one-subpath.md)). What is left at the root is
// what belongs to no component: the Gateway constructors, the `Component` contract, the Db,
// the Agent Container and the template Handler. `createGateway` above and `templateHandler`
// below both name the Worker's types across that line, which is ordinary.
export type { TemplateHandlerOptions } from "./template-handler.ts";
export { templateHandler } from "./template-handler.ts";
