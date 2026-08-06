/**
 * Decisions, from `shared-agent-framework/decisions`.
 *
 * `createDecisions` is the whole of it for an Operator. Hand it the Db, Signatures, the User
 * Manager and both servers. It registers its two route groups at `/decisions` on both. Then key it
 * in the Gateway's record before the Signal Worker, so that it stops after the drain.
 *
 * Construct it after Signatures, which it holds. A Decision that was not signed is not a Decision.
 * It answers with two methods no request can express. `publish` commits to a Statement from inside
 * the caller's transaction, and `history` reads the whole log. Neither takes a User id, because
 * this log has no owner.
 *
 * `DecisionRecord` is the shape every surface answers with, and `jws` is the field that matters:
 * the artifact is the Decision. This subpath also carries the one table. The log references nobody,
 * so a barrel carrying it alone generates cleanly.
 *
 * @example
 * A Gateway with Decisions, and a Statement committed to from the Operator's own code.
 * ```ts
 * import { createPrivateKey } from "node:crypto";
 * import { readFileSync } from "node:fs";
 * import { createGateway } from "shared-agent-framework";
 * import { createDecisions } from "shared-agent-framework/decisions";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createSignatures } from "shared-agent-framework/signatures";
 * import { createUsers } from "shared-agent-framework/users";
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   agentListen: { host: "127.0.0.1", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   extend: ({ db, agentServer, publicServer }) => {
 *     const users = createUsers({ db, tokenTtl: 86_400_000, agentServer, publicServer });
 *     const signatures = createSignatures({
 *       signingKey: createPrivateKey(readFileSync("./signing-key.pem")),
 *       agentServer,
 *       publicServer,
 *       users,
 *     });
 *     return {
 *       users,
 *       signatures,
 *       decisions: createDecisions({ db, signatures, users, agentServer, publicServer }),
 *     };
 *   },
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // The artifact is in hand before the transaction commits.
 * const { db, decisions } = gateway.components;
 * const published = await db.tx((tx) => decisions.publish(tx, "shipping on Friday"));
 * console.log(published.seq, published.jws);
 * ```
 *
 * @module
 */

export type { DecisionRecord, Decisions, DecisionsOptions } from "./decisions.ts";
export { createDecisions } from "./decisions.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit` can
// see. It never looks inside a wrapper object. `decisionsSchema` keeps its prefix, because
// `export *` drops a name that resolves to two bindings.
export * from "./schema.ts";
