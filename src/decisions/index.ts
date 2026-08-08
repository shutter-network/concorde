/**
 * The Decisions component owns the one global log of Decisions. A Decision is a Statement the
 * Shared Agent has committed to in public: signed with its key, numbered from 1, kept forever, and
 * readable by every User rather than addressed to one.
 *
 * {@link createDecisions} makes one. {@link Decisions} is what comes back, and its programmatic API
 * publishes into the log and reads it back. {@link DecisionRecord} is what every surface answers
 * with, and `jws` is the field that matters: the artifact is the Decision, and the other three
 * fields can be read back out of it by anybody holding the public key.
 *
 * Construct Signatures first. Every Decision is signed, so there is no degraded mode in
 * which rows arrive without artifacts. Nothing else is taken: the two Public reads run behind the
 * Public server's own hook, so a deployment with no Auth registered on that server refuses both on
 * every request.
 *
 * Publishing notifies nobody. It emits no Signal and wakes no Handler, so a User discovers a
 * Decision by polling, and the largest `seq` they hold is the whole resume mechanism.
 *
 * The subpath exports the one table beside the constructor, for the schema an Operator generates
 * their migrations from. It references no other component's table, so it can go into that schema
 * on its own.
 *
 * @example
 * A Gateway with Decisions, and a Statement committed to from the Operator's own code.
 * ```ts
 * import { createPrivateKey } from "node:crypto";
 * import { readFileSync } from "node:fs";
 * import { createGateway } from "shared-agent-framework/gateway";
 * import { createDecisions } from "shared-agent-framework/decisions";
 * import { createPasswordAuth } from "shared-agent-framework/password-auth";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createSignatures } from "shared-agent-framework/signatures";
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
 *     const signatures = createSignatures({
 *       signingKey: createPrivateKey(readFileSync("./signing-key.pem")),
 *       agentServer,
 *       publicServer,
 *     });
 *     return {
 *       users,
 *       // Some scheme has to be registered, or both reads refuse every request.
 *       passwordAuth: createPasswordAuth({ db, users, publicServer, tokenTtl: 86_400_000 }),
 *       signatures,
 *       decisions: createDecisions({ db, signatures, agentServer, publicServer }),
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
