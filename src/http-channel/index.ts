/**
 * The HTTP Channel is a Channel implementation for the Messenger, carrying Messages between the
 * Shared Agent and a User over HTTP. The Messenger owns the log and reaches nobody; a Channel is
 * what reaches a person over one medium. This one exposes a submission and a poll on the Public
 * server, which a browser can drive with no client library.
 *
 * {@link createHttpChannel} makes one, and {@link HttpChannelOptions} is what it takes.
 * {@link HttpChannel} is what comes back, and it has no programmatic API at all. Sending and
 * reading belong to the Messenger, and HTTP needs no identity of its own beyond the Token a User
 * already presents, so an Operator's own code calls the Messenger and never this.
 *
 * Construct the Messenger and Users first. The constructor registers itself with the Messenger,
 * which accepts at most one Channel, so a deployment that registers this one gives up every other
 * medium.
 *
 * It does not use the Db and exports no schema. It stores nothing, and it queues nothing either:
 * HTTP delivery is the User asking, so an outbound Message is already in the Messenger's log and
 * the next poll carries it.
 *
 * @example
 * A Gateway a browser can talk to: the Messenger, this Channel registered with it, and a Handler
 * for the Signal a submission emits.
 * ```ts
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import { createHttpChannel } from "shared-agent-framework/http-channel";
 * import type { MessageRecord } from "shared-agent-framework/messenger";
 * import { createMessenger, messageReceivedKind } from "shared-agent-framework/messenger";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
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
 *   handlers: ({ messenger }) => ({
 *     [messageReceivedKind]: templateHandler<MessageRecord>({
 *       template: new URL("./prompts/message.hbs", import.meta.url),
 *       session: (signal) => `user_${signal.payload.userId}`,
 *       data: async (signal) => ({ log: await messenger.history(signal.payload.userId) }),
 *     }),
 *   }),
 * });
 *
 * await gateway.start();
 *
 * // The Public server now answers `POST /messages` and `GET /messages?after=<seq>`. Nothing in
 * // the Operator's own code calls this Channel: what the agent says back goes through the
 * // Messenger and arrives on the same log the poll reads.
 * ```
 *
 * @module
 */

export type { HttpChannel, HttpChannelOptions } from "./http-channel.ts";
export { createHttpChannel } from "./http-channel.ts";
