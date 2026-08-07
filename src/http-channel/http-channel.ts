/**
 * The HTTP Channel: the way a User reaches a Shared Agent over HTTP, and it over them.
 *
 * One call builds it, and it registers one route group at `/messages` on the Public server: a
 * submission, and a cursored read of the submitting User's own log (ADR-0035). Delivery is
 * polling, so `?after=<seq>` is the whole of the resume mechanism, and `send` is a no-op:
 * **HTTP delivery is the User asking**, so there is nothing to hand anybody and no queue to put
 * it in (ADR-0048).
 *
 * **It owns no tables and no schema.** The log is the Messenger's, whichever Channel a Message
 * travelled by, and this subpath carries a constructor and nothing beside it — the second
 * component of which that is true, after Signatures (ADR-0042, ADR-0047).
 *
 * It registers itself with the Messenger inside its own constructor, and what it gets back is the
 * only way to write an inbound Message. So an Operator's entry point performs no wiring, and
 * nothing but a registered Channel can put words in a User's log.
 */

import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import type { Channel, Messenger } from "../messenger/messenger.ts";
import type { Users } from "../users/users.ts";
import { publicMessageRoutes } from "./routes.ts";

/**
 * Where the route group lands, on the Public server.
 *
 * A constant and not an option. There is no prefix to configure and no plugin to register
 * elsewhere. So a client written for one deployment's HTTP Channel works against every other's.
 */
const messagesPrefix = "/messages";

/**
 * Which Channel this is, fixed by its type.
 *
 * Not a construction option: two HTTP Channels on one Messenger are unconstructable anyway, so a
 * name a Developer could set would only be a name they could get wrong.
 */
const channelName = "http";

/** Everything `createHttpChannel` needs: the Db, two Components, and the Public server. */
export type HttpChannelOptions = {
  /**
   * The Db this component opens one transaction on, and queries through not at all.
   *
   * It owns no tables. What it needs a Db for is the transaction a submission runs in: the Message
   * and the Signal that wakes the agent for it are one act, and the Messenger's inbound write
   * takes the transaction rather than opening one, so that a Channel with bookkeeping of its own
   * can join it.
   */
  readonly db: Db;
  /**
   * The Messenger that owns the log. Build it before this.
   *
   * The constructor calls `register` on it, which is what makes this Channel the one that reaches
   * people and hands back the only way to write an inbound Message. A second Channel on the same
   * Messenger is refused there.
   */
  readonly messenger: Messenger;
  /**
   * The User Manager whose Users these Messages belong to.
   *
   * Where the routes' authentication comes from, and the whole of what this option is for.
   * `requireUser` is taken off this object and put on the route as one option, so every refusal is
   * the Manager's single 401 and this component authenticates nobody.
   */
  readonly users: Users;
  /**
   * The Public server, where Users reach their own Messages, at `/messages`.
   *
   * Required. A Channel nobody can reach is broken rather than smaller. Structural, so what
   * `serverComponent` returns satisfies it.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
  };
};

/**
 * The HTTP Channel as a Component, and it is a Channel and nothing more.
 *
 * There is no method here that trusted code calls: everything this component does, it does for a
 * request on the Public server or for the Messenger that registered it. `send` is the Messenger's
 * to call and does nothing; `start` and `stop` do nothing, because polling opens no connection and
 * sets no ticker going.
 *
 * A deployment holds it to key it in the Gateway's record, ahead of the Signal Worker like the
 * Messenger itself.
 */
export type HttpChannel = Channel;

/**
 * Builds the HTTP Channel, registers it with the Messenger, and puts its routes at `/messages` on
 * the Public server.
 *
 * Nothing here connects, listens or applies DDL. Key the result before the Signal Worker, so that
 * it stops after the drain: a Signal Handler's post phase runs `messenger.send` into this
 * component's `send`.
 *
 * @throws `ChannelAlreadyRegisteredError` if a Channel is already registered with that Messenger.
 *
 * @example
 * Built in `extend`, after the Messenger it registers with.
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
 * ```
 */
export function createHttpChannel(options: HttpChannelOptions): HttpChannel {
  // The whole component, and every member of it does nothing. `send` is the no-op the type on
  // `Channel` argues for at length: HTTP delivery is the User asking, so an outbound Message needs
  // nothing from this component — it is in the log, and the next poll carries it. `start` and
  // `stop` are the two every Component has to have, and polling holds nothing between requests.
  const channel: HttpChannel = {
    name: channelName,
    send: async () => {},
    start: async () => {},
    stop: async () => {},
  };

  // Registered first, and registered as itself, so that a second HTTP Channel on one Messenger
  // throws before it has put a duplicate route group on anybody's server. What comes back is the
  // inbound write, and it exists on no other object anywhere.
  const inbound = options.messenger.register(channel);

  const publicRoutes = publicMessageRoutes(
    {
      history: (userId, window) => options.messenger.history(userId, window),
      // One transaction with two statements in it, opened here because the request is this
      // component's and the write is the Messenger's. Inbound, because this is the Public server
      // and the only User who can cause one is the User the Token named.
      submit: (userId, text) => options.db.tx((tx) => inbound.receive(tx, userId, text)),
    },
    // The Manager's own hook, passed through and not wrapped. This component authenticates nobody.
    options.users.requireUser,
  );

  // The second act of wiring, here so that an Operator's entry point does neither. Not awaited:
  // Fastify defers a plugin until the server is ready. So this registration is made at
  // construction and loaded at `listen`. A server already listening refuses one.
  options.publicServer.fastify.register(publicRoutes, { prefix: messagesPrefix });

  return channel;
}
