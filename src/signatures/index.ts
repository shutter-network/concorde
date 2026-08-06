/**
 * Signatures, from `shared-agent-framework/signatures`.
 *
 * `createSignatures` is the whole of it for an Operator. Hand it the Shared Agent's private key,
 * both servers and the User Manager. It derives the public half and registers three routes. `POST
 * /sign` is where only the agent reaches it. `POST /verify` sits behind the Manager's single 401,
 * and `GET /jwks.json` in front of everything. Then key it in the Gateway's record before the
 * Signal Worker, so that it outlives the drain. A Signal Handler's post phase may still need to
 * sign.
 *
 * The key is yours to load and ours to hold. It is a `crypto.KeyObject`, and this framework parses
 * no PEM, reads no environment variable and opens no file. Write
 * `createPrivateKey(readFileSync(path))` and decide for yourself where that came from. Nothing here
 * generates a keypair, so a restart cannot silently invalidate every artifact ever published.
 *
 * It answers with one method, `sign`, which is what trusted code has and no request does. Decisions
 * holds this object and signs in process, never by calling the Gateway's own routes. `SignedClaims`
 * is what goes into the payload. The order of its keys is the order of the bytes. A compact JWS is
 * signed as exactly what was emitted.
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
