import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifyListenOptions } from "fastify";
import Fastify from "fastify";
import { type Db, openDb } from "../db/index.ts";
import type { Logger } from "../logging/logging.ts";
import type { Runtime, SignalHandler, SignalHandlers, SignalWorker } from "../signals/index.ts";
import { createSignalWorker } from "../signals/index.ts";
import {
  type Component,
  createBareGateway,
  type Gateway,
  type ServerComponent,
  serverComponent,
} from "./components.ts";

export type InfraComponents = {
  db: Db;
  agentServer: ServerComponent<FastifyInstance>;
  publicServer: ServerComponent<FastifyInstance>;
  worker: SignalWorker;
};

export type GatewayExtension = Record<string, Component> & {
  [K in keyof InfraComponents]?: never;
};

export type GatewayOptions<E extends GatewayExtension> = {
  readonly databaseUrl: string;
  readonly runtime: Runtime;
  /** This server has no authentication. Bind it to a network reachable only by trusted callers. */
  readonly agentListen: FastifyListenOptions;
  readonly publicListen: FastifyListenOptions;
  readonly extend?: (components: InfraComponents) => E;
  readonly handlers: (components: InfraComponents & E) => SignalHandlers;
  /**
   * Defaults to Pino on stdout. Applies to the worker and both servers; extension components
   * configure their own loggers.
   */
  readonly logger?: Logger;
  /** Fallback polling interval in milliseconds; defaults to 5,000. Signals normally wake the worker at commit. */
  readonly sweepIntervalMs?: number;
};

export const describedVersion = "0.1.1-test.1";

function describeSurface(fastify: FastifyInstance, title: string, description: string): void {
  fastify.register(fastifySwagger, {
    openapi: { openapi: "3.0.3", info: { title, description, version: describedVersion } },
  });
  fastify.register(fastifySwaggerUi, { routePrefix: "/docs" });
  fastify.get("/openapi.json", async () => fastify.swagger());
}

/**
 * Constructs and registers routes without connecting or listening. Apply the database schema
 * before calling `start()`. The signal worker starts last and stops first.
 *
 * `extend` runs before `handlers`; both run during construction. Register custom routes through
 * `fastify.register` so they appear in the server's OpenAPI document.
 */
export function createGateway<E extends GatewayExtension = Record<string, never>>(
  options: GatewayOptions<E>,
): Gateway<InfraComponents & E> {
  const { databaseUrl } = options;
  if (databaseUrl === undefined) {
    throw new Error("Missing databaseUrl. Pass a PostgreSQL connection URL.");
  }
  const db = openDb(databaseUrl);

  const logging = options.logger === undefined ? {} : { logger: options.logger };
  const agentServer = serverComponent(Fastify(), options.agentListen, logging);
  const publicServer = serverComponent(Fastify(), options.publicListen, logging);

  // Install Swagger before extension constructors register routes; discovery uses an onRoute hook.
  describeSurface(
    agentServer.fastify,
    "Concorde: agent server",
    "Privileged HTTP API for the agent. This server has no authentication; restrict access to a private network.",
  );
  describeSurface(
    publicServer.fastify,
    "Concorde: public server",
    "HTTP API for user clients. Protected routes require a credential from an auth scheme installed in this deployment. If password auth is installed, obtain a bearer token from POST /auth/tokens.",
  );

  const handlers: Record<string, SignalHandler> = {};

  const worker = createSignalWorker({
    db,
    runtime: options.runtime,
    handlers,
    agentServer,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
  });

  const infra: InfraComponents = { db, agentServer, publicServer, worker };

  const extension: E = options.extend === undefined ? ({} as E) : options.extend(infra);

  const components = {
    db,
    agentServer,
    publicServer,
    ...extension,
    worker,
  } as InfraComponents & E;

  // The worker retains this object; populate it after extension components are available.
  Object.assign(handlers, options.handlers(components));

  return createBareGateway(components);
}
