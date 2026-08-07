/**
 * The HTTP Channel, the component that reaches a User over HTTP and lets them reach back. A
 * Channel is what carries a Message to one person over one medium; the Messenger owns the log and
 * reaches nobody. This one is a submission and a poll on the Public server, which is what a browser
 * can talk to with no client library.
 *
 * {@link createHttpChannel} makes one, and {@link HttpChannelOptions} is what it takes.
 * {@link HttpChannel} is what comes back, and there is no method on it that trusted code calls.
 * Answering a User is `messenger.send` and reading their log is `messenger.history`, and both are
 * the same call whichever Channel a deployment built.
 *
 * Build the Messenger first, since the constructor registers with it, and build the User Manager
 * first too, for the `requireUser` hook both routes run. A Messenger takes one Channel and refuses
 * the second, so this is where a deployment settles on one medium and gives up the other. Key this
 * in the Gateway's record ahead of the Signal Worker, beside the Messenger: the Worker is keyed
 * last so it drains first, and a Signal Handler's post phase may still be answering somebody.
 *
 * Nothing is stored here and there are no tables, so this subpath has nothing for an Operator's
 * migration barrel. Barrel `shared-agent-framework/messenger` for the log, and
 * `shared-agent-framework/users` beside it. There is no queue either, because HTTP delivery is the
 * User asking: an outbound Message is already in the log, and the next poll carries it.
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
