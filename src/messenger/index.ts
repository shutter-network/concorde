/**
 * The Messenger, from `shared-agent-framework/messenger`.
 *
 * `createMessenger` is the whole of it for an Operator. Hand it the Db, the User Manager, the
 * Signal Worker and the Agent server. It registers the agent's route group at `/messages` on that
 * server. Then key it in the Gateway's record before the Signal Worker, so that it stops after the
 * drain.
 *
 * **It owns the Message log and reaches nobody.** Getting a Message to a person is a Channel's
 * job: build one — `shared-agent-framework/http-channel` is the one that serves a browser — hand
 * it this Messenger, and it registers itself. One Channel per Messenger, refused at registration
 * rather than documented.
 *
 * It answers with three things no request can express. `register` takes the Channel and answers
 * with the only way to write an inbound Message. `send` writes a Message to one User from inside
 * the caller's transaction. `history` reads any User's log.
 *
 * `messageReceivedKind` and `MessageRecord` are the two halves of this component's Signal
 * contract, and neither changed when the log was taken out of the HTTP Messenger, so a Handler
 * written against that part needs no edit. An Operator's Handler map needs no string literal and
 * no re-declared payload. This subpath also carries the one table. Barrel
 * `shared-agent-framework/users` beside it, because `messages.user_id` references the User
 * Manager's table.
 *
 * @example
 * A Gateway that answers a submitted Message, and a Handler written against the record.
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

export type { MessageRecord } from "./messages.ts";
export type { Channel, Messenger, MessengerHandle, MessengerOptions } from "./messenger.ts";
export { createMessenger, messageReceivedKind } from "./messenger.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit` can
// see. It never looks inside a wrapper object. What it does not carry is the User Manager's
// tables. `schema.ts` imports them to declare the foreign key, and re-exports nothing.
export * from "./schema.ts";
