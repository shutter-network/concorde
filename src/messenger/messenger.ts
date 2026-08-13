/**
 * The log lives here and the medium does not, which is the whole of ADR-0048. Three of the four
 * freedoms ADR-0034 declined moved up from the HTTP Messenger with the log: the `text` content, the
 * fixed Signal `kind`, and one numbered sequence per User across both directions. The fourth, how a
 * person is reached, is what the `Channel` below hands back. Do not add a `channel` argument
 * to `send`, a `channel` column, or a Channel name in the Signal payload while `register` refuses a
 * second Channel: the three arrive together or none of them does, and a column constant in every
 * row answers no question.
 *
 * `register` handing back a handle is what deletes a public `receive`. The alternative,
 * `messenger.receive(tx, userId, channelName, text)`, is one more argument and one more thing for a
 * Channel to lie about.
 *
 * The member on both sides is `send`, and both other names were rejected for lying. `deliver`
 * promises arrival, which Nostr cannot provide, and `enqueue` promises a queue, which the HTTP
 * Channel has none of.
 *
 * `sendOutbound` writes the row and then calls `channel.send` inside the same transaction, in that
 * order. A Channel that throws takes the row with it, which is what keeps "a Message recorded as
 * sent was deliverable" true. The Channel must not perform the network act there; that constraint
 * is stated where an implementor reads it, on the member itself.
 */

import type { FastifyInstance } from "fastify";
import type { Db, Handle } from "../db/index.ts";
import type { Component } from "../gateway/components.ts";
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
import { messengerTables } from "./schema/index.ts";

// A constant and not an option: no prefix to configure and no plugin to register elsewhere, so an
// Agent Implementation written for one deployment works against every other's.
const messagesPrefix = "/messages";

/**
 * The `kind` of the Signal an inbound Message emits.
 *
 * Half of this component's Signal contract. The other half is that the payload is the
 * {@link MessageRecord}, flat, so a Handler is written `SignalHandler<MessageRecord>` and its data
 * function type-checks against that record.
 *
 * The payload names no Channel, one Channel per Messenger making that field constant in every
 * Signal, so a Handler cannot tell which medium a Message arrived over and has nothing to branch
 * on.
 *
 * A `kind` with no Handler registered stores the Message anyway and fails its Signal permanently.
 */
export const messageReceivedKind = "message.received";

/**
 * What reaches one person over one medium.
 *
 * A name, a send, and a lifecycle. A Channel is an ordinary Component an Operator constructs and
 * keys in the Gateway's record, and it is switched off by not constructing it.
 *
 * A Channel registers itself, at the end of its own constructor, the same act as a component
 * registering its routes on the servers it was handed. It has to be that way round: a Channel is
 * constructed with the Messenger, so the reference cannot run both ways at construction time.
 */
export type Channel = Component & {
  /**
   * Which Channel this is, as a constant of its type rather than a construction option.
   *
   * Nothing looks it up. There is no routing on it, one Channel being all there is, and no column
   * storing it. It is what a log line and a refused second registration name.
   */
  readonly name: string;

  /**
   * Takes an outbound Message, inside the transaction that is writing it.
   *
   * The promise is only that the Message is the Channel's now. Arrival is not something every
   * medium can promise, and a queue is not something every medium has: HTTP delivery is the User
   * asking.
   *
   * It must not perform the network act. A publish cannot be rolled back and a transaction can. So
   * an implementation does everything knowable synchronously and throws for anything wrong, which
   * rolls the caller's transaction back and leaves nothing half-done, and whatever has to travel
   * travels after the commit.
   */
  send<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    message: MessageRecord,
  ): Promise<void>;
};

/**
 * What a Channel gets back from {@link Messenger}'s `register`, and the only way an inbound Message
 * can be written.
 *
 * There is no public `receive` on the Messenger. A Channel keeps this handle and writes through it,
 * so a Channel cannot claim to be a different one: it never names itself in the call.
 */
export type MessengerHandle = {
  /**
   * Records one inbound Message and the Signal that wakes the agent for it, and answers with the
   * record as it was stored, `seq` and all.
   *
   * Both statements run in the caller's transaction, so a Channel's own bookkeeping commits with
   * the Message or not at all, and a Message that was stored always has its Signal. The record
   * comes back from here because the caller cannot read its own uncommitted write back through
   * `history`.
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
 * Refused rather than documented, because making a thing unconstructable is cheaper than writing
 * down that nobody should build it. A Messenger with two Channels would need a `channel` argument
 * on `send`, a `channel` column on the log and the name in the Signal payload, and none of the
 * three exists.
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

export type MessengerOptions = {
  readonly db: Db;
  /**
   * The Users component whose Users these Messages belong to. Build it first.
   *
   * Nothing is called on it. `messages.user_id` is a foreign key onto `concorde_users.users.id`, so
   * the dependency is at the schema level, and authentication belongs to the Channel, which serves
   * the routes a User reaches.
   */
  readonly users: Users;
  /**
   * The Signal Worker an inbound Message wakes, in the same transaction that stores the Message.
   *
   * No Messenger can be built without one. A Message that woke nobody would leave the agent with
   * nothing to answer.
   */
  readonly worker: SignalWorker;
  /**
   * Where the agent sends a Message and reads a User's log, at `/messages`.
   *
   * There is no Public server option. What a User reaches is a Channel's, and a Channel that is not
   * HTTP has no route anywhere.
   *
   * Structural: anything carrying a Fastify instance satisfies it.
   */
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
};

/**
 * The Message log as a Component: one table holding every Message in both directions, numbered per
 * User.
 *
 * Its programmatic API is three methods: a registration that hands a Channel the only way to write
 * an inbound Message, a send that joins a transaction of the caller's own, and a read of any User's
 * whole log. Every other capability is a route this component registered itself, and no route
 * plugin is exported.
 *
 * It reaches nobody. Every outbound Message goes out through the one registered {@link Channel},
 * and there is none until one is constructed.
 *
 * Nothing removes a Message and no column is ever updated, so the log is the durable record of what
 * was said and the table grows forever.
 *
 * `start` and `stop` do nothing. This component holds no connection and runs no loop, and a Channel
 * that needs one opens it in its own `start`. A Message that arrives during a shutdown is stored,
 * and its Signal commits with it and stays pending for the next boot.
 */
export type Messenger = Component & {
  /**
   * Registers the Channel that will reach people, and answers with the handle it writes inbound
   * Messages through.
   *
   * Called by the Channel's own constructor and by nothing else, so an entry point performs no
   * wiring here: constructing a Channel with this Messenger is the whole act.
   *
   * @throws `ChannelAlreadyRegisteredError` on a second Channel. One per Messenger.
   */
  register(channel: Channel): MessengerHandle;

  /**
   * Sends a Message to one User from inside the caller's transaction, and answers with the record.
   *
   * Taking the transaction is what keeps answering somebody and recording why in the Operator's own
   * tables from coming apart: a rollback loses both, and loses whatever the Channel wrote in the
   * same transaction to get the Message out. The record comes back from here because the caller
   * cannot read its own uncommitted write through `history`.
   *
   * Always outbound. There is no parameter for the direction and none for the Channel. An unknown
   * User is a thrown `UnknownUserError` rather than a status, there being no reply to write one
   * into, and the insert runs in a savepoint so that refusal does not abort the caller's
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
   * Reads one User's Messages, both directions, ascending by `seq`, so a Handler can build a Prompt
   * from more than the one Message that woke it.
   *
   * Any User's log is readable, and not only the log a Run is serving. A read, so it takes no
   * transaction and cannot see the caller's own uncommitted write.
   *
   * `options` is the cursor window, and the same one both routes take. No cursor answers the newest
   * `limit`, `before` the newest `limit` below it, and `after` everything above it. Both cursors
   * together answer the stretch between them here, where a route refuses them. `limit` takes the
   * routes' default when omitted and is not capped, a cap being there to bound a response body.
   */
  history(
    userId: string,
    options?: {
      readonly after?: number;
      readonly before?: number;
      readonly limit?: number;
    },
  ): Promise<MessageRecord[]>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

/**
 * Builds the Messenger and registers the agent's route group at `/messages` on the Agent server.
 *
 * Nothing here connects, listens or applies DDL, and no Channel is built: the Messenger reaches
 * nobody until one registers with it.
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

    // The two no-ops, whose reason is on the type above.
    start: async () => {},
    stop: async () => {},
  };
}
