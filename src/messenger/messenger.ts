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

const messagesPrefix = "/messages";

export const messageReceivedKind = "message.received";

export type Channel = Component & {
  readonly name: string;

  /**
   * Stage delivery in the supplied transaction; do not perform irreversible network I/O here.
   * The messenger writes the message before calling this method. Callers send through the messenger.
   */
  send<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    message: MessageRecord,
  ): Promise<void>;
};

export type MessengerHandle = {
  /** Writes an inbound message and emits `messageReceivedKind` in the same transaction. */
  receive<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    text: string,
  ): Promise<MessageRecord>;
};

export class ChannelAlreadyRegisteredError extends Error {
  constructor(registered: string, offered: string) {
    super(
      `Cannot register channel ${offered}: ${registered} is already registered. A messenger accepts one channel.`,
    );
    this.name = "ChannelAlreadyRegisteredError";
  }
}

export class NoChannelError extends Error {
  constructor(userId: string) {
    super(
      `No channel registered for user ${userId}. Register a channel before sending; nothing was recorded.`,
    );
    this.name = "NoChannelError";
  }
}

export type MessengerOptions = {
  readonly db: Db;
  readonly users: Users;
  readonly worker: SignalWorker;
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
};

export type Messenger = Component & {
  /** Accepts one channel only. Returns the inbound API for that channel; a second registration throws. */
  register(channel: Channel): MessengerHandle;

  /** Use a transaction: the message and channel delivery state must commit together. */
  send<TSchema extends Record<string, unknown>>(
    tx: Handle<TSchema>,
    userId: string,
    text: string,
  ): Promise<MessageRecord>;

  /**
   * Cursors are exclusive. With `after`, selects the next page; otherwise selects the latest page
   * before `before`, if supplied. Results are always ascending by seq. Defaults to 50 records.
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

export function createMessenger(options: MessengerOptions): Messenger {
  const handle = options.db.handle(messengerTables);

  let channel: Channel | undefined;

  const readHistory = (userId: string, window: MessageWindow) =>
    selectMessages(handle, userId, window);

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
    send: (userId, text) => options.db.tx((tx) => sendOutbound(tx, userId, text)),
  });

  options.agentServer.fastify.register(agentRoutes, { prefix: messagesPrefix });

  return {
    register: (offered) => {
      if (channel !== undefined)
        throw new ChannelAlreadyRegisteredError(channel.name, offered.name);
      channel = offered;
      return {
        receive: async (tx, userId, text) => {
          const message = await insertMessage(tx, { userId, direction: "inbound", text });
          await options.worker.emit(tx, { kind: messageReceivedKind, payload: message });
          return message;
        },
      };
    },

    send: sendOutbound,
    history: (userId, asked) =>
      readHistory(userId, { ...asked, limit: asked?.limit ?? limitSchema.default }),

    start: async () => {},
    stop: async () => {},
  };
}
