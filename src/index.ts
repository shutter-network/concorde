/**
 * The framework core, and the two words the rest of this reference is written in. A **Shared Agent**
 * is an AI agent that acts for several parties at once and is controlled by none of them alone. The
 * **Operator** is whoever runs one: they hold its configuration, write its Signal Handlers, and are
 * trusted by every party.
 *
 * {@link createGateway} is where a deployment starts. It builds the four things every deployment
 * has, hands them to an `extend` callback where the components you want are constructed by hand,
 * and answers with a {@link Gateway}. A Gateway is a record of {@link Component}s under your own
 * keys, started in key order and stopped in the reverse of it, and a Component itself.
 * {@link createBareGateway} takes such a record directly, for a deployment whose infrastructure
 * shape is what differs.
 *
 * What is left here belongs to no one component. {@link openDb} is the PostgreSQL client every
 * component queries through. {@link createAgentContainerRuntime} runs an agent as one fresh
 * container per Run, taking an {@link AgentContainer} and a {@link MountTable} that know nothing
 * about which agent program it is. {@link templateHandler} is a Signal Handler that renders a
 * Handlebars file, {@link defaultLogger} is what a part logs through when you supply nothing, and
 * {@link CursorWindow} is the stretch of a log a paged read asks for, which two components take and
 * neither owns.
 *
 * The opinionated components are each on a subpath of their own and nothing here imports one, so a
 * deployment loads only what it builds. The vocabulary a Signal Handler is written in is on
 * `shared-agent-framework/signals`, and the agent program the reference deployment runs is on
 * `shared-agent-framework/pi`.
 *
 * @example
 * The smallest Gateway that runs: nothing of the Operator's own beyond one Signal Handler.
 * ```ts
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
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
// The one name `route-conventions.ts` puts on a specifier, and the only reason it is here rather
// than on a component: `Decisions.history` and `Messenger.history` both take it, so it is a
// parameter a Developer has to be able to name. A component's own types live on the component
// (ADR-0047); this one is owned by neither of the two that read through it, which is what the root
// is for. The aliases each of them writes it under stay internal, because a type alias is
// transparent to the compiler and a signature spelled `Partial<DecisionWindow>` prints, and
// resolves, as this.
export type { CursorWindow } from "./route-conventions.ts";
export type { TemplateHandlerOptions } from "./template-handler.ts";
export { templateHandler } from "./template-handler.ts";
