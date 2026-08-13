/**
 * A Gateway is the whole of a deployment as one object: a record of parts under keys of the
 * Operator's own, and a part itself, so two calls start and stop everything. Each entry is a
 * Component, which is a `start` and a `stop` and nothing more.
 *
 * {@link createGateway} is where a deployment starts. It builds the four parts every deployment
 * has, a Db, the Agent server, the Public server and the Signal Worker, hands them to the `extend`
 * callback on {@link GatewayOptions}, and answers with a {@link Gateway} holding those four beside
 * whatever `extend` returned. {@link InfraComponents} names them and is what `extend` reads its
 * arguments from. {@link createBareGateway} takes a finished record instead, for a deployment whose
 * infrastructure has a shape of its own, and {@link serverComponent} turns a server the Operator
 * built into a {@link Component} for such a record.
 *
 * Every component this package ships is constructed by hand inside `extend`, one `create*` each,
 * and only the ones a deployment wants. `extend` runs first and `handlers` reads its result, so a
 * Signal Handler closes over a component of your own and never the reverse.
 *
 * A server is also where authentication is composed. Each scheme a deployment accepts is an
 * {@link Auth}, a Component with one more member that registers itself with the Public server at
 * construction, and {@link AuthOutcome} is what one answers about a request.
 * {@link ServerComponent} holds the registered Auths and composes them into the one `requireUser`
 * every protected route takes, so a route reading `request.concordeUser` does not care which scheme
 * named the User.
 *
 * Two of the four are documented on subpaths of their own: `@shutter-network/concorde/db` holds the
 * Db, and `@shutter-network/concorde/signals` holds the Signal Worker and the whole Signal Handler
 * vocabulary. The other two are plain Fastify instances, each reached on `.fastify`. This subpath
 * owns no tables and exports no schema, so every table a deployment needs comes from a component
 * it constructed in `extend`.
 *
 * @example
 * The smallest Gateway that runs: one Signal Handler, and nothing else of the Operator's own.
 * ```ts
 * import { readFileSync } from "node:fs";
 * import { createGateway } from "@shutter-network/concorde/gateway";
 * import { createPiRuntime } from "@shutter-network/concorde/pi";
 * import { templateHandler } from "@shutter-network/concorde/signals";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   handlers: () => ({
 *     "note.written": templateHandler({
 *       template: readFileSync(new URL("./prompts/note-written.hbs", import.meta.url), "utf8"),
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

export type { Auth, AuthOutcome } from "./auth.ts";
export { NoAuthRegisteredError } from "./auth.ts";
export type {
  Component,
  Gateway,
  ListeningServer,
  ServerComponent,
  ServerComponentOptions,
} from "./components.ts";
export { createBareGateway, serverComponent } from "./components.ts";
export type { GatewayExtension, GatewayOptions, InfraComponents } from "./gateway.ts";
export { createGateway } from "./gateway.ts";
