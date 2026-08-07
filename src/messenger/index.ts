/**
 * The Messenger, the component that owns the Message log. A Message is a `text` string travelling
 * one way between the Shared Agent and one User, numbered from 1 inside that User's log across both
 * directions, kept forever.
 *
 * {@link createMessenger} makes one. {@link Messenger} is what comes back, and it carries the three
 * acts no request can express: taking a Channel, sending to one User inside a transaction of the
 * caller's own, and reading any User's whole log. {@link MessageRecord} is what every surface
 * answers with, and it is the Signal payload too: with {@link messageReceivedKind} beside it, an
 * Operator's Handler map needs no string literal of its own and no payload type to re-declare.
 *
 * It reaches nobody. A {@link Channel} is what gets a Message to a person over one medium, and
 * `shared-agent-framework/http-channel` and `shared-agent-framework/nostr-channel` are the two that
 * ship. Construct one with this Messenger and it registers itself, so an entry point wires nothing
 * further. One Channel per Messenger, refused at registration, so a deployment runs one medium and
 * a `send` before any Channel exists throws rather than recording something nothing will deliver.
 *
 * Build Users before this, which it takes beside the Signal Worker the Gateway hands to
 * `extend`. Key this component and its Channel ahead of that Worker in the Gateway's record: the
 * Worker is keyed last so it drains first, and a Signal Handler's post phase is where a person is
 * told that their Run failed.
 *
 * The subpath also carries the one table. Barrel `shared-agent-framework/users` beside it, because
 * `messages.user_id` references the Users component's table and a barrel without it generates a
 * foreign key onto a table nothing creates.
 *
 * @example
 * A Gateway whose agent answers a submitted Message over HTTP, and a send from the Operator's own
 * trusted code.
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
