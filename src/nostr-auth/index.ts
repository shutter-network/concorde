/**
 * The Nostr Auth component authenticates a person by a NIP-98 signature on **every** request,
 * using the Nostr key they already message the Shared Agent from. It is an Auth, so the Public
 * server holds it beside every other scheme a deployment accepts and composes them into the one
 * hook a protected route takes. There is no login, no Token and no route of any kind: a client
 * signs a kind 27235 event naming the URL and the method, sends it as
 * `Authorization: Nostr <base64>`, and this answers with the User the Operator granted that key to.
 *
 * {@link createNostrAuth} makes one, and {@link NostrAuthOptions} is what it takes.
 * {@link NostrAuth} is what comes back, carrying `recordPublicKey` and nothing else: that is the
 * whole of admission to this scheme, it is called from the Operator's own code, and no route
 * anywhere does the same thing.
 *
 * Two options decide whether a first deployment works. `externalBaseUrl` is what clients reach you
 * at, and the `u` tag of every request is compared against it rather than against what the server
 * received, because a reverse proxy rewrites the difference. `windowMs` is how far either side of
 * now a signature may be dated, and it is applied in both directions, so a client with a fast clock
 * is refused rather than holding a credential that never expires.
 *
 * Construct Users first, whose record every outcome carries. A grant here is **not** the Nostr
 * Channel's addressing and neither reads the other: `shared-agent-framework/nostr-channel` records
 * the one key the agent writes to, and this records every key that may act as a User, so a person
 * may be reachable over Nostr without being allowed to drive the HTTP API, and the reverse. A
 * deployment running both writes both, and nothing checks that they agree.
 *
 * The subpath exports the `grants` and `admitted` tables beside the constructor, for the schema an
 * Operator generates their migrations from. `grants.user_id` points a foreign key at the `users`
 * table, so a schema carrying this subpath without `shared-agent-framework/users` generates a
 * constraint onto a table it never creates.
 *
 * @example
 * A Gateway whose Users all hold Nostr keys, with one key granted from the Operator's own code.
 * ```ts
 * import { createGateway } from "shared-agent-framework/gateway";
 * import { createNostrAuth } from "shared-agent-framework/nostr-auth";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, agentServer, publicServer }) => {
 *     const users = createUsers({ db, agentServer, publicServer });
 *     return {
 *       users,
 *       nostrAuth: createNostrAuth({
 *         db,
 *         users,
 *         publicServer,
 *         // What a client typed, not what the proxy forwarded.
 *         externalBaseUrl: "https://agent.example.com",
 *       }),
 *     };
 *   },
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // One transaction, so a User nobody can authenticate as never reaches the table. A second key
 * // for the same person is an ordinary second call.
 * const { db, users, nostrAuth } = gateway.components;
 * await db.tx(async (tx) => {
 *   const user = await users.create(tx);
 *   await nostrAuth.recordPublicKey(tx, user.id, "ab".repeat(32));
 * });
 *
 * // A route of the Operator's own, behind the schemes this deployment accepts.
 * gateway.components.publicServer.fastify.get(
 *   "/whoami",
 *   { preHandler: gateway.components.publicServer.requireUser },
 *   async (request) => ({ id: request.safUser.id }),
 * );
 * ```
 *
 * @module
 */

export type { NostrAuth, NostrAuthOptions } from "./nostr-auth.ts";
export { createNostrAuth } from "./nostr-auth.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit` can
// see. It never looks inside a wrapper object. What it does not carry is the Users component's
// tables. `schema.ts` imports them to declare the foreign key, and re-exports nothing.
// `nostrAuthSchema` keeps its prefix, because `export *` drops a name that resolves to two
// bindings, and a barrel exporting a bare `schema` from two components exports none of them.
export * from "./schema.ts";
