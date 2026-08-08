/**
 * The Nostr Channel is a Channel implementation for the Messenger, reaching a User in the Nostr
 * client they already use and letting them reach the Shared Agent from it. The Messenger owns the
 * log and reaches nobody; a Channel is what reaches a person over one medium. This one exchanges
 * NIP-17 private direct messages over a single connection to one **Relay** the Operator runs, and a
 * message from a public key the Operator recorded becomes an inbound Message and its Signal in one
 * transaction, so a Signal Handler or a Prompt template written against the Messenger needs no
 * change.
 *
 * {@link createNostrChannel} makes one. {@link NostrChannel} is what comes back. Its programmatic
 * API is `recordPublicKey`, which admits one User to this medium, and `publicKey`, which is the
 * address an Operator tells that User to write to; everything else on it the Messenger and the
 * Relay drive. {@link NostrChannelOptions} takes the Shared Agent's Nostr secret key as 32 raw
 * bytes, a second keypair that the signing identity neither is nor can become.
 *
 * It registers no route on either server, a Relay being what a User reaches over this medium, so a
 * deployment running this and nothing else has a Public server carrying only the login. It
 * publishes one thing about itself and no profile, a relay list naming that Relay, so the agent
 * appears in a client as a bare public key.
 *
 * Construct the Messenger and Users first: the constructor registers with the Messenger, and these
 * public keys belong to Users. A Messenger accepts at most one Channel and refuses a second at
 * registration, so a deployment runs Nostr or HTTP and not both.
 *
 * A key recorded here decides where the agent writes and nothing else. It grants no access to the
 * HTTP API: that is `shared-agent-framework/nostr-auth`, which keeps a table of its own that this
 * one never reads. A deployment wanting both writes both, and nothing checks that they agree.
 *
 * The subpath exports the three tables, `pubkeys`, `received` and `outbox`, beside the constructor,
 * for the schema an Operator generates their migrations from. Put `shared-agent-framework/users`
 * into that same schema, because two of those tables reference the Users component's table, and a
 * schema without it generates a foreign key onto a table nothing creates.
 *
 * @example
 * A Gateway a User reaches over Nostr, with their public key recorded out of band.
 * ```ts
 * import { readFileSync } from "node:fs";
 * import { createGateway } from "shared-agent-framework/gateway";
 * import { createMessenger } from "shared-agent-framework/messenger";
 * import { createNostrChannel } from "shared-agent-framework/nostr-channel";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * // The framework parses no key material: 32 raw bytes, decoded by the deployment.
 * const secretKey = Uint8Array.from(
 *   Buffer.from(readFileSync(process.env.NOSTR_KEY_FILE ?? "", "utf8").trim(), "hex"),
 * );
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, agentServer, worker }) => {
 *     // No Public server here: this deployment accepts no HTTP scheme at all, and
 *     // `GET /users/me` is unbuildable without one.
 *     const users = createUsers({ db, agentServer });
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
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // Admission, out of band and from trusted code, in a transaction of the Operator's own.
 * const { db, nostr } = gateway.components;
 * await db.tx((tx) => nostr.recordPublicKey(tx, "a-user-id", "ab".repeat(32)));
 *
 * // What an Operator tells that User to message.
 * console.log(nostr.publicKey);
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
// see. It never looks inside a wrapper object. What it does not carry is the Users component's
// tables. `schema.ts` imports them to declare the foreign key, and re-exports nothing.
export * from "./schema.ts";
