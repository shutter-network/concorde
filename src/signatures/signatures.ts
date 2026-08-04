/**
 * Signatures: the part of the Gateway that holds the Shared Agent's signing identity.
 *
 * Constructed like every other part — one call, an ordinary object back, and nothing to
 * register it with. It wires itself the way every part does, registering its route group on
 * the server it is handed (ADR-0032).
 *
 * It is the **first part of the framework with no storage at all**: no schema, no tables, no
 * migrations and no migration descriptor, so there is no Db argument either
 * ([ADR-0042](../../docs/adr/0042-a-signature-is-a-compact-jws.md)). It is a Component
 * anyway, on the User Manager's grounds: the Gateway's record holds every part and not only
 * the ones that run (ADR-0037). Both its methods do nothing.
 *
 * Three things about it are decisions rather than omissions:
 *
 *  - **The key is a `crypto.KeyObject` and this framework parses nothing.** No PEM handling,
 *    no environment reading, no file paths. The Operator writes
 *    `createPrivateKey(readFileSync(path))` and decides for themselves whether that path came
 *    from a file, an environment variable or a secrets manager — the same division as
 *    `HOST_DIR` in the reference deployment, and ADR-0016's instinct applied to a secret. A
 *    `KeyObject` also keeps its material in the OpenSSL layer rather than as a JS value, so it
 *    does not stringify into a log line by accident
 *    ([ADR-0041](../../docs/adr/0041-the-shared-agent-has-a-signing-identity.md)).
 *  - **The public half is derived, never a second option.** A second argument would be a
 *    second answer to "which key is this", and the day they disagreed the key set would
 *    describe a key that signed nothing.
 *  - **The framework never generates a keypair**, so no key means construction throws. A
 *    fresh key per restart would leave every prior artifact unverifiable with nothing anywhere
 *    saying so, and persisting a generated one would put a usable private key in a table
 *    (ADR-0041).
 *
 * **`jose` builds the artifact, and this part is the only one that imports it**
 * (ADR-0042). Decisions asks for a JWS and stores the string. What that buys is the
 * `alg` → (hash, signature encoding, padding) mapping and the key/alg compatibility check,
 * which were the most dangerous code in the design and are now the library's. Do not
 * reintroduce either: a second mapping that disagrees with the library's is worse than
 * none, and a self-consistent implementation cannot see its own bug — every other library
 * on earth rejects the artifact.
 *
 * **Signing is logged and never stored.** One line per signing at info level, carrying the
 * `typ` and a SHA-256 digest of the Statement rather than the Statement, so the trail is a
 * trail and not a shadow copy of every private thing the agent ever signed sitting in
 * stdout (ADR-0042). The regression underneath that is real and recorded rather than
 * solved: an injected agent mints unlimited Signed Statements with no row anywhere.
 */

import { createHash, createPublicKey, type JsonWebKey, type KeyObject } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CompactSign } from "jose";
import type { Component } from "../components.ts";
import { defaultLogger, type Logger } from "../logging.ts";
import { type KeySet, publicSignatureRoutes } from "./routes.ts";

/**
 * What a signature commits to: the Statement, and whatever else the caller is binding to it.
 *
 * `statement` is required and named because it is the domain term — the string a signature
 * commits to — and because it is the one claim this part reads for itself, to digest into the
 * log line rather than write it there. Everything else is the caller's: Decisions binds a
 * `seq` and a `createdAt` beside it, and the object it hands over is the object that gets
 * serialized, **in the order its keys were written**.
 *
 * That last sentence is the whole reason this takes an object rather than a Statement and a
 * bag of extras. The payload is signed as the exact bytes emitted and nothing re-serializes
 * it, which is why a JSON payload is safe here at all and why "sign canonical JSON" was
 * rejected (ADR-0042). A caller that builds the claims is a caller that decides the bytes.
 */
export type SignedClaims = {
  readonly statement: string;
} & Readonly<Record<string, unknown>>;

export type SignaturesOptions = {
  /**
   * The Shared Agent's private key, as a `crypto.KeyObject`, and the whole of its identity.
   *
   * Required, and the framework will not generate one: copying this key copies the agent, and
   * there is no second name for it anywhere — no key identifier on any record, and nothing
   * identifying the deployment inside what is signed (ADR-0041).
   */
  readonly signingKey: KeyObject;
  /**
   * The JOSE algorithm the header declares, when the key does not settle it by itself.
   *
   * Optional, and derived from the key's **JWK export** when it is left out, because the
   * export speaks JOSE's own curve names where `asymmetricKeyDetails` speaks OpenSSL's
   * (ADR-0042). Given, it is passed to `jose` unexamined: there is no key/alg compatibility
   * check of ours, because there is one of the library's and a second would be a second
   * opinion.
   */
  readonly signingAlg?: string;
  /**
   * The Public server, where the key set is served at **`/jwks.json`**.
   *
   * Required, and unauthenticated, a public key being public: it is what makes verification
   * possible for the party the identity exists for, who does not trust the Operator and would
   * learn nothing from the Gateway's own opinion of an artifact (ADR-0042). Signatures with
   * nowhere to publish the key is broken rather than smaller.
   *
   * Structural, and asks for nothing but the Fastify instance, for the purely technical reason
   * every other part's server option is — `FastifyInstance` has five generic parameters — so
   * what satisfies it is what `serverComponent` returns.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
  };
  /** Defaults to a `pino` instance on stdout, and is what the signing line is written to. */
  readonly logger?: Logger;
};

/**
 * What the constructor answers with: the one thing trusted code needs and no request can
 * express.
 *
 * `sign` is an **in-process call and never an HTTP request**. Decisions holds this object and
 * calls the method; a Decision published inside a transaction cannot go out over a socket and
 * back, and a Gateway that signed by calling itself would have a route as a hard dependency of
 * its own write path.
 *
 * There is deliberately nothing here that verifies and nothing that hands out the key. Both
 * are routes, because both of them are answers to somebody outside, and the key one is a
 * document rather than a value: a caller in this process holds the `KeyObject` already.
 */
export type Signatures = Component & {
  /**
   * Signs `claims` and answers with one compact JWS: `header.payload.signature`, base64url,
   * one URL-safe string.
   *
   * `typ` is the caller's, and nothing is reserved — not even the Decision label
   * (ADR-0042). It goes into the **protected header**, so it is covered by the signature and
   * swapping it invalidates the artifact, which is what keeps a receipt from being presented
   * as a Decision.
   *
   * Asynchronous because `jose` is, and the only side effect is the log line: this part
   * stores nothing, so nothing anywhere records that this was called.
   */
  sign(typ: string, claims: SignedClaims): Promise<string>;

  /**
   * **Does nothing.** Written out here so that it is read rather than discovered.
   *
   * There is no pool, no timer and no connection: the key was handed over at construction and
   * the route went on the server there too (ADR-0032). This part is in the Gateway's record
   * for its membership and for the position that comes with it (ADR-0037).
   */
  start(): Promise<void>;

  /**
   * **Does nothing**, for the reason `start` does not.
   *
   * Stopping the Gateway is nevertheless what stops all signing, which is the point of the
   * key living here rather than inside the Agent Container: a leaked key signs forever and
   * there is nothing to revoke, while a key held by a process that is not running signs
   * nothing (ADR-0041).
   */
  stop(): Promise<void>;
};

export function createSignatures(options: SignaturesOptions): Signatures {
  const log = options.logger ?? defaultLogger();

  // The public half, derived once and here rather than per request. `createPublicKey` on a
  // private `KeyObject` is what drops the private scalar, and it is the first of the two
  // things standing between a wrong argument and `d` being served from an unauthenticated
  // route; the second is the response schema, which is a positive list of public members
  // (ADR-0042).
  const publicKey = createPublicKey(options.signingKey).export({ format: "jwk" });
  const alg = options.signingAlg ?? algorithmFor(publicKey);

  // A JWK **Set** even with one key, because that is RFC 7517's own container and it means a
  // client points its remote-key-set helper at the URL with no glue code. A bare JWK needs
  // hand-parsing in every language (ADR-0042).
  const keySet: KeySet = { keys: [publicKey] };

  // The one act of wiring, here so that an Operator's entry point does none of it (ADR-0032).
  // Not awaited: Fastify defers a plugin until the server is ready, so this is a registration
  // made at construction and loaded at `listen`.
  options.publicServer.fastify.register(publicSignatureRoutes(keySet));

  return {
    async sign(typ, claims) {
      const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
        .setProtectedHeader({ alg, typ })
        .sign(options.signingKey);

      // The whole of the record that this happened, and the statement is not in it: a log
      // aggregator holding every Statement the agent ever signed would be the shadow copy
      // ADR-0042 declines to keep. The digest is enough to match an artifact somebody
      // presents against a line in the log, which is what the trail is for.
      log.info(
        { typ, statementSha256: createHash("sha256").update(claims.statement).digest("hex") },
        "signed a Statement",
      );
      return jws;
    },

    // The two no-ops, whose reason is on the type above: membership in the Gateway's record,
    // and the position that comes with it (ADR-0037).
    start: async () => {},
    stop: async () => {},
  };
}

/**
 * The `alg` the header declares, read off the key's own JWK export.
 *
 * **One entry, and deliberately not the table.** Every key type but RSA determines its `alg`,
 * and RSA is ambiguous between six of them, so the derivation across the rest and the refusal
 * an ambiguous key earns are a piece of work with a shape of their own (ADR-0042). What is
 * here is Ed25519, which is the identity ADR-0041 describes.
 *
 * Any other key gets a **string that is deliberately not an algorithm**: its own curve or key
 * type, which is not a JOSE `alg`, so `jose` refuses the first signing with its own message
 * rather than this function inventing a worse one. `jose`'s header type requires the parameter,
 * so there is a value here whatever happens, and the one value that must never be it is `none`
 * — RFC 7518's own name for an **unsecured** JWS, and the last string that should reach a
 * header of ours.
 *
 * From the **JWK export** and not from `asymmetricKeyDetails`, which is the one detail that is
 * still a bug written the other way round: the latter gives OpenSSL's curve names,
 * `prime256v1` and `secp384r1`, where the JWK gives JOSE's own, `P-256` and `P-384`. The JWK
 * is already the vocabulary the header needs and the vocabulary `jose` is handed.
 */
function algorithmFor(publicKey: JsonWebKey): string {
  if (publicKey.crv === "Ed25519") return "EdDSA";
  // `kty` is on every JWK Node exports, so the last branch is unreachable and is a poison
  // value rather than a fallback: it names the situation instead of naming an algorithm.
  return publicKey.crv ?? publicKey.kty ?? "no algorithm was derived from this key";
}
