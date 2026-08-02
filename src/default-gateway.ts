/**
 * The default assembly: one call that builds the six Components a deployment using our
 * parts would otherwise build by hand, wires them to each other, puts them in an order,
 * and answers with a Gateway
 * ([ADR-0038](../docs/adr/0038-the-default-assembly-is-a-constructor.md)).
 *
 * This reverses ADR-0021's "the Operator's entry point *is* that assembly", and what was
 * lost while that was true is worth naming: the reference deployment carried eighteen
 * lines of comment justifying the order of a four-item list, one sentence of which existed
 * only to say that the obvious grouping of the two servers is wrong. That reasoning was
 * correct, unavoidable and identical in every deployment that uses our parts, and asking
 * each Operator to reproduce it was asking them to rediscover a fact we already knew. The
 * same goes for the four wiring facts and for the construction order
 * [ADR-0036](../docs/adr/0036-the-http-messengers-user-id-is-a-foreign-key.md) forces.
 *
 * It is still not a registry and still not a plugin host. Every part below is constructed
 * by the same public constructor an Operator would call, with the same arguments, and
 * `createGateway` remains what this returns. An Operator who needs a different answer to
 * any of it calls `createGateway` with a record of their own — and that escape is not
 * cheap, which is the price this module charges and ADR-0038 states.
 *
 * ## The order, and the one rule it comes from
 *
 * ```
 * start:  db -> agentServer -> publicServer -> users -> messenger -> worker -> extend
 * stop:   extend -> worker(drain) -> messenger -> users -> publicServer -> agentServer -> db
 * ```
 *
 * **The Signal Worker's `stop` is the only stop that does work.** Every other one releases
 * something. The worker's waits for the Run in flight and never cancels it
 * ([ADR-0017](../docs/adr/0017-failed-runs-are-not-retried.md)), and that Run reads the Db,
 * calls the Agent server the Operator's own `AGENTS.md` gave it the URLs for, and reaches
 * the Messenger through a Signal Handler's post phase. So the drain goes **first**, while
 * every server is still listening, the Messenger is still live and the pool is still open.
 *
 * Which puts the two servers back together and leaves the Public server accepting
 * submissions throughout the drain — the thing
 * [ADR-0031](../docs/adr/0031-parts-that-run-are-components.md) had moved away from. The
 * trade is taken deliberately: a Message submitted during shutdown is stored, its Signal
 * commits with it and stays `pending`, the worker's `stop` has already closed the `LISTEN`
 * connection and cleared the ticker so nothing new starts, and the next boot picks it up.
 * What that person gets is silence until the Gateway is back rather than a refused
 * connection now.
 *
 * ## The construction cycle, and the one mutation that breaks it
 *
 * The Signal Worker takes its Handler map at construction
 * ([ADR-0031](../docs/adr/0031-parts-that-run-are-components.md)), the HTTP Messenger takes
 * the Signal Worker
 * ([ADR-0034](../docs/adr/0034-the-http-messenger-is-an-opinionated-messenger.md)),
 * and a Handler's post phase calls `messenger.send` to tell somebody their Run failed,
 * which is the only path by which a failed Run reaches the person waiting (ADR-0017). So
 * the worker needs the handlers, the handlers need the Messenger, and the Messenger needs
 * the worker.
 *
 * It is broken here, by construction order and one mutation: the worker is built with an
 * empty map, the Messenger is built against the worker, `extend` runs, `handlers` runs, and
 * the result is written into the map the worker is holding. The worker reads
 * `handlers[signal.kind]` at dispatch, so nothing about the worker changes. Nothing can
 * dispatch before `start`, and `handlers` is a required option, so "a Signal Worker with no
 * Handlers is unconstructable" survives with the same force it had.
 *
 * **The Gateway is not passed to the Handler**, and
 * [ADR-0024](../docs/adr/0024-signal-handlers-receive-only-the-signal.md) already rejected
 * the smaller version of that. Two things make it worse here: `Gateway` is generic in a
 * record the Signal Worker is *inside*, so a Handler parameter typed `Gateway<C>` would
 * define `C` in terms of itself, and the only escape erases the record and hands a Handler
 * a `messenger` with no `send` on it. A callback gives the Handler's *author* every part,
 * named and precisely typed, one step earlier and at no cost.
 *
 * ## What it declines to construct
 *
 * **The Runtime**, which is an option, so nothing here imports `./pi/` and the package root
 * stays agnostic about the Agent Implementation
 * ([ADR-0033](../docs/adr/0033-an-agent-is-a-container-and-one-function.md)). **Fastify's
 * constructor options**, so there is no bring-your-own-instance escape and the only thing
 * stated is where each server listens. **A `tokenTtl` default**, which `src/users/users.ts`
 * refuses on the grounds that the trade is the deployment's, and a convenience constructor
 * is not a reason to reverse a deliberate refusal. And **migrations**: `start` does not
 * apply them, and the Operator calls `gateway.components.db.migrate()` between construction
 * and `start` ([ADR-0032](../docs/adr/0032-components-wire-themselves-at-construction.md)).
 *
 * ## The one shipped module that imports a value from `fastify`
 *
 * Everything else in this package names Fastify's types and never its runtime, which is
 * what let `serverComponent` be structural and `fastify` be a peer dependency this package
 * imports nothing from. This module constructs two servers, so it is the exception, and
 * `scripts/check-package.ts` names it as the exception rather than dropping the check.
 * `fastify` stays a *peer* dependency: a `dependencies` entry would bring a second copy
 * into every consumer's tree, and instances built here would then not be instances of the
 * Fastify a consumer's own plugins were written against (ADR-0021).
 */

import type { FastifyInstance, FastifyListenOptions } from "fastify";
import Fastify from "fastify";
import { type Component, createGateway, type Gateway, serverComponent } from "./components.ts";
import { type Db, openDb } from "./db/index.ts";
import { createHttpMessenger, type HttpMessenger } from "./http-messenger/index.ts";
import type { Logger } from "./logging.ts";
import type { Runtime, SignalHandler, SignalHandlers, SignalWorker } from "./signals/index.ts";
import { createSignalWorker } from "./signals/index.ts";
import { createUsers, type Users } from "./users/index.ts";

/**
 * The six this constructor builds, under the keys it files them under — **and that is the
 * start order**, since a Gateway starts in key order and stops in the reverse of it
 * ([ADR-0037](../docs/adr/0037-the-gateway-is-a-record-of-components.md)).
 *
 * The two servers are the shape `serverComponent` returns rather than a named type, because
 * that is all they are: a `listen` address held until `start`, with the instance on
 * `.fastify` so an Operator's own routes, plugins and hooks go on the same servers ours do.
 */
export type DefaultComponents = {
  db: Db;
  agentServer: Component & { readonly fastify: FastifyInstance };
  publicServer: Component & { readonly fastify: FastifyInstance };
  users: Users;
  messenger: HttpMessenger;
  worker: SignalWorker;
};

/**
 * What `extend` may return: Components under keys of the Operator's own, and **none of the
 * six above**.
 *
 * The refusal is the point. A JavaScript spread overwrites the value and keeps the original
 * key's position, so replacing a default in place would otherwise be silent — a substituted
 * Messenger would start where the framework's would have and nothing anywhere would say so
 * (ADR-0037). `?: never` is what makes it a compile error, and under
 * `exactOptionalPropertyTypes` it means the key may be absent and nothing else.
 *
 * An Operator who really wants to substitute one is writing `createGateway` by hand, which
 * is the honest way to say it.
 */
export type GatewayExtension = Record<string, Component> & {
  [K in keyof DefaultComponents]?: never;
};

export type DefaultGatewayOptions<E extends GatewayExtension> = {
  /** Where the Db connects. The pool opens at `start`, not here. */
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
   * How long an issued Token lives, in milliseconds. Required and forwarded, because
   * `src/users/users.ts` refuses a default on the grounds that the trade is the
   * deployment's, and a convenience constructor is not a reason to reverse that.
   */
  readonly tokenTtl: number;
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
   * Components of the Operator's own, built from the six this call constructed.
   *
   * A callback because it needs objects constructed in this function's body. What it
   * returns is **appended**, so those Components start last and therefore stop *first* —
   * right for a Producer, which should stop producing before the worker drains, and wrong
   * for a resource the drain uses, such as an outbound client the Handlers call. The second
   * case is the one `extend` cannot express, and the answer is `createGateway`.
   */
  readonly extend?: (components: DefaultComponents) => E;
  /**
   * The `kind`-to-Handler map, built from the six defaults **and** whatever `extend`
   * returned.
   *
   * Required, and a callback for the reason `extend` is plus one more: there is a genuine
   * construction cycle behind it, described in this file's header, and this callback is
   * where it is broken. It runs *after* `extend` because a Signal Handler may well need an
   * Operator's own Component, and the reverse ordering would be strictly less useful;
   * `extend` therefore cannot see the handlers, which is the correct direction, since a
   * Component that needed a Handler would be a Component that wanted to be a Signal Worker.
   */
  readonly handlers: (components: DefaultComponents & E) => SignalHandlers;
  /** Defaults to a `pino` instance on stdout. The Signal Worker is what reads it. */
  readonly logger?: Logger;
};

/**
 * Builds the six, wires them, orders them, and answers with a Gateway.
 *
 * The type parameter's **default is load-bearing** and is not decoration. With `extend`
 * omitted there is nothing to infer `E` from, and a type parameter with no inference
 * candidates falls back to its constraint — which here carries `db?: never` and every other
 * default key, so `DefaultComponents & E` would reduce the whole record to `never` and
 * `gateway.components.db` would stop existing. `Record<string, never>` is the empty
 * extension, satisfies the constraint, and intersects with `DefaultComponents` to leave it
 * exactly as it is.
 *
 * Nothing here connects, listens or migrates: construction is free of side effects beyond
 * the registrations each part makes on the Db and on the two servers (ADR-0032). The
 * Operator calls `gateway.components.db.migrate()` next, and then `gateway.start()`.
 */
export function createGatewayWithDefaults<E extends GatewayExtension = Record<string, never>>(
  options: DefaultGatewayOptions<E>,
): Gateway<DefaultComponents & E> {
  const db = openDb(options.databaseUrl);

  // Two bare instances, and the only thing stated about either is where it listens. There
  // is no bring-your-own-instance escape and that is a real limit rather than an oversight:
  // a Public server behind a reverse proxy wants `trustProxy`, which is not exotic, and
  // getting it means leaving this constructor entirely (ADR-0038). What is *not* out of
  // reach is anything after construction — the instances are on `.fastify`, so routes,
  // plugins and hooks are unaffected.
  const agentServer = serverComponent(Fastify(), options.agentListen);
  const publicServer = serverComponent(Fastify(), options.publicListen);

  // Construction order from here on is load-bearing twice over, and neither reason is
  // visible in the record below.
  //
  // The User Manager is first of the three because registering a migration descriptor is
  // what a constructor does and `db.migrate()` applies them in registration order:
  // `messages.user_id` is a foreign key onto `saf_users.users.id`, so a Messenger
  // constructed before this fails the first migration of every new deployment with
  // PostgreSQL's `schema "saf_users" does not exist` (ADR-0036). On this path that order is
  // not expressible wrongly, which is most of what the path is for.
  const users = createUsers({
    db,
    tokenTtl: options.tokenTtl,
    agentServer,
    publicServer,
  });

  // The map the worker holds, empty for as long as it takes to construct the Messenger and
  // run the two callbacks. This is the mutation the cycle in the header is broken by: the
  // worker keeps this exact object and reads `handlers[signal.kind]` at dispatch, so
  // filling it below is filling the worker's own map. Nothing can dispatch before `start`.
  const handlers: Record<string, SignalHandler> = {};

  // Before the Messenger because the Messenger takes it: a submitted Message and the Signal
  // that wakes the worker for it are one transaction (ADR-0034).
  const worker = createSignalWorker({
    db,
    runtime: options.runtime,
    handlers,
    agentServer,
    // Spread rather than passed, because `exactOptionalPropertyTypes` distinguishes an
    // absent `logger` from one that is `undefined`, and only the absent one gets the
    // worker's own default. Writing the default here instead would be a second copy of it.
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const messenger = createHttpMessenger({ db, users, worker, publicServer, agentServer });

  // The record, whose key order is the start order and is **not** the construction order
  // above: the Messenger is keyed before the worker so that it is stopped *after* the
  // drain, which is when a Signal Handler's post phase reaches it.
  const defaults: DefaultComponents = { db, agentServer, publicServer, users, messenger, worker };

  // `{} as E` because there is no value this function can construct that TypeScript will
  // accept as an arbitrary `E`. It is the empty extension, and it is only ever reached when
  // the caller supplied no `extend` — in which case `E` is the parameter's default,
  // `Record<string, never>`, and the empty object is precisely one of those.
  const extension: E = options.extend === undefined ? ({} as E) : options.extend(defaults);

  // Appended, so an Operator's own Components start last and stop first (ADR-0038). A key
  // collision cannot get here: `GatewayExtension` refuses the six by name.
  const components = { ...defaults, ...extension };

  // And the cycle closed, into the map the worker has been holding since it was built.
  Object.assign(handlers, options.handlers(components));

  return createGateway(components);
}
