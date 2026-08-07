/**
 * The Messenger: the component of a Gateway that owns the Message log.
 *
 * One call builds it, and it registers one route group at `/messages` on the Agent server. Its
 * `start` and `stop` do nothing. **It reaches nobody**: getting a Message to a person is a
 * Channel's job, and this component knows only the one registered with it (ADR-0048).
 *
 * It is opinionated rather than generic in three ways, all of them inherited from the HTTP
 * Messenger this was extracted from (ADR-0034). A Message is a `text` string. The Signal `kind` is the constant `messageReceivedKind` below. A User's log
 * is one numbered sequence across both directions. What it no longer decides is how a person is
 * reached, which is the freedom the Channel below is.
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
import { agentMessageRoutes } from "./routes.ts";
import { messengerTables } from "./schema.ts";

/**
 * Where the agent's route group lands, on the Agent server.
 *
 * A constant and not an option. There is no prefix to configure and no plugin to register
 * elsewhere. So an Agent Implementation written for one deployment works against every other's.
 */
const messagesPrefix = "/messages";

/**
 * The `kind` of the Signal an inbound Message emits.
 *
 * Half of this component's Signal contract. The other half is that the payload is the
 * `MessageRecord`, flat. So a Handler is written `SignalHandler<MessageRecord>`, or
 * `templateHandler<MessageRecord>`, and its data function type-checks against that record.
 *
 * **Unchanged by the split**, and unchanged by which Channel a Message arrived over: the payload
 * names no Channel, because one Channel per Messenger makes that field constant in every Signal.
 * A Handler written against the HTTP Messenger needs no edit.
 *
 * A `kind` with no Handler registered fails the Signal permanently and stores the Message anyway.
 */
export const messageReceivedKind = "message.received";

/**
 * What reaches one person over one medium: a name, a send, and a lifecycle.
 *
 * Two members over a `Component`, which is the same order of narrowness as `Component` itself
 * rather than the plugin contract ADR-0021 rejected. A Channel is an ordinary Component an
 * Operator constructs and keys, and it is switched off by not constructing it.
 *
 * A Channel registers **itself**, at the end of its own constructor, which is ADR-0032 verbatim:
 * the same act as a component registering its routes on the servers it was handed. It has to be
 * that way round, because a Channel is constructed with the Messenger and the reference cannot run
 * both ways at construction time.
 */
export type Channel = Component & {
  /**
   * Which Channel this is, as a constant of its type rather than a construction option.
   *
   * `"http"` for the HTTP Channel. It is not an identifier anything looks up: nothing routes on
   * it, because there is one Channel, and nothing stores it, because a column constant in every
   * row answers no question. It is what a log line and a refusal name.
   */
  readonly name: string;

  /**
   * Takes an outbound Message, inside the transaction that is writing it.
   *
   * The promise is only "this Message is yours now", which is why the member is not called
   * `deliver`: arrival is not something every medium can promise. It is not called `enqueue`
   * either, because the HTTP Channel has no queue — HTTP delivery is the User asking — and a
   * member named for one would be false for it.
   *
   * **It must not perform the network act.** A publish cannot be rolled back and a transaction
   * can. So an implementation does everything knowable synchronously and throws for anything
   * wrong, which rolls the caller's transaction back and leaves nothing half-done, and whatever
   * has to travel travels after the commit.
   */
  send<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    message: MessageRecord,
  ): Promise<void>;
};

/**
 * What a Channel gets back from `register`, and the only way an inbound Message can be written.
 *
 * There is no public `receive` on the Messenger. A Channel keeps this handle and writes through
 * it, so **only a registered Channel can write an inbound Message**, and a Channel cannot claim
 * to be a different one because it never names itself in the call. The alternative,
 * `messenger.receive(tx, userId, channelName, text)`, is one more argument and one more thing to
 * lie about (ADR-0048).
 */
export type MessengerHandle = {
  /**
   * Records one inbound Message and the Signal that wakes the agent for it, in one transaction.
   *
   * The caller's transaction, so a Channel's own bookkeeping — a processed-event row, a queue row
   * — commits with the Message or not at all. A Message that was stored always has its Signal.
   *
   * Answers with the record as it was stored, `seq` and all. That is what the HTTP Channel's 201
   * carries, and it is why this returns the record where ADR-0048's sketch returned nothing: the
   * caller cannot read its own uncommitted write back through `history`.
   *
   * @throws `UnknownUserError` if no User has that id. The insert runs in a savepoint, so the
   *   refusal does not abort the caller's transaction.
   */
  receive<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    text: string,
  ): Promise<MessageRecord>;
};

/**
 * A second Channel was registered with one Messenger.
 *
 * One Channel per Messenger is refused rather than documented, which is ADR-0034's own instinct
 * that "making them unconstructable is cheaper than documenting them". A Messenger with two
 * Channels would need a `channel` argument on `send`, a `channel` column on the log and the name
 * in the Signal payload, and none of the three exists.
 */
export class ChannelAlreadyRegisteredError extends Error {
  constructor(registered: string, offered: string) {
    super(
      `the ${registered} Channel is already registered with this Messenger, and ${offered} cannot join it: one Channel per Messenger, so build a second Messenger or run one medium`,
    );
    this.name = "ChannelAlreadyRegisteredError";
  }
}

/**
 * A Message was sent through a Messenger no Channel had registered with.
 *
 * Thrown before the row is written, so the Message is not recorded. Recording one nothing will
 * deliver would be a durable claim that somebody was told something.
 */
export class NoChannelError extends Error {
  constructor(userId: string) {
    super(
      `no Channel is registered with this Messenger, so there is no way to reach User ${userId}; nothing was recorded`,
    );
    this.name = "NoChannelError";
  }
}

/** Everything `createMessenger` needs: the Db, two Components, and the Agent server. */
export type MessengerOptions = {
  /** The Db this component queries through. It takes a handle to its own one table. */
  readonly db: Db;
  /**
   * The User Manager whose Users these Messages belong to. Build it before this.
   *
   * Named nominally, and required, because `messages.user_id` is a foreign key onto
   * `saf_users.users.id`. This component needs our Manager at the schema level, and nothing is
   * called on it: authentication belongs to the Channels, which serve the routes a User reaches.
   */
  readonly users: Users;
  /**
   * The Signal Worker an inbound Message wakes.
   *
   * Named nominally for the reason `users` is. Required, because a Message that woke nobody would
   * be a Producer that produces nothing.
   */
  readonly worker: SignalWorker;
  /**
   * The Agent server, where the agent sends a Message and reads a User's log, at `/messages`.
   *
   * Required. A Messenger the agent cannot answer through is broken rather than smaller.
   * Structural, so what `serverComponent` returns satisfies it.
   *
   * There is no Public server option here. What a User reaches is a Channel's, and a Channel that
   * is not HTTP has no route on it at all.
   */
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
};

/**
 * The Messenger as a Component: the three things trusted code needs and no request can express.
 *
 * A registration that hands a Channel the only way to write an inbound Message, a send that joins
 * a transaction of the caller's own, and a read of any User's whole log. Every other capability
 * is a route this component registered itself, and no route plugin is exported.
 *
 * `send` and `history` together are what make the post phase useful for messaging. A Handler told
 * that a Run failed can tell the person who asked, whichever medium reaches them.
 */
export type Messenger = Component & {
  /**
   * Takes the Channel that will reach people, and answers with the handle it writes inbound
   * Messages through.
   *
   * Called by the Channel's own constructor and by nothing else. An Operator's entry point
   * performs no wiring here: constructing a Channel with this Messenger is the whole act.
   *
   * @throws `ChannelAlreadyRegisteredError` on a second Channel. One per Messenger.
   */
  register(channel: Channel): MessengerHandle;

  /**
   * Sends a Message to one User from inside the caller's transaction, and answers with the record.
   *
   * Takes the caller's transaction, so answering somebody and recording why in the Operator's own
   * tables cannot come apart. A rollback loses both, and loses whatever the Channel wrote in the
   * same transaction to get the Message out. The caller cannot read this write back through
   * `history`, which is why the record comes back here.
   *
   * Always outbound, and there is no parameter for the direction and none for the Channel. An
   * unknown User is a thrown `UnknownUserError` rather than a 404, because there is no reply to
   * write one into. The insert runs in a savepoint, so that refusal does not abort the caller's
   * transaction.
   *
   * @throws `NoChannelError` if no Channel has registered, before anything is written.
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
   * The same query both surfaces answer from, with the same cursor options. No cursor is the
   * newest `limit`, `before` the newest `limit` below it, and `after` everything above it. Both
   * cursors together answer the stretch between them here, where a route refuses them. `limit`
   * defaults to the routes' default and is not capped.
   */
  history(userId: string, options?: Partial<MessageWindow>): Promise<MessageRecord[]>;

  /**
   * Does nothing. There is nothing here to start.
   *
   * The Messenger holds no connection and runs no loop. A Channel that needs one opens it in its
   * own `start`, and this component does not know that one exists.
   */
  start(): Promise<void>;

  /**
   * Does nothing.
   *
   * A Message submitted during a shutdown is stored, and its Signal commits with it and stays
   * `pending`.
   */
  stop(): Promise<void>;
};

/**
 * Builds the Messenger and registers the agent's routes at `/messages` on the Agent server.
 *
 * Nothing here connects, listens or applies DDL. Key the result before the Signal Worker, so that
 * it stops after the drain. That is when a Signal Handler's post phase reaches it. Key every
 * Channel there too, for the same reason: that post phase runs `send` into `channel.send`.
 *
 * @example
 * Built in `extend` with the one Channel that reaches people, and then used from the Operator's
 * own trusted code.
 * ```ts
 * import { createGateway } from "shared-agent-framework";
 * import { createHttpChannel } from "shared-agent-framework/http-channel";
 * import { createMessenger } from "shared-agent-framework/messenger";
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
 *     const messenger = createMessenger({ db, users, worker, agentServer });
 *     return {
 *       users,
 *       messenger,
 *       http: createHttpChannel({ db, messenger, users, publicServer }),
 *     };
 *   },
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // A send that commits with whatever else the Operator's transaction writes.
 * const { db, messenger } = gateway.components;
 * async function tell(userId: string, text: string): Promise<void> {
 *   await db.tx((tx) => messenger.send(tx, userId, text));
 * }
 * ```
 */
export function createMessenger(options: MessengerOptions): Messenger {
  // The component's own handle, typed to its own tables. `pg` never leaves the Db.
  const handle = options.db.handle(messengerTables);

  // The one Channel, held from its own constructor's call to `register` below. `undefined` until
  // then, and a `send` that arrives first is refused rather than recorded.
  let channel: Channel | undefined;

  // One read, named once and given to the plugin, to the method below and to whatever Channel
  // registers. The agent's read, a User's own read and a Handler's are one query. The User is
  // named by a Token, a query parameter or an argument. Sharing one function is what keeps them
  // from disagreeing about `before`.
  const readHistory = (userId: string, window: MessageWindow) =>
    selectMessages(handle, userId, window);

  // And one outbound write, likewise named once, widened over the handle it is given. It is the
  // whole of `send`: the row, and then the Channel's own synchronous work inside the same
  // transaction. A Channel that throws takes the row with it, which is what makes "a Message that
  // was recorded as sent was deliverable" true.
  const sendOutbound = async <TSchema extends Record<string, unknown>>(
    on: Handle<TSchema>,
    userId: string,
    text: string,
  ): Promise<MessageRecord> => {
    if (channel === undefined) throw new NoChannelError(userId);
    const message = await insertMessage(on, { userId, direction: "outbound", text });
    await channel.send(on, message);
    return message;
  };

  const agentRoutes = agentMessageRoutes({
    history: readHistory,
    // The route's own transaction, because the row and whatever the Channel writes beside it are
    // one act. A request that sends a Message has nothing else in it, so this is the narrowest
    // transaction there is.
    send: (userId, text) => options.db.tx((tx) => sendOutbound(tx, userId, text)),
  });

  // The one act of wiring, here so that an Operator's entry point does none. Not awaited: Fastify
  // defers a plugin until the server is ready. So this registration is made at construction and
  // loaded at `listen`. A server already listening refuses one.
  options.agentServer.fastify.register(agentRoutes, { prefix: messagesPrefix });

  return {
    register: (offered) => {
      if (channel !== undefined)
        throw new ChannelAlreadyRegisteredError(channel.name, offered.name);
      channel = offered;
      // The handle, built here and nowhere else, so that the inbound write exists only on the
      // object a registered Channel is holding. One transaction with two statements in it: the
      // Message, then the Signal that wakes the worker for it. The wakeup is a `NOTIFY` inside
      // the caller's transaction, so it and the row commit together or neither happens.
      return {
        receive: async (tx, userId, text) => {
          const message = await insertMessage(tx, { userId, direction: "inbound", text });
          await options.worker.emit(tx, { kind: messageReceivedKind, payload: message });
          return message;
        },
      };
    },

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
