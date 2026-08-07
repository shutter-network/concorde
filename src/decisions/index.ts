/**
 * Decisions, the component that owns the one global log of Decisions. A Decision is a Statement the
 * Shared Agent has committed to in public: signed with its key, numbered from 1, kept forever, and
 * readable by every User rather than addressed to one.
 *
 * {@link createDecisions} makes one. {@link Decisions} is what comes back, carrying the `publish`
 * and `history` that no request can express. {@link DecisionRecord} is what every surface answers
 * with, and `jws` is the field that matters: the artifact is the Decision, and the other three
 * fields can be read back out of it by anybody holding the public key.
 *
 * Build Signatures first, which this signs through. A Decision that was not signed is not a
 * Decision, so there is no degraded mode where rows arrive without artifacts. Build Users
 * first too, for the hook the Public read runs. Key it ahead of the Signal Worker in the
 * Gateway's record: the Worker is keyed last so it drains first, and a Signal Handler's post phase
 * may still publish.
 *
 * Nothing is notified when a Decision is published. There is no Signal and no Handler to wake, so a
 * User discovers a Decision by polling, and the largest `seq` they hold is the whole resume
 * mechanism. The subpath also carries the one table, which references no other component's, so a
 * barrel carrying it without the tables of Users generates cleanly.
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
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
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
