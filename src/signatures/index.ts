/**
 * Signatures, the component that holds the Shared Agent's signing identity. A Signed Statement is
 * one compact JWS: a string anybody can check against the agent's public key, offline, without
 * reaching this Gateway and without trusting the Operator.
 *
 * {@link createSignatures} makes one. {@link Signatures} is what comes back, and its `sign` is the
 * whole of what trusted code gets. {@link SignedClaims} is what goes into a payload.
 *
 * The deployment brings the key. Nothing here parses a PEM, reads an environment variable or
 * generates a keypair, so construction without one throws rather than inventing an identity.
 *
 * Build the User Manager first, whose `requireUser` this takes, and build this before Decisions,
 * which signs through it. Key it ahead of the Signal Worker in the Gateway's record: the Worker is
 * keyed last so it drains first, and a Signal Handler's post phase may still need to sign.
 *
 * @example
 * A Gateway with Signatures, and a Statement signed from the Operator's own code.
 * ```ts
 * import { createPrivateKey } from "node:crypto";
 * import { readFileSync } from "node:fs";
 * import { createGateway } from "shared-agent-framework";
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
