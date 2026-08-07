/**
 * The Nostr Channel, from `shared-agent-framework/nostr-channel`.
 *
 * `createNostrChannel` is the whole of it for an Operator. Hand it the Db, the Messenger, the
 * User Manager, the Shared Agent's Nostr secret key as 32 raw bytes, and the address of the one
 * Relay the Operator runs. It registers itself with that Messenger, and what it gets back is the
 * only way to write an inbound Message (ADR-0048). Then key it in the Gateway's record before the
 * Signal Worker, so that it stops after the drain.
 *
 * **It registers no route on either server.** What a User reaches over this medium is the Relay,
 * so a deployment running this and nothing else has a Public server with only the User Manager's
 * login on it. Users message the agent from the Nostr client they already use, in NIP-17 private
 * direct messages, and a message from a recorded key becomes an inbound Message and a Signal in
 * one transaction — so every Signal Handler and Prompt template written against the Messenger
 * keeps working unchanged.
 *
 * **One Channel per Messenger**, refused at registration, so a deployment runs Nostr or HTTP and
 * not both. That is why `example/` keeps HTTP and there is no Nostr section in the quickstart.
 *
 * **A reply travels in two steps, and the split is the design.** `messenger.send` runs the
 * Channel's own `send` inside the Operator's transaction, where the recipient's key is resolved,
 * the reply is sealed into one gift wrap, its size is compared against what the Relay advertises,
 * and the wrap is queued. Anything wrong there throws and takes the Message with it, so nothing
 * claims to have been sent. The publish itself waits for that transaction to commit and happens in
 * `drain`. A reply the Relay refuses keeps its queue row with the Relay's own reason on it and is
 * never attempted again, so `select * from saf_nostr.outbox where reason is not null` answers "why
 * did she not get it" with no API and no log trawl.
 *
 * `recordPublicKey` is the one method trusted code calls, and it proves nothing: the Operator
 * establishes out of band that a key is a person's, and no route anywhere records one, so an
 * injected prompt cannot claim a User's key (ADR-0049). This subpath also carries the three tables.
 * Barrel `shared-agent-framework/users` beside it, because `pubkeys.user_id` and `outbox.user_id`
 * reference the User Manager's table.
 *
 * The Nostr identity is a **second** keypair, secp256k1 where the signing identity is Ed25519, and
 * it cannot be that key or become it (ADR-0050). The framework parses no key material: the
 * constructor takes bytes an Operator decoded themselves, and no `nsec` decoder is shipped.
 *
 * @example
 * A Gateway a User reaches over Nostr, with the key recorded out of band.
 * ```ts
 * import { readFileSync } from "node:fs";
 * import { createGateway, templateHandler } from "shared-agent-framework";
 * import type { MessageRecord } from "shared-agent-framework/messenger";
 * import { createMessenger, messageReceivedKind } from "shared-agent-framework/messenger";
 * import { createNostrChannel } from "shared-agent-framework/nostr-channel";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * const secretKey = Uint8Array.from(
 *   Buffer.from(readFileSync(process.env.NOSTR_KEY_FILE ?? "", "utf8").trim(), "hex"),
 * );
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
 *       nostr: createNostrChannel({
 *         db,
 *         messenger,
 *         users,
 *         secretKey,
 *         relayUrl: process.env.RELAY_URL ?? "",
 *       }),
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

export {
  MalformedPublicKeyError,
  NoSuchUserError,
  PublicKeyConflictError,
} from "./identities.ts";
export type { NostrChannel, NostrChannelOptions } from "./nostr-channel.ts";
export { createNostrChannel } from "./nostr-channel.ts";
export { MessageTooLargeError, UnrecordedPublicKeyError } from "./outbound.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit` can
// see. It never looks inside a wrapper object. What it does not carry is the User Manager's
// tables. `schema.ts` imports them to declare the foreign key, and re-exports nothing.
export * from "./schema.ts";
