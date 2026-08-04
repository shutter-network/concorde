/**
 * Signatures, from `shared-agent-framework/signatures`.
 *
 * A subpath of its own, like the User Manager's and the HTTP Messenger's, so that what a
 * deployment depends on is legible from its import statements. Unlike theirs it exports **no
 * migration descriptor**, because this part stores nothing: no schema, no tables, no
 * migrations, and therefore nothing for a pre-deploy migration entry point to register
 * ([ADR-0042](../../docs/adr/0042-a-signature-is-a-compact-jws.md)).
 *
 * `createSignatures` is the whole of it for an Operator: hand it the Shared Agent's private
 * key and the Public server, and it derives the public half and registers `GET /jwks.json`
 * there (ADR-0032). Then put it in the Gateway's record like every other part: it is a
 * Component whose `start` and `stop` do nothing, keyed **before** the Signal Worker so that it
 * outlives the drain, which is when a Signal Handler's post phase may still need to sign
 * (ADR-0037, ADR-0038).
 *
 * **The key is yours to load and ours to hold.** It is a `crypto.KeyObject` and this framework
 * parses no PEM, reads no environment variable and opens no file: an Operator writes
 * `createPrivateKey(readFileSync(path))` and decides for themselves where that came from
 * (ADR-0016). Nothing here generates a keypair either, so a restart cannot silently invalidate
 * every artifact ever published ([ADR-0041](../../docs/adr/0041-the-shared-agent-has-a-signing-identity.md)).
 *
 * What it answers with is one method, `sign`, and that is what trusted code has and no request
 * does: Decisions holds this object and signs **in process**, never by calling the Gateway's
 * own routes. `SignedClaims` is what goes into the payload, and the order of its keys is the
 * order of the bytes, because a compact JWS is signed as exactly what was emitted and nothing
 * re-serializes it.
 *
 * **No route plugin is exported and no path is configurable**, as with the HTTP Messenger and
 * for the same reason: these routes are half of a contract whose other half is the artifact
 * shape and a verifier written against both (ADR-0034).
 */

export type { Signatures, SignaturesOptions, SignedClaims } from "./signatures.ts";
export { createSignatures } from "./signatures.ts";
