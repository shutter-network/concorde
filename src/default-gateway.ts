/**
 * The default assembly: one call that builds the eight Components a deployment using our
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
 * start:  db -> agentServer -> publicServer -> users -> signatures -> decisions
 *            -> messenger -> worker -> extend
 * stop:   extend -> worker(drain) -> messenger -> decisions -> signatures -> users
 *            -> publicServer -> agentServer -> db
 * ```
 *
 * **The Signal Worker's `stop` is the only stop that does work.** Every other one releases
 * something. The worker's waits for the Run in flight and never cancels it
 * ([ADR-0017](../docs/adr/0017-failed-runs-are-not-retried.md)), and that Run reads the Db,
 * calls the Agent server the Operator's own `AGENTS.md` gave it the URLs for, and reaches
 * the Messenger, Signatures and Decisions through a Signal Handler's post phase. So the
 * drain goes **first**, while every server is still listening, those three are still live
 * and the pool is still open.
 *
 * Signatures and Decisions were inserted into that order rather than appended, and the two
 * constraints they had to satisfy are worth naming because neither is visible from the
 * record: **no existing pair moved relative position**, so nothing about the six above them
 * changed, and both sit **ahead of the Signal Worker**, which is the Messenger's
 * anticipatory position taken for the same reason — a post phase that publishes a Decision
 * on the way out runs inside the drain (ADR-0043).
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
 * ## The third reason the order is load-bearing
 *
 * Both servers describe themselves, in OpenAPI at `/openapi.json` and as a browsable page
 * at `/docs`, and **this constructor is the only party that can arrange it**
 * ([ADR-0040](../docs/adr/0040-the-gateway-describes-its-own-http-api.md)).
 * `@fastify/swagger` discovers routes through an `onRoute` hook, so a route registered
 * before it is invisible to it, and every part registers its routes inside its own
 * constructor. By the time an Operator holds `gateway.components.agentServer.fastify` the
 * three route plugins are already queued, and there is no window in which registering the
 * description themselves would work.
 *
 * So it goes at the top of the function, ahead of the first part, and construction order
 * here is now load-bearing for a **third** reason alongside the migration registration
 * order ([ADR-0036](../docs/adr/0036-the-http-messengers-user-id-is-a-foreign-key.md)) and
 * the worker-before-Messenger cycle above. This one fails the most quietly of the three:
 * get it wrong and both documents are empty, with no error anywhere.
 *
 * ## What it declines to construct
 *
 * **The Runtime**, which is an option, so nothing here imports `./pi/` and the package root
 * stays agnostic about the Agent Implementation
 * ([ADR-0033](../docs/adr/0033-an-agent-is-a-container-and-one-function.md)). **Fastify's
 * constructor options**, so there is no bring-your-own-instance escape and the only thing
 * stated is where each server listens. **Either bind address**, which is the one pair of
 * values where a wrong default is worse than no default: a Public server on loopback
 * serves nobody, and an Agent server anywhere else is an unauthenticated API on a
 * reachable port. And **migrations**: `start` does not apply them, and the Operator calls
 * `gateway.components.db.migrate()` between construction and `start`
 * ([ADR-0032](../docs/adr/0032-components-wire-themselves-at-construction.md)).
 *
 * ## What it defaults, and why here rather than in the part
 *
 * **`tokenTtl`**, to thirty days, and **`databaseUrl`**, to `DATABASE_URL` in the
 * environment. Neither reverses the refusal underneath it: `createUsers` still requires a
 * Token lifetime and `openDb` still takes a URL and reads no environment, because a part
 * is constructed by a caller who has already decided and has no business deciding for
 * them. This constructor is the other thing. ADR-0038 says it exists to answer the
 * questions whose answer is identical in every deployment that uses these parts, and
 * "somewhere around a month" and "the variable every platform already sets" are two of
 * them. A deployment for which either is load-bearing states it and gets what it asked
 * for.
 *
 * The cost is one sentence long and worth writing down: this is the **only shipped module
 * that reads `process.env`**, and a library reaching into the environment has an input its
 * caller cannot see in the call. It is confined to this constructor and to one variable,
 * and `createGateway` reaches nothing.
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

import type { KeyObject } from "node:crypto";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifyListenOptions } from "fastify";
import Fastify from "fastify";
import { type Component, createGateway, type Gateway, serverComponent } from "./components.ts";
import { type Db, openDb } from "./db/index.ts";
import { createDecisions, type Decisions } from "./decisions/index.ts";
import { createHttpMessenger, type HttpMessenger } from "./http-messenger/index.ts";
import type { Logger } from "./logging.ts";
import type { Runtime, SignalHandler, SignalHandlers, SignalWorker } from "./signals/index.ts";
import { createSignalWorker } from "./signals/index.ts";
import { createSignatures, type Signatures } from "./signatures/index.ts";
import { createUsers, type Users } from "./users/index.ts";

/**
 * The eight this constructor builds, under the keys it files them under — **and that is the
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
  signatures: Signatures;
  decisions: Decisions;
  messenger: HttpMessenger;
  worker: SignalWorker;
};

/**
 * What `extend` may return: Components under keys of the Operator's own, and **none of the
 * eight above**.
 *
 * The refusal is the point. A JavaScript spread overwrites the value and keeps the original
 * key's position, so replacing a default in place would otherwise be silent — a substituted
 * Messenger would start where the framework's would have and nothing anywhere would say so
 * (ADR-0037). `?: never` is what makes it a compile error, and under
 * `exactOptionalPropertyTypes` it means the key may be absent and nothing else.
 *
 * An Operator who really wants to substitute one is writing `createGateway` by hand, which
 * is the honest way to say it.
 *
 * It is written over `keyof DefaultComponents` rather than as a list, so a key added to the
 * record above is forbidden here by the same edit that added it — which is what kept
 * `signatures` and `decisions` from being two names somebody could quietly take over.
 */
export type GatewayExtension = Record<string, Component> & {
  [K in keyof DefaultComponents]?: never;
};

export type DefaultGatewayOptions<E extends GatewayExtension> = {
  /**
   * Where the Db connects. The pool opens at `start`, not here.
   *
   * Defaults to `DATABASE_URL` in the environment, and construction throws naming both
   * when there is neither. `pg`'s own fallbacks are deliberately not the default: with no
   * connection string it reads `PGHOST` and friends and lands on `localhost:5432` with
   * this process's login name as the user and the database, which is a confident answer
   * to a question nobody asked.
   */
  readonly databaseUrl?: string;
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
   * The Shared Agent's private key, as a `crypto.KeyObject`, and the whole of its identity
   * ([ADR-0041](../docs/adr/0041-the-shared-agent-has-a-signing-identity.md)).
   *
   * **Required of every deployment, including one that never publishes a Decision**, and
   * that is the price of this assembly being one fixed shape: nothing here branches on
   * whether a key was passed, so there is no arrangement in which two of the eight are
   * absent and the record has a different set of keys in it.
   *
   * The framework parses nothing and generates nothing. An Operator writes
   * `createPrivateKey(readFileSync(path))` and decides for themselves whether that path came
   * from a file, an environment variable or a secrets manager — the same division as
   * `HOST_DIR` in the reference deployment (ADR-0016). Nothing defaults it either, unlike
   * the two options below, because a generated key would be the one default that fails
   * quietly in the worst way: a fresh one per restart leaves every prior artifact
   * unverifiable with nothing anywhere saying so.
   */
  readonly signingKey: KeyObject;
  /**
   * The JOSE algorithm to sign under, when the key does not settle it by itself.
   *
   * Forwarded to Signatures untouched, and derived from the key's JWK export when it is left
   * out: `EdDSA` for an Ed25519 key, and `ES256`, `ES384` or `ES512` for an EC key on P-256,
   * P-384 or P-521. Every other key is **refused as this constructor runs**, in a sentence
   * naming what to pass. An RSA key is the one an Operator is most likely to be holding: six
   * algorithms are valid for it and nothing in the key says which was meant
   * ([ADR-0042](../docs/adr/0042-a-signature-is-a-compact-jws.md)).
   *
   * Here rather than only on `createSignatures` because otherwise an RSA key would be a key
   * this assembly cannot be given at all, and the assembly is how nearly every deployment
   * builds a Gateway. It defaults to nothing for the reason `signingKey` does: what the
   * right answer is depends on a key this framework has never seen.
   */
  readonly signingAlg?: string;
  /**
   * How long an issued Token lives, in milliseconds. Defaults to thirty days.
   *
   * `createUsers` requires this and says why: a long lifetime is fewer
   * re-authentications and a longer window for a stolen Token, and the framework cannot
   * tell which side of that a deployment is on. That is still true, and the default is
   * not a claim to have resolved it. It is a claim that a deployment which has not
   * thought about it is better served by a month than by a constructor it cannot call.
   */
  readonly tokenTtl?: number;
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
   * Components of the Operator's own, built from the eight this call constructed.
   *
   * A callback because it needs objects constructed in this function's body. What it
   * returns is **appended**, so those Components start last and therefore stop *first* —
   * right for a Producer, which should stop producing before the worker drains, and wrong
   * for a resource the drain uses, such as an outbound client the Handlers call. The second
   * case is the one `extend` cannot express, and the answer is `createGateway`.
   */
  readonly extend?: (components: DefaultComponents) => E;
  /**
   * The `kind`-to-Handler map, built from the eight defaults **and** whatever `extend`
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

/** Thirty days, in milliseconds: the `tokenTtl` a deployment that says nothing gets. */
const defaultTokenTtl = 30 * 24 * 60 * 60 * 1000;

/**
 * The `version` both documents declare, and a constant in source rather than a read of
 * the package manifest.
 *
 * OpenAPI requires the field and it **describes the wrong thing** however it is obtained:
 * the document covers a *deployment's* API, including whatever routes the Operator
 * registered themselves, so the framework's own version is a category error. Reading
 * `package.json` at runtime was rejected for buying a more precisely wrong answer at the
 * price of a file read inside a constructor documented as doing no I/O, and a second reach
 * outside the call in the one module that already confesses one for `DATABASE_URL`
 * ([ADR-0040](../docs/adr/0040-the-gateway-describes-its-own-http-api.md)).
 *
 * A hand-maintained value with no reader is exactly the thing that drifts, so
 * `default-gateway.test.ts` asserts this against the manifest.
 */
export const describedVersion = "0.0.0";

/**
 * Registers one server's description: the OpenAPI document, the browsable page, and the
 * conventional path the document answers on.
 *
 * Called **before the first part is constructed**, for the reason this file's header
 * gives. Neither route is configurable and neither can be switched off. An Operator who
 * objects to a public `/docs` leaves this constructor; an Operator who already owns either
 * path collides at `ready()`, which is loud (ADR-0040).
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
 * points at. `default-gateway.test.ts` pins both spellings, because the difference between
 * them is a Fastify fact rather than a choice of ours and the failure it produces is
 * silent.
 */
function describeSurface(fastify: FastifyInstance, title: string, description: string): void {
  fastify.register(fastifySwagger, {
    openapi: { openapi: "3.0.3", info: { title, description, version: describedVersion } },
  });
  fastify.register(fastifySwaggerUi, { routePrefix: "/docs" });
  // `fastify.swagger` is decorated on by the plugin above at boot, so this reads it per
  // request rather than closing over it: at the moment this route is declared there is no
  // such method, and the constructor is synchronous by design (ADR-0038).
  fastify.get("/openapi.json", async () => fastify.swagger());
}

/**
 * Builds the eight, wires them, orders them, and answers with a Gateway.
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
  // The one environment read in the package, and it throws rather than falling through to
  // `pg`'s defaults, which would open a pool against `localhost:5432` as this process's
  // login name and fail somewhere later with a message about a database nobody named.
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error(
      "there is no database to open: pass databaseUrl, or set DATABASE_URL in the environment",
    );
  }
  const db = openDb(databaseUrl);

  // Two bare instances, and the only thing stated about either is where it listens. There
  // is no bring-your-own-instance escape and that is a real limit rather than an oversight:
  // a Public server behind a reverse proxy wants `trustProxy`, which is not exotic, and
  // getting it means leaving this constructor entirely (ADR-0038). What is *not* out of
  // reach is anything after construction — the instances are on `.fastify`, so routes,
  // plugins and hooks are unaffected.
  const agentServer = serverComponent(Fastify(), options.agentListen);
  const publicServer = serverComponent(Fastify(), options.publicListen);

  // **Before the first part**, and that is the whole of why these two calls are here
  // rather than anywhere an Operator could put them: route discovery is an `onRoute` hook,
  // every part registers its routes inside its own constructor, and a route queued before
  // the hook is invisible to it. Both documents would be empty, with no error anywhere
  // (ADR-0040).
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

  // Construction order from here on is load-bearing four times over, and none of the
  // reasons is visible in the record below. The first is above: the description goes ahead
  // of every part, or it describes nothing.
  //
  // The User Manager is first of the parts because registering a migration descriptor is
  // what a constructor does and `db.migrate()` applies them in registration order:
  // `messages.user_id` is a foreign key onto `saf_users.users.id`, so a Messenger
  // constructed before this fails the first migration of every new deployment with
  // PostgreSQL's `schema "saf_users" does not exist` (ADR-0036). On this path that order is
  // not expressible wrongly, which is most of what the path is for. Decisions imposes no
  // such order of its own: it has no foreign key and references no User, so its folder
  // applies wherever it lands (ADR-0043).
  const users = createUsers({
    db,
    tokenTtl: options.tokenTtl ?? defaultTokenTtl,
    agentServer,
    publicServer,
  });

  // And the fourth reason, which is two ordinary construction dependencies rather than a
  // migration one: Signatures takes the Manager's `requireUser` for its Public check, and
  // Decisions holds Signatures and signs through it in process. So the three go in this order
  // and no other. There is no key here beyond the one the Operator passed — this constructor
  // derives nothing, defaults nothing and generates nothing (ADR-0041).
  const signatures = createSignatures({
    signingKey: options.signingKey,
    ...(options.signingAlg === undefined ? {} : { signingAlg: options.signingAlg }),
    agentServer,
    publicServer,
    users,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const decisions = createDecisions({ db, signatures, users, agentServer, publicServer });

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
  // drain, which is when a Signal Handler's post phase reaches it — and Signatures and
  // Decisions are keyed ahead of it for the same reason, a post phase that publishes a
  // Decision on the way out being the case ADR-0043 names.
  const defaults: DefaultComponents = {
    db,
    agentServer,
    publicServer,
    users,
    signatures,
    decisions,
    messenger,
    worker,
  };

  // `{} as E` because there is no value this function can construct that TypeScript will
  // accept as an arbitrary `E`. It is the empty extension, and it is only ever reached when
  // the caller supplied no `extend` — in which case `E` is the parameter's default,
  // `Record<string, never>`, and the empty object is precisely one of those.
  const extension: E = options.extend === undefined ? ({} as E) : options.extend(defaults);

  // Appended, so an Operator's own Components start last and stop first (ADR-0038). A key
  // collision cannot get here: `GatewayExtension` refuses all eight by name.
  const components = { ...defaults, ...extension };

  // And the cycle closed, into the map the worker has been holding since it was built.
  Object.assign(handlers, options.handlers(components));

  return createGateway(components);
}
