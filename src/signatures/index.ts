/**
 * The Signatures component holds the Shared Agent's signing identity. A Signed Statement is one
 * compact JWS: a string anybody can check against the agent's public key, offline, without reaching
 * this Gateway and without trusting the Operator.
 *
 * {@link createSignatures} makes one. {@link Signatures} is what comes back, and its programmatic
 * API is the single `sign`. {@link SignedClaims} is what goes into a payload.
 *
 * The deployment brings the key. Nothing here parses a PEM, reads an environment variable or
 * generates a keypair, so construction without one throws rather than inventing an identity.
 *
 * Construct Users first, whose `requireUser` this takes, and construct this before Decisions, which
 * signs through it.
 *
 * It does not use the Db and exports no schema. A Signed Statement is never kept, so an Operator's
 * migrations have nothing of this component to create.
 *
 * @example
 * A Gateway with Signatures, and a Statement signed from the Operator's own code.
 * ```ts
 * import { createPrivateKey } from "node:crypto";
 * import { readFileSync } from "node:fs";
 * import { createGateway } from "shared-agent-framework/gateway";
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
 *     return {
 *       users,
 *       signatures: createSignatures({
 *         signingKey: createPrivateKey(readFileSync("./signing-key.pem")),
 *         agentServer,
 *         publicServer,
 *         users,
 *       }),
 *     };
 *   },
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 *
 * // One URL-safe string, checkable against `GET /jwks.json` with any JOSE library.
 * const jws = await gateway.components.signatures.sign("my-receipt+jws", {
 *   statement: "paid in full",
 *   invoice: "2026-0043",
 * });
 * console.log(jws);
 * ```
 *
 * @module
 */

export type { Signatures, SignaturesOptions, SignedClaims } from "./signatures.ts";
export { createSignatures } from "./signatures.ts";
