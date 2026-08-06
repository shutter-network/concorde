/**
 * The HTTP Messenger, from `shared-agent-framework/http-messenger`.
 *
 * `createHttpMessenger` is the whole of it for an Operator. Hand it the Db, the User Manager, the
 * Signal Worker and both servers. It registers its two route groups at `/messages` on both. Then
 * key it in the Gateway's record before the Signal Worker, so that it stops after the drain.
 *
 * It answers with two methods no request can express. `send` writes a Message to one User from
 * inside the caller's transaction. `history` reads any User's log. There is no method that writes
 * an inbound Message.
 *
 * `messageReceivedKind` and `MessageRecord` are the two halves of this component's Signal
 * contract. An Operator's Handler map needs no string literal and no re-declared payload. This
 * subpath also carries the one table. Barrel `shared-agent-framework/users` beside it, because
 * `messages.user_id` references the User Manager's table.
 *
 * @example
 * A Gateway that answers a submitted Message, and a Handler written against the record.
 * ```ts
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import type { MessageRecord } from "shared-agent-framework/http-messenger";
 * import { createHttpMessenger, messageReceivedKind } from "shared-agent-framework/http-messenger";
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
 *   handlers: ({ messages }) => ({
 *     [messageReceivedKind]: templateHandler<MessageRecord>({
 *       template: new URL("./prompts/message.hbs", import.meta.url),
 *       session: (signal) => `user_${signal.payload.userId}`,
 *       data: async (signal) => ({ log: await messages.history(signal.payload.userId) }),
 *     }),
 *   }),
 * });
 *
 * await gateway.start();
 * ```
 *
 * @module
 */

export type { HttpMessenger, HttpMessengerOptions } from "./http-messenger.ts";
export { createHttpMessenger, messageReceivedKind } from "./http-messenger.ts";
export type { MessageRecord } from "./messages.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit` can
// see. It never looks inside a wrapper object. What it does not carry is the User Manager's
// tables. `schema.ts` imports them to declare the foreign key, and re-exports nothing.
export * from "./schema.ts";
