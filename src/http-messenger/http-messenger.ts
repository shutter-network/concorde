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
 *    User Manager switches one off and leaves a coherent object that does less; a
 *    Messenger with no Public server cannot be reached by the people it exists for, and one
 *    with no Agent server cannot be answered by the agent. Each is not a smaller Messenger
 *    but a broken one, and making them unconstructable is cheaper than documenting them.
 *  - **No route plugin is exported and no prefix is configurable**, which is the departure
 *    from ADR-0032's door-out pattern. The User Manager's plugin is useful in isolation —
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
 * Five things about the surface are consequences worth meeting here:
 *
 *  - **Writes take the caller's transaction and reads do not** (ADR-0023), which is the split
 *    the User Manager established and this part follows: `send` is transactional on the
 *    caller's behalf, and `history` goes through the part's own handle. The consequence is
 *    worth stating where it will be met: a caller **cannot read its own uncommitted write**,
 *    so `send` returns the record and a read-back has no reason to exist.
 *  - **Construction order is load-bearing.** `db.migrate()` applies descriptors in
 *    registration order, which is construction order, and this part's first migration
 *    references `saf_users.users` — so the User Manager must be constructed **before**
 *    this. Nothing checks it; the failure is PostgreSQL's `schema "saf_users" does not
 *    exist`, or `relation "saf_users.users" does not exist` where the schema is there and
 *    the table is not (ADR-0036).
 *  - **`users` and `worker` are named nominally.** A structural type on `users` would
 *    advertise a substitutability the foreign key has made false: this part needs *our*
 *    User Manager at the schema level, and the constructor is where that should be
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
import type { Db, Handle } from "../db/index.ts";
import { limitSchema } from "../route-conventions.ts";
import type { SignalWorker } from "../signals/worker.ts";
import type { Users } from "../users/users.ts";
import {
  insertMessage,
  type MessageRecord,
  type MessageWindow,
  selectMessages,
} from "./messages.ts";
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
   * The User Manager whose Users these Messages belong to.
   *
   * Named nominally, and required, because `messages.user_id` is a **foreign key** onto
   * `saf_users.users.id` (ADR-0036): this part needs our Manager at the schema level
   * rather than the type level, and a structural type would advertise a substitutability
   * that has stopped being true. Construct it before this.
   *
   * It is also where the Public routes' authentication comes from: `requireUser` is taken
   * off this object and put on the route as one option, so this part holds no Token and no
   * header of its own and every refusal is the Manager's single 401 (ADR-0030).
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
   * Required, unlike the User Manager's: a Messenger nobody can reach is broken rather
   * than smaller. Structural, and asks for nothing but the Fastify instance, for the purely
   * technical reason the Manager's option is — `FastifyInstance` has five generic
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
 * What the constructor answers with: the two things trusted code needs and no request can
 * express.
 *
 * Every other capability this part has is a route it registered itself, and no route plugin
 * is exported (ADR-0034), so what is on this object is what a Signal Handler and an
 * Operator's entry point, both of them trusted code (ADR-0009, ADR-0020), cannot reach over
 * HTTP: a send that joins a transaction of their own, and a read of any User's whole log that
 * needs neither a Token nor a route.
 *
 * The two together are what make the **post phase** useful for messaging: a Handler told
 * that a Run failed can tell the person who asked (ADR-0017), which is otherwise something
 * nothing in the framework can do, since a failed Run emits nothing and the person is left
 * waiting.
 *
 * Neither has a route, and there is deliberately **no method that writes an inbound
 * Message**. `direction` is decided by which server a request arrived on, and trusted code
 * does not get a path that puts words in a User's mouth (ADR-0034). A Handler migrating a
 * history in, or a fixture that needs one, uses the Operator's own SQL.
 */
export type HttpMessenger = {
  /**
   * Sends a Message to one User from inside the caller's transaction, and answers with the
   * record.
   *
   * Takes the caller's transaction rather than finding one (ADR-0023), so that answering
   * somebody and recording in the Operator's own tables why cannot come apart: a rollback
   * loses both. Ambient enlistment is not available: a transaction started on one handle
   * takes its own connection from the pool, so a second handle's writes would survive its
   * rollback with nothing reported.
   *
   * The schema parameter is widened rather than named, because the transaction carries the
   * schema of the handle it was started on and that handle belongs to the caller.
   *
   * Always **outbound**, with no parameter for the direction, because there is no direction
   * to choose: this is the same insert the agent's own route reaches, and the inbound half of
   * this part has no method at all.
   *
   * Which is also where an unknown User comes from: the foreign key refusing (ADR-0036),
   * surfaced here as a **thrown** error rather than as the route's 404, since there is no
   * reply to write it into. A consequence of the savepoint that insert needs anyway: the
   * refusal does not abort the caller's transaction, so a caller that catches may carry on
   * and commit what else it was doing.
   */
  send<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    text: string,
  ): Promise<MessageRecord>;

  /**
   * One User's Messages, both directions, ascending by `seq`, so that a Handler can build a
   * Prompt from more than the one Message that woke it.
   *
   * Any User's, and not only the one a Run is serving: the whole log is readable from trusted
   * code for the reason the agent's own read is unscoped (ADR-0011).
   *
   * A read, so it takes no transaction and therefore **cannot see the caller's own
   * uncommitted write**. `send` returns the record for exactly that reason, the way `create`
   * does in the User Manager.
   *
   * It answers from the same query both reads answer from, with the same cursor options: no
   * cursor is the newest `limit`, `before` the newest `limit` strictly below it, `after`
   * everything above it, and every one of them ascending (ADR-0035). The routes refuse both
   * cursors at once as the client bug it is there, and nothing refuses it here: what comes
   * back is the stretch between them, newest end first if it does not fit. Recorded rather
   * than guarded, and not a spelling to reach for.
   *
   * `limit` defaults to the number the routes default to and is **not** capped here: the cap
   * on a route bounds a response body a stranger or the agent reads, which is not the case
   * trusted code asking for a thousand Messages is in.
   *
   * The options are the shared window with every field made optional, and not a shape of this
   * method's own: one list of cursor names in this part, not two that could drift.
   */
  history(userId: string, options?: Partial<MessageWindow>): Promise<MessageRecord[]>;
};

export function createHttpMessenger(options: HttpMessengerOptions): HttpMessenger {
  // The part's own handle, typed to its own tables. `pg` never leaves the Db (ADR-0022).
  const handle = options.db.handle(httpMessagesTables);

  // One read, named once and given to both plugins and to the method below. A User's own
  // read, the agent's and a Handler's are the same query asked about a User named by a Token,
  // a query parameter or an argument, and the three sharing this one function is what keeps
  // them from becoming a parallel set that can disagree about what `before` means (ADR-0035).
  const readHistory = (userId: string, window: MessageWindow) =>
    selectMessages(handle, userId, window);

  // And one outbound write, likewise named once: this part writes that direction here and
  // nowhere else. Widened over the handle it is given, so the agent's route reaches it with
  // the part's own, which is all a request needs (one insert is atomic by itself, and a
  // request that sends a Message has nothing else to keep it with), while a Handler reaches
  // the same statement with a transaction of its own (ADR-0023). The savepoint inside the
  // insert is what makes both of them safe.
  const sendOutbound = <TSchema extends Record<string, unknown>>(
    on: Handle<TSchema>,
    userId: string,
    text: string,
  ) => insertMessage(on, { userId, direction: "outbound", text });

  const agentRoutes = agentMessageRoutes({
    history: readHistory,
    send: (userId, text) => sendOutbound(handle, userId, text),
  });
  const publicRoutes = publicMessageRoutes(
    {
      history: readHistory,
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
    // The Manager's own hook, passed through and not wrapped: this part authenticates
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

  return {
    // The one outbound write above, on the **caller's** handle rather than the part's own,
    // which is the whole of what taking the transaction first means (ADR-0023).
    send: sendOutbound,
    // The one read above, reached with arguments instead of a query string: the routes' own
    // default `limit` and none of their cap, since a cap bounds a response body and there is
    // no response here.
    history: (userId, asked) =>
      readHistory(userId, { ...asked, limit: asked?.limit ?? limitSchema.default }),
  };
}
