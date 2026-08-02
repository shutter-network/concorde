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
 * the framework offers, and all four are visible right here (ADR-0034):
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
 *  - **The Signal `kind` is the constant `messageReceivedKind`**, below, and not a
 *    construction option. Two HTTP Messengers in one Gateway are unconstructable anyway —
 *    duplicate routes, one shared schema — so the only use for a configurable kind would be
 *    dodging a collision with the Operator's own Producer, and they are the party who can
 *    rename: their Handler map is a literal in their own entry point.
 *
 * Four things about the surface are consequences worth meeting here:
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
 *  - **A submitted Message and its Signal are one transaction**, and nothing else is in it.
 *    PostgreSQL's `NOTIFY` is transactional, so the row and the wakeup become visible
 *    together: a Signal from a transaction that rolled back wakes nobody, and a Message that
 *    committed always has its Signal. That is the shape `src/signals/worker.ts` documents
 *    `emit` as existing for (ADR-0023), and it is why the insert had to be savepoint-safe.
 *  - **A `kind` with no Handler registered is a 201 followed by a permanently failed
 *    Signal.** The Message is stored and readable, the agent never sees it, and the failure
 *    is visible only on the Signal row (ADR-0017). Not guarded: for the Messenger to check
 *    the Handler map it would have to reach into the Worker for something ADR-0024 removed,
 *    and a Message being durable regardless of what happens downstream is the property worth
 *    keeping.
 */

import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import type { SignalWorker } from "../signals/worker.ts";
import type { Users } from "../users/users.ts";
import { insertMessage, type MessageWindow, selectMessages } from "./messages.ts";
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

/**
 * The `kind` of the Signal a submitted Message emits, and half of this part's Signal
 * contract; the other half is that the payload **is** the `MessageRecord`, flat.
 *
 * Exported, so that a Handler map is not a string literal that can drift, and a constant
 * rather than a construction option for the reason in this file's header (ADR-0034). A
 * Handler is therefore written `SignalHandler<MessageRecord>` — or
 * `templateHandler<MessageRecord>` — and its template's data function type-checks against
 * the same record every other surface of this part answers with.
 *
 * A `kind` with no Handler registered fails the Signal permanently and stores the Message
 * anyway, which is the consequence this part's header states and its tests pin (ADR-0017).
 */
export const messageReceivedKind = "message.received";

export type HttpMessengerOptions = {
  readonly db: Db;
  /**
   * The User Directory whose Users these Messages belong to.
   *
   * Named nominally, and required, because `messages.user_id` is a **foreign key** onto
   * `saf_users.users.id` (ADR-0036): this part needs our Directory at the schema level
   * rather than the type level, and a structural type would advertise a substitutability
   * that has stopped being true. Construct it before this.
   *
   * It is also where the Public routes' authentication comes from: `requireUser` is taken
   * off this object and put on the route as one option, so this part holds no Token and no
   * header of its own and every refusal is the Directory's single 401 (ADR-0030).
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

  // One read, named once and given to both plugins. A User's own read and the agent's are
  // the same query asked about a User named by a Token or by a query parameter, and the two
  // surfaces sharing this one function is what keeps them from becoming a parallel pair that
  // can disagree about what `before` means (ADR-0035).
  const history = (userId: string, window: MessageWindow) => selectMessages(handle, userId, window);

  const agentRoutes = agentMessageRoutes({
    history,
    // Outbound, because this is the Agent server's plugin, and on the part's own handle:
    // one insert is atomic by itself and a request that sends a Message has nothing else
    // to keep it with. The savepoint inside is what makes the same insert safe for the
    // caller's transaction that the inbound path and a Handler will reach it through.
    send: (userId, text) => insertMessage(handle, { userId, direction: "outbound", text }),
  });
  const publicRoutes = publicMessageRoutes(
    {
      history,
      // One transaction with two statements in it and nothing else: the Message, then the
      // Signal that wakes the worker for it. The wakeup is `NOTIFY` inside this
      // transaction, so it and the row commit together or neither happens — a Producer
      // that nudged the worker after commit would have to remember to (ADR-0023). Inbound,
      // because this is the Public server, and by the User the Token named.
      submit: (userId, text) =>
        options.db.tx(async (tx) => {
          const message = await insertMessage(tx, { userId, direction: "inbound", text });
          await options.worker.emit(tx, { kind: messageReceivedKind, payload: message });
          return message;
        }),
    },
    // The Directory's own hook, passed through and not wrapped: this part authenticates
    // nobody, which is what `src/users/users.ts` promised it would do (ADR-0030).
    options.users.requireUser,
  );

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
