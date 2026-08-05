export type { Component, Gateway, ListeningServer } from "./components.ts";
export { createBareGateway, serverComponent } from "./components.ts";
export type {
  AgentContainer,
  AgentContainerRuntime,
  AgentContainerRuntimeSpec,
  ComposedCommand,
  Mount,
  MountTable,
  ResolvedMount,
  ResolvedMountTable,
  RunPlan,
} from "./container/index.ts";
export { createAgentContainerRuntime, resolveMountTable } from "./container/index.ts";
export type {
  ChannelListener,
  Db,
  Handle,
  Listening,
  MigrationDescriptor,
  Transaction,
} from "./db/index.ts";
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
export type {
  EmittedSignal,
  PostOutcome,
  Prompt,
  RunOutcome,
  RunPrompt,
  RunRecord,
  RunState,
  Runtime,
  Signal,
  SignalHandler,
  SignalHandlers,
  SignalRecord,
  SignalState,
  SignalWorker,
  SignalWorkerOptions,
} from "./signals/index.ts";
export { createSignalWorker, signalsMigrations } from "./signals/index.ts";
export type { TemplateHandlerOptions } from "./template-handler.ts";
export { templateHandler } from "./template-handler.ts";
