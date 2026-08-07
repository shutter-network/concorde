/**
 * The HTTP Channel, from `shared-agent-framework/http-channel`.
 *
 * `createHttpChannel` is the whole of it for an Operator. Hand it the Db, the Messenger, the User
 * Manager and the Public server. It registers itself with the Messenger and puts one route group
 * at `/messages` on that server: a submission, and a cursored read of the submitting User's own
 * log. Then key it in the Gateway's record before the Signal Worker, beside the Messenger, so that
 * it stops after the drain.
 *
 * **It owns no tables, and this subpath carries a constructor and nothing beside it.** The log is
 * the Messenger's, so there is nothing here for an Operator's migration barrel: barrel
 * `shared-agent-framework/messenger` instead, and `shared-agent-framework/users` beside it.
 *
 * It answers with no method trusted code calls. Everything it does, it does for a request or for
 * the Messenger: `send` is a no-op, because HTTP delivery is the User asking, and `start` and
 * `stop` are no-ops because polling holds nothing between requests. What trusted code wants —
 * `send` into whichever medium reaches a person, and `history` — is on the Messenger and is the
 * same call whichever Channel a deployment built.
 *
 * There is **no route anywhere that chooses a Channel**, and no Message records which one it
 * travelled by: one Channel per Messenger, so a deployment runs HTTP or another medium and not
 * both.
 *
 * @example
 * A Gateway a browser can talk to: the Messenger, and this Channel registered with it.
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
 * ```
 *
 * @module
 */

export type { HttpChannel, HttpChannelOptions } from "./http-channel.ts";
export { createHttpChannel } from "./http-channel.ts";
