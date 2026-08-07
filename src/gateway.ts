/**
 * The infrastructure constructor: the Db, both servers, and the Signal Worker.
 *
 * One call builds what every deployment needs, hands it to the Operator's `extend`, and
 * answers with a Gateway. The opinionated components are not built here. Each is a one-line
 * `create*` call inside `extend`, so a deployment builds only the ones it wants.
 *
 * ## The order
 *
 * ```text
 * start:  db -> agentServer -> publicServer -> <extend's Components> -> worker
 * stop:   worker(drain) -> <extend's Components> -> publicServer -> agentServer -> db
 * ```
 *
 * The Signal Worker's `stop` is the only stop that does work. It waits for the Run in
 * flight. That Run reads the Db and reaches the Operator's own components. So the Worker is
 * keyed last and drains first, while everything else is still live.
 *
 * Both servers keep listening through the drain. A Message submitted then is stored, its
 * Signal stays `pending`, and the next boot runs it.
 */

import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifyListenOptions } from "fastify";
import Fastify from "fastify";
import { type Component, createBareGateway, type Gateway, serverComponent } from "./components.ts";
import { type Db, openDb } from "./db/index.ts";
import type { Logger } from "./logging.ts";
import type { Runtime, SignalHandler, SignalHandlers, SignalWorker } from "./signals/index.ts";
import { createSignalWorker } from "./signals/index.ts";

/**
 * The infrastructure every deployment has, under the keys it is filed under.
 *
 * This is the record `extend` receives, and the four keys `handlers` receives beside
 * whatever `extend` returned.
 *
 * This is not the start order. The Worker is keyed last in the Gateway's own record, so that
 * it drains while everything else is still live.
 */
export type InfraComponents = {
  db: Db;
  agentServer: Component & { readonly fastify: FastifyInstance };
  publicServer: Component & { readonly fastify: FastifyInstance };
  worker: SignalWorker;
};

/**
 * What `extend` can return: Components under keys of your own, and none of the four
 * infrastructure keys.
 *
 * The four are refused because a spread would overwrite one in silence. To run a Db, a server or
 * a Signal Worker of your own, call `createBareGateway` instead.
 */
export type GatewayExtension = Record<string, Component> & {
  [K in keyof InfraComponents]?: never;
};

/** Everything `createGateway` needs. Four required values, and four with defaults. */
export type GatewayOptions<E extends GatewayExtension> = {
  /**
   * Where the Db connects. The pool opens at `start`, not here.
   *
   * Required, and read from no environment. Construction throws and names this option when
   * it is absent.
   */
  readonly databaseUrl: string;
  /**
   * Drives the Agent Implementation. `createPiRuntime` from `shared-agent-framework/pi`
   * returns one.
   */
  readonly runtime: Runtime;
  /**
   * Where the Agent server binds. Use loopback.
   *
   * This server has no authentication at all, so reaching the port is read-write access to
   * everything on it. Where the agent's own container reaches this process is a second value.
   * State it in the instructions you mount into the Workspace.
   */
  readonly agentListen: FastifyListenOptions;
  /**
   * Where the Public server binds. This is the surface meant to be exposed, so loopback
   * inside a container reaches nobody.
   */
  readonly publicListen: FastifyListenOptions;
  /**
   * Components of your own, built from the infrastructure this call constructed.
   *
   * This is where the opinionated components go: the User Manager, Signatures, Decisions, the
   * Messenger with the one Channel that reaches people, and the Scheduler. What it returns is
   * keyed ahead of the Worker, so those Components stop after the drain. That is what a Signal
   * Handler's post phase needs.
   */
  readonly extend?: (components: InfraComponents) => E;
  /**
   * The `kind`-to-Handler map, built from the four infrastructure Components and whatever
   * `extend` returned.
   *
   * Required, and a callback because a Signal Handler usually needs a Component. It runs
   * after `extend`, so a Handler can reach a component of your own. `extend` cannot see the
   * handlers, which is the correct direction.
   */
  readonly handlers: (components: InfraComponents & E) => SignalHandlers;
  /** Defaults to a `pino` instance on stdout. The Signal Worker is what reads it. */
  readonly logger?: Logger;
  /** How often the Signal Worker sweeps for pending work, in milliseconds. Its own default. */
  readonly sweepIntervalMs?: number;
};

/**
 * The `version` both OpenAPI documents declare.
 *
 * A constant in source, because the document covers a deployment's API and not the
 * framework's. `gateway.test.ts` asserts it against the package manifest.
 */
export const describedVersion = "0.0.0";

/**
 * Registers one server's description: the OpenAPI document and the browsable page.
 *
 * Called before `extend`, because route discovery is an `onRoute` hook and every component
 * registers its routes in its own constructor. Neither route is configurable and neither can
 * be switched off.
 *
 * `/openapi.json` serves the document, and `/docs` is the page. Both are absent from the
 * document they serve, which a reader of it does not need.
 */
function describeSurface(fastify: FastifyInstance, title: string, description: string): void {
  fastify.register(fastifySwagger, {
    openapi: { openapi: "3.0.3", info: { title, description, version: describedVersion } },
  });
  fastify.register(fastifySwaggerUi, { routePrefix: "/docs" });
  // `fastify.swagger` is decorated on by the plugin above at boot. So this reads it per request
  // rather than closing over it. At the moment this route is declared there is no such method,
  // and the constructor is synchronous by design.
  fastify.get("/openapi.json", async () => fastify.swagger());
}

/**
 * Builds the infrastructure, runs `extend` and `handlers`, and answers with a Gateway.
 *
 * Nothing here connects, listens or applies DDL. Construction only registers routes on the
 * two servers. Your database already carries your own schema before you call `gateway.start()`.
 *
 * Register your own routes with `fastify.register`, not straight onto the instance. A route
 * written directly on the instance is served and absent from the OpenAPI document.
 *
 * @param options Where the Db connects, where each server binds, the Runtime, and the two
 *   callbacks that build the rest.
 * @returns A Gateway whose `components` holds the four infrastructure keys and everything
 *   `extend` returned.
 * @throws If `databaseUrl` is absent.
 *
 * @example
 * ```ts
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   agentListen: { host: "127.0.0.1", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, agentServer, publicServer }) => ({
 *     users: createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer }),
 *   }),
 *   handlers: ({ users }) => ({
 *     "note.written": templateHandler({
 *       template: new URL("./prompts/note-written.hbs", import.meta.url),
 *       session: () => "notes",
 *       data: async (signal) => ({ payload: signal.payload, users: await users.list() }),
 *     }),
 *   }),
 * });
 *
 * await gateway.start();
 * ```
 */
export function createGateway<E extends GatewayExtension = Record<string, never>>(
  options: GatewayOptions<E>,
): Gateway<InfraComponents & E> {
  // Checked here rather than left to `openDb`, so a JavaScript caller who omits it is told
  // which option to pass. Otherwise `pg` opens a pool against its own defaults and fails
  // later, with a message about a database nobody named.
  const { databaseUrl } = options;
  if (databaseUrl === undefined) {
    throw new Error("there is no database to open: pass databaseUrl");
  }
  const db = openDb(databaseUrl);

  // Two bare instances, and the only thing stated about either is where it listens. A
  // deployment that needs Fastify options of its own, such as `trustProxy`, leaves this
  // constructor for `createBareGateway`. Everything after construction is still reachable,
  // because the instances are on `.fastify`.
  const agentServer = serverComponent(Fastify(), options.agentListen);
  const publicServer = serverComponent(Fastify(), options.publicListen);

  // Before `extend`, and that is load-bearing. Route discovery is an `onRoute` hook, and every
  // component registers its routes in its own constructor. A route queued before the hook is
  // invisible to it. Move these two calls down and both documents are empty, silently.
  describeSurface(
    agentServer.fastify,
    "Shared Agent Gateway: Agent server",
    "The HTTP surface only the Agent Implementation reaches. It has no authentication of any kind: reaching this port is read-write access to everything described here, and there is no credential to find or to present (ADR-0010).",
  );
  describeSurface(
    publicServer.fastify,
    "Shared Agent Gateway: Public server",
    "The HTTP surface exposed outside the Gateway. A User trades a password for a bearer Token at `POST /auth/tokens` and presents it as `Authorization: Bearer …` on every route that acts as somebody (ADR-0030).",
  );

  // The map the worker holds, empty until the two callbacks have run. The worker keeps this
  // exact object and reads `handlers[signal.kind]` at dispatch, so filling it below fills the
  // worker's own map. Nothing can dispatch before `start`. This is what breaks the cycle
  // between the worker, the handlers and a Messenger the post phase calls.
  const handlers: Record<string, SignalHandler> = {};

  const worker = createSignalWorker({
    db,
    runtime: options.runtime,
    handlers,
    agentServer,
    // Spread rather than passed, because `exactOptionalPropertyTypes` distinguishes an absent
    // option from one that is `undefined`. Only the absent one gets the worker's own default.
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
  });

  // The infrastructure handed to `extend`. The worker is in it, but it is keyed last in the
  // returned record below, not here.
  const infra: InfraComponents = { db, agentServer, publicServer, worker };

  // `{} as E` because there is no value this function can construct that TypeScript will accept
  // as an arbitrary `E`. It is only ever reached when the caller supplied no `extend`, in which
  // case `E` is the parameter's default, `Record<string, never>`.
  const extension: E = options.extend === undefined ? ({} as E) : options.extend(infra);

  // Key order is start order, and it is not the construction order above. The Worker is keyed
  // last so that it stops first. The servers, the Db and whatever `extend` built are all still
  // live while it drains.
  const components = {
    db,
    agentServer,
    publicServer,
    ...extension,
    worker,
  } as InfraComponents & E;

  // And the cycle closed, into the map the worker has been holding since it was built.
  Object.assign(handlers, options.handlers(components));

  return createBareGateway(components);
}
