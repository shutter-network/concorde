/**
 * The HTTP Messenger: the part of the Gateway that owns Messages.
 *
 * Constructed like every other part — one call, an ordinary object back, and nothing to
 * register it with. It wires itself the way every part does, registering its own migration
 * descriptor with the Db and its two plugins on the two servers it is handed (ADR-0032).
 *
 * It is **not a Component**. No timers and no connection of its own, so there is nothing
 * for a `start` to begin or a `stop` to release, and it goes in no start order (ADR-0031).
 * The day push delivery arrives it becomes one, with a `LISTEN` registration and a `stop`
 * that closes open responses; until then `?after=<seq>` is the whole of the resume
 * mechanism and delivery is polling (ADR-0035).
 *
 * It is the *HTTP* Messenger rather than *the* Messenger because it declines four freedoms
 * the framework offers, and three of them are visible right here (ADR-0034):
 *
 *  - **Both servers are required.** Neither half is a capability. Omitting a server on the
 *    User Directory switches one off and leaves a coherent object that does less; a
 *    Messenger with no Public server cannot be reached by the people it exists for, and one
 *    with no Agent server cannot be answered by the agent. Each is not a smaller Messenger
 *    but a broken one, and making them unconstructable is cheaper than documenting them.
 *  - **No route plugin is exported and no prefix is configurable**, which is the departure
 *    from ADR-0032's door-out pattern. The User Directory's plugin is useful in isolation —
 *    routes over its own tables, working under any prefix. These routes are half of a
 *    contract whose other half is the Signal `kind`, the record shape and a client written
 *    against both, so an Operator who needs them elsewhere or behind a hook of their own
 *    wants a different messaging Producer, which ADR-0021 already says how to write.
 *  - **A Message is a `text` string**, with no `jsonb` and no payload convention.
 *
 * Two things about the surface are consequences worth meeting here:
 *
 *  - **Construction order is load-bearing.** `db.migrate()` applies descriptors in
 *    registration order, which is construction order, and this part's first migration
 *    references `saf_users.users` — so the User Directory must be constructed **before**
 *    this. Nothing checks it; the failure is PostgreSQL's `schema "saf_users" does not
 *    exist`, or `relation "saf_users.users" does not exist` where the schema is there and
 *    the table is not (ADR-0036).
 *  - **`users` and `worker` are named nominally.** A structural type on `users` would
 *    advertise a substitutability the foreign key has made false: this part needs *our*
 *    User Directory at the schema level, and the constructor is where that should be
 *    visible rather than at `migrate`.
 */

import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import type { SignalWorker } from "../signals/worker.ts";
import type { Users } from "../users/users.ts";
import { insertMessage, selectMessages } from "./messages.ts";
import { httpMessagesMigrations } from "./migrations.ts";
import { agentMessageRoutes, publicMessageRoutes } from "./routes.ts";
import { httpMessagesTables } from "./schema.ts";

/**
 * Where both route groups land, on their respective servers.
 *
 * A constant and not an option: there is no prefix to configure and no plugin to register
 * elsewhere, so a client written for one deployment's HTTP Messenger works against every
 * other deployment's (ADR-0034).
 */
const messagesPrefix = "/messages";

export type HttpMessengerOptions = {
  readonly db: Db;
  /**
   * The User Directory whose Users these Messages belong to.
   *
   * Named nominally, and required, because `messages.user_id` is a **foreign key** onto
   * `saf_users.users.id` (ADR-0036): this part needs our Directory at the schema level
   * rather than the type level, and a structural type would advertise a substitutability
   * that has stopped being true. Construct it before this.
   */
  readonly users: Users;
  /**
   * The Signal Worker a submitted Message wakes.
   *
   * Named nominally for the reason `users` is, and required because a Message that woke
   * nobody would be a Producer that produces nothing.
   */
  readonly worker: SignalWorker;
  /**
   * The Public server, where Users reach their own Messages, at **`/messages`**.
   *
   * Required, unlike the User Directory's: a Messenger nobody can reach is broken rather
   * than smaller. Structural, and asks for nothing but the Fastify instance, for the purely
   * technical reason the Directory's option is — `FastifyInstance` has five generic
   * parameters — so what satisfies it is what `serverComponent` returns.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
  };
  /**
   * The Agent server, where the agent sends a Message and reads a User's log, at
   * **`/messages`**. Required for the reason the Public server is: an HTTP Messenger the
   * agent cannot answer through is broken rather than smaller.
   */
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
};

/**
 * What the constructor answers with: **nothing yet**.
 *
 * Not an oversight and not a placeholder. Every capability this part has so far is a route,
 * and no route plugin is exported (ADR-0034), so there is nothing for an Operator to hold
 * — the object exists because the wiring has to happen somewhere and a constructor is
 * where every other part does it. The two trusted-code methods, `send` and `history`, are
 * what will make holding it worthwhile.
 */
export type HttpMessenger = Record<string, never>;

export function createHttpMessenger(options: HttpMessengerOptions): HttpMessenger {
  // The part's own handle, typed to its own tables. `pg` never leaves the Db (ADR-0022).
  const handle = options.db.handle(httpMessagesTables);

  const agentRoutes = agentMessageRoutes({
    // Outbound, because this is the Agent server's plugin, and on the part's own handle:
    // one insert is atomic by itself and a request that sends a Message has nothing else
    // to keep it with. The savepoint inside is what makes the same insert safe for the
    // caller's transaction that the inbound path and a Handler will reach it through.
    send: (userId, text) => insertMessage(handle, { userId, direction: "outbound", text }),
    history: (userId, window) => selectMessages(handle, userId, window),
  });
  const publicRoutes = publicMessageRoutes();

  // The three acts of wiring, all of them here so that an Operator's entry point does none
  // of them (ADR-0032). Registering the descriptor is bookkeeping the Db does nothing with
  // until `migrate` or `start` — and the order it lands in is this call's position in the
  // entry point, which the foreign key makes matter (ADR-0036).
  options.db.registerMigrations(httpMessagesMigrations);
  // Not awaited: Fastify defers a plugin until the server is ready, so this is a
  // registration made at construction and loaded at `listen` — which is also why a server
  // that is already listening refuses one.
  options.agentServer.fastify.register(agentRoutes, { prefix: messagesPrefix });
  options.publicServer.fastify.register(publicRoutes, { prefix: messagesPrefix });

  return {};
}
