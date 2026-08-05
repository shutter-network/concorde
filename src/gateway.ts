/**
 * The infrastructure constructor: one call that builds the Components every deployment
 * needs no matter what it does — the Db, both self-describing servers and the Signal
 * Worker — hands them to the Operator's `extend`, and answers with a Gateway
 * ([ADR-0045](../docs/adr/0045-the-framework-builds-only-the-irreducible-infrastructure.md)).
 *
 * This supersedes ADR-0038's eight-part assembly. That one built a User Manager, a signing
 * identity, a Decision log and messaging into every deployment and required a `signingKey` of
 * one that published nothing, on an opinion the framework had no firm basis for. The opinion
 * was never the wiring or the order — those are facts identical in every deployment that uses
 * these parts, and a constructor that spares each Operator rediscovering them is worth having.
 * So the four opinionated parts move out of this function's body and into the Operator's
 * `extend`, each a one-line `create*` call wired from the infrastructure the callback hands it,
 * and only the ones a deployment actually wants. `example/main.ts` is the worked example of the
 * full stack; a deployment that publishes no Decision builds neither Signatures nor Decisions
 * and passes no key.
 *
 * It is still not a registry and still not a plugin host. Every Component below is constructed
 * by the same public constructor an Operator would call, with the same arguments, and
 * `createBareGateway` remains what this returns. An Operator whose infrastructure *shape*
 * differs — a server built with `trustProxy`, no Signal Worker, a Db opened another way —
 * calls `createBareGateway` with a record of their own, which is the escape one layer down and
 * reached only when even the infrastructure is not what this builds.
 *
 * ## The order, and where the Worker sits in it
 *
 * ```
 * start:  db -> agentServer -> publicServer -> <extend's Components> -> worker
 * stop:   worker(drain) -> <extend's Components> -> publicServer -> agentServer -> db
 * ```
 *
 * **The Signal Worker's `stop` is the only stop that does work.** Every other one releases
 * something. The worker's waits for the Run in flight and never cancels it
 * ([ADR-0017](../docs/adr/0017-failed-runs-are-not-retried.md)), and that Run reads the Db,
 * calls the Agent server the Operator's own `AGENTS.md` gave it the URLs for, and reaches an
 * Operator's own parts — a Messenger, a Decision log — through a Signal Handler's post phase.
 * So the drain goes **first**, while every server is still listening, the Operator's parts are
 * still live and the pool is still open.
 *
 * That is why the Worker is **keyed last** in the record this returns, although it is
 * constructed early: construction order is not key order, and keying it last is what leaves the
 * servers, the Db and the Operator's own parts alive through the drain. Whatever `extend`
 * returns is keyed **ahead of** the Worker, so those Components stop *after* the drain rather
 * than before it — right for a resource the drain uses, such as the Messenger a post phase
 * calls, and a change from ADR-0038, where the extension was appended and stopped first.
 *
 * Which leaves the two servers together and the Public server accepting submissions throughout
 * the drain — the thing [ADR-0031](../docs/adr/0031-parts-that-run-are-components.md) had moved
 * away from. The trade is taken deliberately: a Message submitted during shutdown is stored, its
 * Signal commits with it and stays `pending`, the worker's `stop` has already closed the
 * `LISTEN` connection and cleared the ticker so nothing new starts, and the next boot picks it
 * up. What that person gets is silence until the Gateway is back rather than a refused
 * connection now.
 *
 * ## The construction cycle, and the one mutation that breaks it
 *
 * The Signal Worker takes its Handler map at construction
 * ([ADR-0031](../docs/adr/0031-parts-that-run-are-components.md)), an Operator's HTTP Messenger
 * takes the Signal Worker
 * ([ADR-0034](../docs/adr/0034-the-http-messenger-is-an-opinionated-messenger.md)), and a
 * Handler's post phase calls `messenger.send` to tell somebody their Run failed, which is the
 * only path by which a failed Run reaches the person waiting (ADR-0017). So the worker needs the
 * handlers, the handlers need the Messenger, and the Messenger needs the worker.
 *
 * It is broken here, by construction order and one mutation: the worker is built with an empty
 * map, `extend` runs and builds the Messenger against the worker, `handlers` runs, and the
 * result is written into the map the worker is holding. The worker reads `handlers[signal.kind]`
 * at dispatch, so nothing about the worker changes. Nothing can dispatch before `start`, and
 * `handlers` is a required option, so "a Signal Worker with no Handlers is unconstructable"
 * survives with the same force it had. The Operator does not reproduce the empty-map mutation by
 * hand; this function does it for them.
 *
 * **The Gateway is not passed to the Handler**, and
 * [ADR-0024](../docs/adr/0024-signal-handlers-receive-only-the-signal.md) already rejected the
 * smaller version of that. Two things make it worse here: `Gateway` is generic in a record the
 * Signal Worker is *inside*, so a Handler parameter typed `Gateway<C>` would define `C` in terms
 * of itself, and the only escape erases the record and hands a Handler a `messenger` with no
 * `send` on it. A callback gives the Handler's *author* every part, named and precisely typed,
 * one step earlier and at no cost.
 *
 * ## The third reason the order is load-bearing
 *
 * Both servers describe themselves, in OpenAPI at `/openapi.json` and as a browsable page at
 * `/docs`, and **this constructor is the only party that can arrange it**
 * ([ADR-0040](../docs/adr/0040-the-gateway-describes-its-own-http-api.md)).
 * `@fastify/swagger` discovers routes through an `onRoute` hook, so a route registered before it
 * is invisible to it, and every part registers its routes inside its own constructor — including
 * the parts an Operator builds in `extend`. So the description goes on both instances **before
 * `extend` is called**, and there is no window in which registering it inside `extend` or after
 * this function returns would work.
 *
 * That is the whole of why the description registration is here rather than anywhere an Operator
 * could put it, and construction order in this function is load-bearing for it as well as for
 * the cycle above. It fails the most quietly of the two: get it wrong and both documents are
 * empty, with no error anywhere.
 *
 * ## What it declines to construct
 *
 * **The four opinionated parts**, which are the Operator's now and live in `extend`. **The
 * Runtime**, which is an option, so nothing here imports `./pi/` and the package root stays
 * agnostic about the Agent Implementation
 * ([ADR-0033](../docs/adr/0033-an-agent-is-a-container-and-one-function.md)). **Fastify's
 * constructor options**, so there is no bring-your-own-instance escape and the only thing stated
 * is where each server listens. **Either bind address**, which is the one pair of values where a
 * wrong default is worse than no default: a Public server on loopback serves nobody, and an
 * Agent server anywhere else is an unauthenticated API on a reachable port. And **migrations**:
 * `start` does not apply them, and the Operator calls `gateway.components.db.migrate()` between
 * construction and `start`
 * ([ADR-0032](../docs/adr/0032-components-wire-themselves-at-construction.md)).
 *
 * ## It reads no environment
 *
 * `databaseUrl` is required, and there is no fallback to `DATABASE_URL`. That fallback was the
 * only `process.env` read in the shipped package, the one input a caller could not see at the
 * call site, and ADR-0038 recorded it as a wart rather than defending it. With the Operator
 * already reading `HOST_DIR`, `SIGNING_KEY_FILE` and the model credential by hand
 * ([ADR-0016](../docs/adr/0016-agent-configuration-is-opaque-to-the-framework.md),
 * [ADR-0041](../docs/adr/0041-the-shared-agent-has-a-signing-identity.md)), the framework
 * reading a fourth variable for them was the odd one out. The Operator reads `DATABASE_URL`
 * itself now, one line in `main.ts`, and "the framework parses nothing and reads nothing" is
 * whole.
 *
 * ## The one shipped module that imports a value from `fastify`
 *
 * Everything else in this package names Fastify's types and never its runtime, which is what
 * lets `serverComponent` be structural and `fastify` a peer dependency this package imports
 * nothing from. This module constructs two servers, so it is the exception, and
 * `scripts/check-package.ts` names it as the exception rather than dropping the check.
 * `fastify` stays a *peer* dependency: a `dependencies` entry would bring a second copy into
 * every consumer's tree, and instances built here would then not be instances of the Fastify a
 * consumer's own plugins were written against (ADR-0021).
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
 * The infrastructure every deployment has regardless of what it does, under the keys it is filed
 * under. This is the record `extend` receives and the four keys `handlers` receives alongside
 * whatever `extend` returned.
 *
 * **This is not the start order.** The Worker is keyed last in the returned record even though it
 * is a key of this type: construction order is not key order, and keying it last is what keeps
 * the drain running while everything else is live (see this file's header).
 *
 * The two servers are the shape `serverComponent` returns rather than a named type, because that
 * is all they are: a `listen` address held until `start`, with the instance on `.fastify` so an
 * Operator's own routes, plugins and hooks — and the parts they build in `extend` — go on the
 * same servers.
 */
export type InfraComponents = {
  db: Db;
  agentServer: Component & { readonly fastify: FastifyInstance };
  publicServer: Component & { readonly fastify: FastifyInstance };
  worker: SignalWorker;
};

/**
 * What `extend` may return: Components under keys of the Operator's own, and **none of the four
 * infrastructure keys**.
 *
 * The refusal is the point. A JavaScript spread overwrites the value and keeps the original key's
 * position, so replacing an infrastructure Component in place would otherwise be silent — a
 * substituted Worker would start where the framework's would have and nothing anywhere would say
 * so (ADR-0037). `?: never` is what makes it a compile error, and under
 * `exactOptionalPropertyTypes` it means the key may be absent and nothing else.
 *
 * An Operator who really wants a Worker of their own is writing `createBareGateway` by hand,
 * which is the honest way to say it.
 *
 * It is written over `keyof InfraComponents` rather than as a list, so a key added to the
 * infrastructure record is forbidden here by the same edit that added it.
 */
export type GatewayExtension = Record<string, Component> & {
  [K in keyof InfraComponents]?: never;
};

export type GatewayOptions<E extends GatewayExtension> = {
  /**
   * Where the Db connects. The pool opens at `start`, not here.
   *
   * **Required**, and read from no environment: construction throws naming this option when it is
   * absent. `pg`'s own fallbacks are deliberately not reached for: with no connection string it
   * reads `PGHOST` and friends and lands on `localhost:5432` with this process's login name as
   * the user and the database, which is a confident answer to a question nobody asked. Where the
   * URL comes from — a file, an environment variable, a secrets manager — is the Operator's, the
   * same division `HOST_DIR` and `SIGNING_KEY_FILE` are on (ADR-0016, ADR-0045).
   */
  readonly databaseUrl: string;
  /**
   * Drives the Agent Implementation. An option and not a spec, which is why nothing here
   * imports `shared-agent-framework/pi`.
   *
   * Taking a container spec instead was considered and would have defaulted nothing: the
   * image, the environment, the networks and the Mount Table are four deployment-specific
   * values, and forwarding them is pass-through dressed up as convenience. The Mount Table
   * in particular is where a deployment keeps its real hazards, and hiding it behind an
   * options key would suggest the framework had an opinion about the agent when it has none
   * (ADR-0033).
   */
  readonly runtime: Runtime;
  /**
   * Where the Agent server binds. Loopback is the address to want: this server has no
   * authentication at all, so reaching the port is read-write access to everything on it
   * ([ADR-0010](../docs/adr/0010-the-agent-reaches-the-gateway-over-http.md)).
   *
   * Where the agent's container *reaches* this process is a second value that cannot be
   * derived from this one, and it is not here at all: it belongs in the instructions the
   * Operator mounts into the Workspace (ADR-0025).
   */
  readonly agentListen: FastifyListenOptions;
  /**
   * Where the Public server binds. This is the surface meant to be exposed, and a Public
   * server on loopback inside a container is reachable by nobody at all.
   */
  readonly publicListen: FastifyListenOptions;
  /**
   * Components of the Operator's own, built from the infrastructure this call constructed — and
   * where the four opinionated parts go: the User Manager, Signatures, Decisions and the HTTP
   * Messenger, each a one-line `create*` call, and only the ones this deployment wants.
   *
   * A callback because it needs objects constructed in this function's body. What it returns is
   * keyed **ahead of the Worker**, so those Components start before the Worker and therefore stop
   * *after* the drain — right for a resource the drain uses, such as the Messenger a Handler's
   * post phase calls. An Operator building the full stack constructs the User Manager **before**
   * the HTTP Messenger, because `messages.user_id` is a foreign key onto `saf_users.users.id` and
   * `db.migrate()` applies descriptors in registration order (ADR-0036); getting it wrong fails
   * loudly at the first migration.
   */
  readonly extend?: (components: InfraComponents) => E;
  /**
   * The `kind`-to-Handler map, built from the four infrastructure Components **and** whatever
   * `extend` returned.
   *
   * Required, and a callback for the reason `extend` is plus one more: there is a genuine
   * construction cycle behind it, described in this file's header, and this callback is where it
   * is broken. It runs *after* `extend` because a Signal Handler may well need an Operator's own
   * Component, and the reverse ordering would be strictly less useful; `extend` therefore cannot
   * see the handlers, which is the correct direction, since a Component that needed a Handler
   * would be a Component that wanted to be a Signal Worker.
   */
  readonly handlers: (components: InfraComponents & E) => SignalHandlers;
  /** Defaults to a `pino` instance on stdout. The Signal Worker is what reads it. */
  readonly logger?: Logger;
  /** How often the Signal Worker sweeps for pending work, in milliseconds. Its own default. */
  readonly sweepIntervalMs?: number;
};

/**
 * The `version` both documents declare, and a constant in source rather than a read of
 * the package manifest.
 *
 * OpenAPI requires the field and it **describes the wrong thing** however it is obtained:
 * the document covers a *deployment's* API, including whatever routes the Operator
 * registered themselves, so the framework's own version is a category error. Reading
 * `package.json` at runtime was rejected for buying a more precisely wrong answer at the
 * price of a file read inside a constructor documented as doing no I/O
 * ([ADR-0040](../docs/adr/0040-the-gateway-describes-its-own-http-api.md)).
 *
 * A hand-maintained value with no reader is exactly the thing that drifts, so
 * `gateway.test.ts` asserts this against the manifest.
 */
export const describedVersion = "0.0.0";

/**
 * Registers one server's description: the OpenAPI document, the browsable page, and the
 * conventional path the document answers on.
 *
 * Called **before `extend` is called**, for the reason this file's header gives. Neither route is
 * configurable and neither can be switched off. An Operator who objects to a public `/docs`
 * leaves this constructor; an Operator who already owns either path collides at `ready()`, which
 * is loud (ADR-0040).
 *
 * `/openapi.json` is added even though `@fastify/swagger-ui` already serves the document
 * at `/docs/json`, because the agent's instructions should name a guessable URL rather
 * than an implementation detail of a UI package that may later be swapped. Both of these
 * routes, and the UI's own, are **absent from the document they serve**: this one is
 * declared directly on the instance, where Fastify fires `onRoute` synchronously and the
 * queued plugin has therefore not added its hook yet, and the UI's are registered by a
 * plugin of its own. That is correct rather than a bug: a description of itself is the
 * one thing a reader of it does not need.
 *
 * The same fact has a sharper edge for an Operator, and it is worth knowing before it is
 * discovered. A route written straight onto the instance,
 * `gateway.components.publicServer.fastify.get("/ask", …)`, is invisible to the document
 * when it is written in the same unbooted stretch this constructor returned into, because
 * the hook is added by a registration that has not run yet. The same route inside a
 * `register` call is discovered, whenever it is written, since the plugin's own body runs
 * at boot and the hook is there by then. **Register, and it is documented**, which is the
 * door [ADR-0032](../docs/adr/0032-components-wire-themselves-at-construction.md) already
 * points at. `gateway.test.ts` pins both spellings, because the difference between them is a
 * Fastify fact rather than a choice of ours and the failure it produces is silent.
 */
function describeSurface(fastify: FastifyInstance, title: string, description: string): void {
  fastify.register(fastifySwagger, {
    openapi: { openapi: "3.0.3", info: { title, description, version: describedVersion } },
  });
  fastify.register(fastifySwaggerUi, { routePrefix: "/docs" });
  // `fastify.swagger` is decorated on by the plugin above at boot, so this reads it per
  // request rather than closing over it: at the moment this route is declared there is no
  // such method, and the constructor is synchronous by design (ADR-0032).
  fastify.get("/openapi.json", async () => fastify.swagger());
}

/**
 * Builds the infrastructure, registers the description, runs `extend` and `handlers`, orders the
 * record, and answers with a Gateway.
 *
 * The type parameter's **default is load-bearing** and is not decoration. With `extend` omitted
 * there is nothing to infer `E` from, and a type parameter with no inference candidates falls
 * back to its constraint — which here carries `db?: never` and every other infrastructure key, so
 * `InfraComponents & E` would reduce the whole record to `never` and `gateway.components.db` would
 * stop existing. `Record<string, never>` is the empty extension, satisfies the constraint, and
 * intersects with `InfraComponents` to leave it exactly as it is.
 *
 * Nothing here connects, listens or migrates: construction is free of side effects beyond the
 * registrations each part makes on the Db and on the two servers (ADR-0032). The Operator calls
 * `gateway.components.db.migrate()` next, and then `gateway.start()`.
 */
export function createGateway<E extends GatewayExtension = Record<string, never>>(
  options: GatewayOptions<E>,
): Gateway<InfraComponents & E> {
  // Required and read from no environment. The check is here rather than left to `openDb` so an
  // Operator who omits it — a JavaScript caller, since the type forbids it — is told which option
  // to pass rather than watching `pg` open a pool against its own defaults and fail somewhere
  // later with a message about a database nobody named (ADR-0045).
  const { databaseUrl } = options;
  if (databaseUrl === undefined) {
    throw new Error("there is no database to open: pass databaseUrl");
  }
  const db = openDb(databaseUrl);

  // Two bare instances, and the only thing stated about either is where it listens. There is no
  // bring-your-own-instance escape and that is a real limit rather than an oversight: a Public
  // server behind a reverse proxy wants `trustProxy`, which is not exotic, and getting it means
  // leaving this constructor for `createBareGateway` (ADR-0045). What is *not* out of reach is
  // anything after construction — the instances are on `.fastify`, so routes, plugins and hooks
  // are unaffected.
  const agentServer = serverComponent(Fastify(), options.agentListen);
  const publicServer = serverComponent(Fastify(), options.publicListen);

  // **Before `extend`**, and that is the whole of why these two calls are here rather than
  // anywhere an Operator could put them: route discovery is an `onRoute` hook, every part — the
  // ones `extend` builds included — registers its routes inside its own constructor, and a route
  // queued before the hook is invisible to it. Both documents would be empty, with no error
  // anywhere (ADR-0040).
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

  // The map the worker holds, empty for as long as it takes to run the two callbacks. This is the
  // mutation the cycle in the header is broken by: the worker keeps this exact object and reads
  // `handlers[signal.kind]` at dispatch, so filling it below is filling the worker's own map.
  // Nothing can dispatch before `start`.
  const handlers: Record<string, SignalHandler> = {};

  const worker = createSignalWorker({
    db,
    runtime: options.runtime,
    handlers,
    agentServer,
    // Spread rather than passed, because `exactOptionalPropertyTypes` distinguishes an absent
    // option from one that is `undefined`, and only the absent one gets the worker's own default.
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
  });

  // The infrastructure handed to `extend`. The worker is in it, but it is keyed **last** in the
  // returned record below, not here.
  const infra: InfraComponents = { db, agentServer, publicServer, worker };

  // `{} as E` because there is no value this function can construct that TypeScript will accept as
  // an arbitrary `E`. It is the empty extension, and it is only ever reached when the caller
  // supplied no `extend` — in which case `E` is the parameter's default, `Record<string, never>`,
  // and the empty object is precisely one of those.
  const extension: E = options.extend === undefined ? ({} as E) : options.extend(infra);

  // The record, whose key order is the start order and is **not** the construction order above:
  // the Worker is keyed last so that it is stopped *first*, while the servers, the Db and
  // whatever `extend` built are all still live — which is when a Signal Handler's post phase
  // reaches an Operator's Messenger or Decision log (ADR-0043, ADR-0045). Everything `extend`
  // returned is keyed between the servers and the Worker, so it stops after the drain.
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
