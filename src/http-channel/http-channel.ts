import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Db } from "../db/index.ts";
import type { Channel, Messenger } from "../messenger/messenger.ts";
import { publicMessageRoutes } from "./routes.ts";

const messagesPrefix = "/messages";

const channelName = "http";

export type HttpChannelOptions = {
  readonly db: Db;
  readonly messenger: Messenger;
  readonly publicServer: {
    readonly fastify: FastifyInstance;
    readonly requireUser: preHandlerAsyncHookHandler;
  };
};

export type HttpChannel = Channel;

/** Registers with the messenger during construction. Outbound messages are read by polling; no push delivery occurs. */
export function createHttpChannel(options: HttpChannelOptions): HttpChannel {
  const channel: HttpChannel = {
    name: channelName,
    send: async () => {},
    start: async () => {},
    stop: async () => {},
  };

  const inbound = options.messenger.register(channel);

  const publicRoutes = publicMessageRoutes(
    {
      history: (userId, window) => options.messenger.history(userId, window),
      submit: (userId, text) => options.db.tx((tx) => inbound.receive(tx, userId, text)),
    },
    options.publicServer.requireUser,
  );

  options.publicServer.fastify.register(publicRoutes, { prefix: messagesPrefix });

  return channel;
}
