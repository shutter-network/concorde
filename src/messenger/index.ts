/**
 * The Messenger component owns the Message log. A Message is a `text` string travelling one way
 * between the Shared Agent and one User, numbered from 1 inside that User's log across both
 * directions, kept forever.
 *
 * {@link createMessenger} makes one. {@link Messenger} is what comes back, and its programmatic API
 * registers a Channel, sends to one User inside a transaction the caller opened, and reads any
 * User's whole log. {@link MessageRecord} is the record every surface answers with, and an inbound
 * one is also the payload of the Signal that announces it. That Signal's `kind` is
 * {@link messageReceivedKind}, so a Handler map keys off an exported constant and types its payload
 * as `MessageRecord`, declaring neither for itself.
 *
 * The Messenger reaches nobody. A {@link Channel} carries a Message to a person over one medium,
 * and `shared-agent-framework/http-channel` and `shared-agent-framework/nostr-channel` are the two
 * implementations that ship. Construct one with this Messenger and it registers itself, so an entry
 * point wires nothing further.
 *
 * A Messenger accepts at most one Channel, and registering a second throws. A deployment therefore
 * runs one medium. Until a Channel registers, `send` throws rather than recording a Message nothing
 * will deliver.
 *
 * Construct Users and the Signal Worker before this, which takes both.
 *
 * The subpath exports the one table beside the constructor. Put `shared-agent-framework/users` into
 * the same schema, because `messages.user_id` references the Users component's table, and a schema
 * without it generates a foreign key onto a table nothing creates.
 *
 * @example
 * A Gateway whose agent answers a submitted Message over HTTP, and a send from the Operator's own
 * trusted code.
 * ```ts
 * import { createGateway } from "shared-agent-framework/gateway";
 * import { createHttpChannel } from "shared-agent-framework/http-channel";
 * import type { MessageRecord } from "shared-agent-framework/messenger";
 * import { createMessenger, messageReceivedKind } from "shared-agent-framework/messenger";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { templateHandler } from "shared-agent-framework/signals";
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
 *       // The Channel takes the Messenger and registers itself with it.
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
 * // A send that commits with whatever else the Operator's transaction writes.
 * const { db, messenger } = gateway.components;
 * async function tell(userId: string, text: string): Promise<void> {
 *   await db.tx((tx) => messenger.send(tx, userId, text));
 * }
 * ```
 *
 * @module
 */

export type { MessageRecord } from "./messages.ts";
export type { Channel, Messenger, MessengerHandle, MessengerOptions } from "./messenger.ts";
export { createMessenger, messageReceivedKind } from "./messenger.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit` can
// see. It never looks inside a wrapper object. What it does not carry is the Users component's
// tables. `schema.ts` imports them to declare the foreign key, and re-exports nothing.
export * from "./schema.ts";
