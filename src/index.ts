/**
 * The framework core, from `shared-agent-framework`.
 *
 * The root carries what belongs to no component:
 *
 * - `createGateway`, which builds the infrastructure every deployment needs.
 * - `createBareGateway`, which assembles a Gateway from a record you wrote yourself.
 * - `Component`, the contract every part of a Gateway satisfies.
 * - `openDb`, the PostgreSQL client every component queries through.
 * - The Agent Container, which declares how the agent's container runs.
 * - `templateHandler`, a Signal Handler that renders a Handlebars file.
 *
 * Each opinionated component has a subpath of its own, and the root imports none of them.
 * A deployment loads only the components it builds.
 *
 * @example
 * The smallest Gateway that runs: no component of the Operator's own, and one Handler.
 * ```ts
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   agentListen: { host: "127.0.0.1", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   handlers: () => ({
 *     "note.written": templateHandler({
 *       template: new URL("./prompts/note-written.hbs", import.meta.url),
 *       session: () => "notes",
 *       data: (signal) => signal.payload,
 *     }),
 *   }),
 * });
 *
 * await gateway.start();
 * process.once("SIGTERM", () => void gateway.stop());
 * ```
 *
 * @module
 */

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
export type { GatewayExtension, GatewayOptions, InfraComponents } from "./gateway.ts";
export { createGateway } from "./gateway.ts";
export type { LogFields, Logger } from "./logging.ts";
export { defaultLogger } from "./logging.ts";
export type { TemplateHandlerOptions } from "./template-handler.ts";
export { templateHandler } from "./template-handler.ts";
