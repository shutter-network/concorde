/**
 * The HTTP Messenger: the component of a Gateway that owns Messages.
 *
 * One call builds it, and it registers its two route groups at `/messages` on both servers. Its
 * `start` and `stop` do nothing. Delivery is polling, so `?after=<seq>` is the whole of the resume
 * mechanism.
 *
 * It is the HTTP Messenger rather than the Messenger because it declines four freedoms. Both
 * servers are required. No route plugin is exported and no prefix is configurable. A Message is a
 * `text` string. The Signal `kind` is the constant `messageReceivedKind` below.
 *
 * A submitted Message and its Signal are one transaction, so a Message that was stored always has
 * its Signal. Writes take the caller's transaction and reads do not. A `kind` with no Handler
 * registered is a 201 followed by a permanently failed Signal.
 */

import type { FastifyInstance } from "fastify";
import type { Component } from "../components.ts";
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
import { agentMessageRoutes, publicMessageRoutes } from "./routes.ts";
import { httpMessagesTables } from "./schema.ts";

/**
 * Where both route groups land, on their respective servers.
 *
 * A constant and not an option. There is no prefix to configure and no plugin to register
 * elsewhere. So a client written for one deployment's HTTP Messenger works against every other's.
 */
const messagesPrefix = "/messages";

/**
 * The `kind` of the Signal a submitted Message emits.
 *
 * Half of this component's Signal contract. The other half is that the payload is the
 * `MessageRecord`, flat. So a Handler is written `SignalHandler<MessageRecord>`, or
 * `templateHandler<MessageRecord>`, and its data function type-checks against that record.
 *
 * A `kind` with no Handler registered fails the Signal permanently and stores the Message anyway.
 */
export const messageReceivedKind = "message.received";

/** Everything `createHttpMessenger` needs: the Db, two Components, and both servers. */
export type HttpMessengerOptions = {
  /** The Db this component queries through. It takes a handle to its own one table. */
  readonly db: Db;
  /**
   * The User Manager whose Users these Messages belong to. Build it before this.
   *
   * Named nominally, and required, because `messages.user_id` is a foreign key onto
   * `saf_users.users.id`. This component needs our Manager at the schema level.
   *
   * It is also where the Public routes' authentication comes from. `requireUser` is taken off this
   * object and put on the route as one option. Every refusal is therefore the Manager's single 401.
   */
  readonly users: Users;
  /**
   * The Signal Worker a submitted Message wakes.
   *
   * Named nominally for the reason `users` is. Required, because a Message that woke nobody would
   * be a Producer that produces nothing.
   */
  readonly worker: SignalWorker;
  /**
   * The Public server, where Users reach their own Messages, at `/messages`.
   *
   * Required, unlike the User Manager's servers. A Messenger nobody can reach is broken rather
   * than smaller. Structural, so what `serverComponent` returns satisfies it.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
  };
  /**
   * The Agent server, where the agent sends a Message and reads a User's log, at `/messages`.
   *
   * Required for the reason the Public server is. An HTTP Messenger the agent cannot answer
   * through is broken rather than smaller.
   */
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
};

/**
 * The HTTP Messenger as a Component: the two things trusted code needs and no request can express.
 *
 * A send that joins a transaction of the caller's own, and a read of any User's whole log. Every
 * other capability is a route this component registered itself, and no route plugin is exported.
 *
 * The two together are what make the post phase useful for messaging. A Handler told that a Run
 * failed can tell the person who asked. There is no method that writes an inbound Message, because
 * `direction` is decided by the server a request arrived on.
 */
export type HttpMessenger = Component & {
  /**
   * Sends a Message to one User from inside the caller's transaction, and answers with the record.
   *
   * Takes the caller's transaction, so answering somebody and recording why in the Operator's own
   * tables cannot come apart. A rollback loses both. The caller cannot read this write back
   * through `history`, which is why the record comes back here.
   *
   * Always outbound, and there is no parameter for the direction. An unknown User is a thrown
   * `UnknownUserError` rather than a 404, because there is no reply to write one into. The insert
   * runs in a savepoint, so that refusal does not abort the caller's transaction.
   */
  send<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    text: string,
  ): Promise<MessageRecord>;

  /**
   * One User's Messages, both directions, ascending by `seq`.
   *
   * So a Handler can build a Prompt from more than the one Message that woke it. Any User's log is
   * readable here, and not only the log a Run is serving. A read, so it takes no transaction and
   * cannot see the caller's own uncommitted write.
   *
   * The same query both routes answer from, with the same cursor options. No cursor is the newest
   * `limit`, `before` the newest `limit` below it, and `after` everything above it. Both cursors
   * together answer the stretch between them here, where a route refuses them. `limit` defaults to
   * the routes' default and is not capped.
   */
  history(userId: string, options?: Partial<MessageWindow>): Promise<MessageRecord[]>;

  /**
   * Does nothing. There is nothing here to start.
   *
   * Delivery is polling, so there is no connection to open and no ticker to set going. A client
   * resumes with `?after=<seq>`, and this component holds nothing between requests.
   */
  start(): Promise<void>;

  /**
   * Does nothing, and is the first of the two that will stop being a no-op.
   *
   * Push delivery is what would give it open responses to close. A Message submitted during a
   * shutdown is stored, and its Signal commits with it and stays `pending`.
   */
  stop(): Promise<void>;
};

/**
 * Builds the HTTP Messenger and registers its routes at `/messages` on both servers.
 *
 * Nothing here connects, listens or applies DDL. Key the result before the Signal Worker, so that
 * it stops after the drain. That is when a Signal Handler's post phase reaches it.
 *
 * @example
 * Built in `extend`, and then used from the Operator's own trusted code.
 * ```ts
 * import { createGateway } from "shared-agent-framework";
 * import { createHttpMessenger } from "shared-agent-framework/http-messenger";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   agentListen: { host: "127.0.0.1", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, agentServer, publicServer, worker }) => {
 *     const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
 *     return {
 *       users,
 *       messages: createHttpMessenger({ db, users, worker, agentServer, publicServer }),
 *     };
 *   },
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // A send that commits with whatever else the Operator's transaction writes.
 * const { db, messages } = gateway.components;
 * async function tell(userId: string, text: string): Promise<void> {
 *   await db.tx((tx) => messages.send(tx, userId, text));
 * }
 * ```
 */
export function createHttpMessenger(options: HttpMessengerOptions): HttpMessenger {
  // The component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(httpMessagesTables);

  // One read, named once and given to both plugins and to the method below. A User's own read, the
  // agent's and a Handler's are one query. The User is named by a Token, a query parameter or an
  // argument. Sharing one function is what keeps them from disagreeing about `before`.
  const readHistory = (userId: string, window: MessageWindow) =>
    selectMessages(handle, userId, window);

  // And one outbound write, likewise named once. Widened over the handle it is given. The agent's
  // route reaches it with the component's own handle, and a Handler with a transaction of its own.
  // The savepoint inside the insert makes both of them safe.
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
      // One transaction with two statements in it: the Message, then the Signal that wakes the
      // worker for it. The wakeup is a `NOTIFY` inside this transaction, so it and the row commit
      // together or neither happens. Inbound, because this is the Public server.
      submit: (userId, text) =>
        options.db.tx(async (tx) => {
          const message = await insertMessage(tx, { userId, direction: "inbound", text });
          await options.worker.emit(tx, { kind: messageReceivedKind, payload: message });
          return message;
        }),
    },
    // The Manager's own hook, passed through and not wrapped. This component authenticates nobody.
    options.users.requireUser,
  );

  // The two acts of wiring, both of them here so that an Operator's entry point does neither.
  // Not awaited: Fastify defers a plugin until the server is ready. So this registration is made
  // at construction and loaded at `listen`. A server already listening refuses one.
  options.agentServer.fastify.register(agentRoutes, { prefix: messagesPrefix });
  options.publicServer.fastify.register(publicRoutes, { prefix: messagesPrefix });

  return {
    // The one outbound write above, on the caller's handle rather than the component's own. That
    // is the whole of what taking the transaction first means.
    send: sendOutbound,
    // The one read above, reached with arguments instead of a query string. The routes' own
    // default `limit`, and none of their cap. A cap bounds a response body, and there is none here.
    history: (userId, asked) =>
      readHistory(userId, { ...asked, limit: asked?.limit ?? limitSchema.default }),

    // The two no-ops, whose reason is on the type above. This component is in the record for its
    // membership and its position.
    start: async () => {},
    stop: async () => {},
  };
}
