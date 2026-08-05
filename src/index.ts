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
// The default assembly, from the package root, which is what makes the root import
// `./users`, `./http-messenger`, `./signatures` and `./decisions`: the subpath exports are
// organisation rather than optionality, so a deployment that constructs no Messenger still
// loads the module. What the root does **not** import is `./pi`, and that edge is the one
// worth keeping absent
// ([ADR-0038](../docs/adr/0038-the-default-assembly-is-a-constructor.md)).
export type {
  DefaultComponents,
  DefaultGatewayOptions,
  GatewayExtension,
} from "./default-gateway.ts";
export { createGatewayWithDefaults } from "./default-gateway.ts";
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
