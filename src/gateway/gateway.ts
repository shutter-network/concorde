/**
 * Two orderings in this file are load-bearing, and both fail silently when they are undone.
 *
 * `describeSurface` runs **before** `extend`. Route discovery is an `onRoute` hook and every part
 * registers its routes inside its own constructor, so a route queued before the hook is invisible
 * to it. Move the two calls below `extend` and both OpenAPI documents are empty, with nothing on
 * the console (ADR-0040, ADR-0045).
 *
 * The `handlers` map is built empty, handed to the worker, and filled by `Object.assign` at the
 * end. That is what breaks the cycle between the worker, the Signal Handlers and a component a
 * post phase calls. The worker keeps that exact object and reads it at dispatch, and nothing can
 * dispatch before `start`.
 */

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

/**
 * The four parts every deployment has, under the keys they are filed under.
 *
 * This is what `extend` is handed, and the four keys `handlers` is handed beside whatever `extend`
 * returned. The same four keys are on `gateway.components` afterwards.
 */
export type InfraComponents = {
  db: Db;
  /**
   * Where the agent's routes go, and the server nothing authenticates on.
   *
   * It carries `registerAuth` and `requireUser` like the Public one, and nobody should use either.
   * Every caller here is trusted, so no Auth is meant to register, and a route on this server that
   * takes `requireUser` throws on every request instead of serving one.
   */
  agentServer: ServerComponent<FastifyInstance>;
  /**
   * The exposed server, and where every Auth registers itself.
   *
   * It is built before `extend` runs and holds no component, so an Auth registers with it from its
   * own constructor and the order they are asked in is the order they were constructed in.
   */
  publicServer: ServerComponent<FastifyInstance>;
  worker: SignalWorker;
};

/**
 * What `extend` may return: Components under keys of your own, and none of the four infrastructure
 * keys.
 *
 * Those four are a type error rather than a substitution, because a spread would overwrite one in
 * silence. Call {@link createBareGateway} to run a Db, a server or a Signal Worker of your own.
 */
export type GatewayExtension = Record<string, Component> & {
  [K in keyof InfraComponents]?: never;
};

export type GatewayOptions<E extends GatewayExtension> = {
  /**
   * Where the Db connects. Nothing is on the wire until `start`, so a URL that answers nowhere
   * fails there and not here.
   *
   * No environment is read for it. Construction throws and names this option when it is absent,
   * which is the one refusal a JavaScript caller can reach.
   */
  readonly databaseUrl: string;
  /**
   * What a Prompt is handed to, and what an outcome comes back from.
   *
   * `createPiRuntime` on `@shutter-network/concorde/pi` returns one for `pi`, and
   * `createAgentContainerRuntime` on `@shutter-network/concorde/agent-container` builds one for any
   * other agent program.
   */
  readonly runtime: Runtime;
  /**
   * Where the Agent server binds. Use loopback.
   *
   * Nothing on this server authenticates anything, so reaching the port is read and write access
   * to every route on it. Where the agent's own container reaches this process is a second value
   * and is not derived from this one: state it in the instructions you mount into the Workspace.
   */
  readonly agentListen: FastifyListenOptions;
  /**
   * Where the Public server binds. This is the surface meant to be exposed, so loopback inside a
   * container reaches nobody.
   */
  readonly publicListen: FastifyListenOptions;
  /**
   * Builds Components of your own out of the four this call constructed, and returns them under
   * keys of your own.
   *
   * Every component this call does not build is constructed here, one `create*` each: Users,
   * Signatures, Decisions, the Messenger with the single Channel that reaches people, and the
   * Scheduler. A deployment that wants none of them omits this callback.
   */
  readonly extend?: (components: InfraComponents) => E;
  /**
   * Builds the `kind`-to-Handler map out of the four infrastructure Components and whatever
   * `extend` returned.
   *
   * A callback, because a Signal Handler almost always closes over a Component. It runs after
   * `extend` and cannot be seen by it, so a Handler reaches a component of your own and never the
   * reverse.
   */
  readonly handlers: (components: InfraComponents & E) => SignalHandlers;
  /**
   * Where the Signal Worker logs, and where a refused request's `detail` is written. Defaults to a
   * `pino` instance on stdout.
   *
   * It reaches the Worker and both servers, which are the parts this call builds. A component built
   * in `extend` takes its own.
   */
  readonly logger?: Logger;
  /**
   * How often the Signal Worker looks for Signals left pending, in milliseconds, in place of the
   * Worker's own interval.
   *
   * It is the backstop and not the normal path, an emitted Signal waking the Worker as it is
   * written, so this is how long a Signal can wait when a wake-up went missing.
   */
  readonly sweepIntervalMs?: number;
};

/**
 * The `version` both OpenAPI documents declare, which is the version of this package.
 *
 * A literal and not a manifest read, because nothing shipped resolves a path out of
 * `import.meta.url` and `dist/gateway/gateway.js` therefore cannot reach `package.json` at run
 * time. It is not hand-maintained either: `npm version` runs `scripts/stamp-version.ts`, which
 * writes this line and stages it, so the release commit carries both numbers or neither.
 */
export const describedVersion = "0.1.0";

/**
 * Registers one server's description: the OpenAPI document at `/openapi.json`, and the browsable
 * page at `/docs`. Neither is configurable and neither can be switched off. Both are absent from
 * the document they serve, which nobody reading it needs.
 *
 * Every caller of this must stay above `extend`; see the file header.
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
 * Builds the Db, both self-describing servers and the Signal Worker, runs `extend` and then
 * `handlers`, and answers with a Gateway holding those four under `db`, `agentServer`,
 * `publicServer` and `worker`, beside whatever `extend` returned.
 *
 * Nothing connects, listens or applies DDL. Construction registers routes and returns, so the
 * database has to be carrying your own tables by the time you call `gateway.start()`.
 *
 * Register routes of your own with `fastify.register` rather than writing them onto the instance.
 * A route written straight onto it is served, and absent from the OpenAPI document.
 *
 * @throws If `databaseUrl` is absent.
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
  //
  // The Logger is spread rather than passed, because `exactOptionalPropertyTypes` distinguishes
  // an absent option from one that is `undefined`, and only the absent one gets pino.
  const logging = options.logger === undefined ? {} : { logger: options.logger };
  const agentServer = serverComponent(Fastify(), options.agentListen, logging);
  const publicServer = serverComponent(Fastify(), options.publicListen, logging);

  // Before `extend`, and see the file header for why that cannot move.
  describeSurface(
    agentServer.fastify,
    "Concorde Gateway: Agent server",
    "The HTTP surface the agent reaches the Gateway on, and nothing else should. It has no authentication of any kind, so reaching this port is read and write access to everything described here. There is no credential to present and none to find.",
  );
  describeSurface(
    publicServer.fastify,
    "Concorde Gateway: Public server",
    "The HTTP surface exposed outside the Gateway. Trade a password for a bearer Token at `POST /auth/tokens`, then send it as `Authorization: Bearer …` on every route that acts as somebody. A route that asks for none says so.",
  );

  // The map the worker holds, empty until the two callbacks below have run. Filling it at the end
  // of this function fills the worker's own; see the file header for the cycle that breaks.
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

  // The infrastructure handed to `extend`, the worker among it: a component of the Operator's own
  // takes it to emit a Signal.
  const infra: InfraComponents = { db, agentServer, publicServer, worker };

  // `{} as E` because there is no value this function can construct that TypeScript will accept
  // as an arbitrary `E`. It is only ever reached when the caller supplied no `extend`, in which
  // case `E` is the parameter's default, `Record<string, never>`.
  const extension: E = options.extend === undefined ? ({} as E) : options.extend(infra);

  // The record the Gateway is assembled from: the four this call built, and whatever `extend`
  // returned. The type forbids an extension key that collides with one of the four.
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
