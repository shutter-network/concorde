/**
 * The order in the constructor is load-bearing. `register` runs before the routes are handed to
 * Fastify, so a second HTTP Channel on one Messenger throws before it has put a duplicate route
 * group on anybody's server. Do not move the wiring above it.
 *
 * What `register` answers with is the only way an inbound Message can be written: the Messenger has
 * no public `receive`, on purpose, so that no other code can put words in a User's log and no
 * Channel can claim to be a different one (ADR-0048). Handing the routes the Messenger itself
 * gives them nothing to write through.
 *
 * `send` is a no-op rather than an unwritten member, and there is no queue table behind it. The
 * `Channel` type argues the general case at length: an implementation must not perform the network
 * act inside the caller's transaction, because a publish cannot be rolled back and a transaction
 * can. HTTP has no act to defer either. Delivery is the User asking, so the row in the log is the
 * whole of it and the next poll carries it (ADR-0035). Do not add a queue here.
 *
 * The submission's transaction is opened here and not in the handler, because a route holds no Db.
 * The Messenger's `receive` joins it rather than opening one, which is what would let a Channel
 * with bookkeeping of its own commit that bookkeeping with the Message.
 */

import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import type { Channel, Messenger } from "../messenger/messenger.ts";
import type { Users } from "../users/users.ts";
import { publicMessageRoutes } from "./routes.ts";

// A constant and not an option: no prefix to configure and no plugin to register elsewhere, so a
// client written for one deployment's HTTP Channel works against every other one.
const messagesPrefix = "/messages";

// Fixed by the type rather than settable at construction. Two HTTP Channels on one Messenger are
// unconstructable anyway, so a name a Developer could pass would only be a name they could get
// wrong.
const channelName = "http";

export type HttpChannelOptions = {
  /**
   * The Db one transaction is opened on, and queried through not at all.
   *
   * This component exports no schema and has no table to read. What it needs a Db for is the
   * submission: the Message and the Signal that wakes the agent for it are one act, and the
   * Messenger's inbound write joins that transaction rather than opening one of its own.
   */
  readonly db: Db;
  /**
   * The Messenger that owns the log. Build it before this.
   *
   * The constructor registers with it, and what comes back is the only way to write an inbound
   * Message. A Messenger that already has a Channel refuses the second, so this is where a
   * deployment settles on one medium.
   */
  readonly messenger: Messenger;
  /**
   * Supplies the `requireUser` hook both routes take as one option, and nothing else is read off
   * it.
   *
   * Taken and neither wrapped nor re-implemented, so this component authenticates nobody and an
   * unauthenticated submission or read is refused with the same 401 the routes under `/auth`
   * answer.
   */
  readonly users: Users;
  /**
   * Where Users submit and poll, at `/messages`.
   *
   * A Channel nobody can reach is broken rather than smaller, so there is no assembly of this
   * component that omits it. Structural: anything carrying a Fastify instance satisfies it.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
  };
};

/**
 * The HTTP Channel as a Component, and every member of it does nothing.
 *
 * `send` is the Messenger's to call and is a no-op: HTTP delivery is the User asking, so an
 * outbound Message needs nothing from here, being in the log already for the next poll to carry.
 * `start` and `stop` are no-ops too, because polling opens no connection and sets no ticker going.
 * `name` is `"http"`, which nothing routes on and nothing stores.
 *
 * It keeps nothing: it exports no schema, it queues nothing, and it records no read position, so a
 * restart loses nothing this component was holding and there is nothing here to migrate. The log
 * and every Message in it are the Messenger's.
 *
 * So it has no programmatic API. Everything this Channel does it does for a request on the Public
 * server or for the Messenger that registered it.
 */
export type HttpChannel = Channel;

/**
 * Builds the HTTP Channel, registers it with the Messenger, and registers one route group at
 * `/messages` on the Public server: a submission, and a cursored read of the submitting User's own
 * log.
 *
 * Nothing here connects, listens or applies DDL.
 *
 * @throws `ChannelAlreadyRegisteredError` if a Channel is already registered with that Messenger.
 *   Thrown before either route reaches the server, so a refused second Channel leaves nothing
 *   behind on it.
 */
export function createHttpChannel(options: HttpChannelOptions): HttpChannel {
  // The whole component, and every member of it does nothing. Built before the registration below,
  // because that call takes it.
  const channel: HttpChannel = {
    name: channelName,
    send: async () => {},
    start: async () => {},
    stop: async () => {},
  };

  // Registered as itself, and first: see the file header for both. What comes back is the inbound
  // write, and it exists on no other object anywhere.
  const inbound = options.messenger.register(channel);

  const publicRoutes = publicMessageRoutes(
    {
      history: (userId, window) => options.messenger.history(userId, window),
      // One transaction with two statements in it, opened here because the request is this
      // component's and the write is the Messenger's. Inbound, because this is the Public server
      // and the only User who can cause one is the User the Token named.
      submit: (userId, text) => options.db.tx((tx) => inbound.receive(tx, userId, text)),
    },
    // The hook of Users, passed through and not wrapped. This component authenticates nobody.
    options.users.requireUser,
  );

  // The second act of wiring, here so that an Operator's entry point does neither. Not awaited:
  // Fastify defers a plugin until the server is ready. So this registration is made at
  // construction and loaded at `listen`. A server already listening refuses one.
  options.publicServer.fastify.register(publicRoutes, { prefix: messagesPrefix });

  return channel;
}
