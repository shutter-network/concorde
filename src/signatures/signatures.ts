/**
 * Signatures: the Component that holds the Shared Agent's signing identity.
 *
 * One call builds it. It registers a route group on each of the two servers it is handed. The
 * signing goes on the Agent server, and the lazy check and the public key on the Public one. Both
 * its methods do nothing. It is in the Gateway's record for its membership, and for the position
 * that comes with it.
 *
 * Three things about it are decisions rather than omissions. The key is a `crypto.KeyObject`, and
 * this framework parses nothing: no PEM handling, no environment reading, no file paths. A
 * `KeyObject` also keeps its material in the OpenSSL layer. So it does not stringify into a log
 * line by accident. The public half is derived rather than taken as a second option. A second
 * option would be a second answer to the question of which key this is. And the framework never
 * generates a keypair, so no key means construction throws.
 *
 * `jose` builds the artifact, and this is the only module that imports it. What that buys is the
 * `alg` to primitive mapping and the key/alg compatibility check. Those were the most dangerous
 * code in the design. Do not reintroduce either. A second mapping that disagrees with the library's
 * is worse than none. A self-consistent implementation cannot see its own bug.
 *
 * Signing is logged and never stored. One line per signing at info level. It carries the `typ` and
 * a SHA-256 digest of the Statement, not the Statement. So the trail is a trail and not a shadow
 * copy of every private thing the agent ever signed. The regression underneath is recorded rather
 * than solved: an injected agent mints unlimited Signed Statements with no row anywhere.
 */

import { createHash, createPublicKey, type JsonWebKey, type KeyObject } from "node:crypto";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { CompactSign, compactVerify } from "jose";
import type { Component } from "../components.ts";
import { defaultLogger, type Logger } from "../logging.ts";
import {
  agentSignatureRoutes,
  type KeySet,
  publicSignatureRoutes,
  type Verdict,
} from "./routes.ts";

/**
 * What a signature commits to: the Statement, and whatever else the caller is binding to it.
 *
 * `statement` is required and named, because it is the domain term and the one claim this Component
 * reads for itself. It digests that claim into the log line rather than writing it there.
 *
 * Everything else is the caller's. Decisions binds a `seq` and a `createdAt` beside it. The object
 * it hands over is the object that gets serialized, in the order its keys were written. That is the
 * whole reason this takes an object. The payload is signed as the exact bytes emitted. So a caller
 * that builds the claims is a caller that decides the bytes.
 */
export type SignedClaims = {
  readonly statement: string;
} & Readonly<Record<string, unknown>>;

/** Everything `createSignatures` needs: the signing key, both servers, and the Manager's hook. */
export type SignaturesOptions = {
  /**
   * The Shared Agent's private key, as a `crypto.KeyObject`, and the whole of its identity.
   *
   * Required, and the framework will not generate one. Copying this key copies the agent. There is
   * no second name for it anywhere. No key identifier sits on any record, and nothing identifies
   * the deployment inside what is signed.
   */
  readonly signingKey: KeyObject;
  /**
   * The JOSE algorithm the header declares, when the key does not settle it by itself.
   *
   * Optional. Left out, it is derived from the key's JWK export. That export speaks JOSE's own
   * curve names, where `asymmetricKeyDetails` speaks OpenSSL's. The table is short. `EdDSA` for an
   * Ed25519 key, and `ES256`, `ES384` or `ES512` for an EC key on P-256, P-384 or P-521.
   *
   * Every other key is refused at construction, in a sentence naming what to pass. Three kinds
   * reach that. An RSA key, for which six algorithms are valid and nothing says which was meant. An
   * `rsa-pss` key, which cannot be exported as a JWK at all. And any other curve, Ed448 and
   * secp256k1 included.
   *
   * Given, it is passed to `jose` unexamined. There is no key/alg compatibility check of ours,
   * because there is one of the library's. That refusal is therefore not at construction. `jose`'s
   * check is asynchronous, so an algorithm this key cannot perform is refused at the first signing.
   */
  readonly signingAlg?: string;
  /**
   * The Agent server, where the Shared Agent signs, at `POST /sign`.
   *
   * Required, and it is why the key lives in this process rather than in the Agent Container.
   * Signing is a route the agent calls and never a key it holds. So a compromise of the container
   * mints nothing once the Gateway is stopped.
   *
   * Structural, and asks for nothing but the Fastify instance, so what satisfies it is what
   * `serverComponent` returns.
   */
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
  /**
   * The Public server, where the key set is served at `/jwks.json`.
   *
   * Required, and unauthenticated, a public key being public. It is what makes verification
   * possible for the party this identity exists for. That party does not trust the Operator, and
   * would learn nothing from the Gateway's own opinion.
   *
   * Structural, and asks for nothing but the Fastify instance, so what satisfies it is what
   * `serverComponent` returns.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
  };
  /**
   * Where `POST /verify`'s authentication comes from: the User Manager's own hook.
   *
   * Taken as one option on that route, and neither wrapped nor re-implemented. So this Component
   * authenticates nobody, and its one refusal is the Manager's single 401.
   *
   * The hook and not a `Users`, which is the one option here shaped differently from Decisions'.
   * This Component reads no User and there is no second thing it could want off the Manager. What
   * that costs is that the assembly, rather than the type, makes this the real Manager's hook. That
   * is why `gateway.test.ts` proves the 401 is the same one.
   */
  readonly users: {
    readonly requireUser: preHandlerAsyncHookHandler;
  };
  /** Defaults to a `pino` instance on stdout, and is what the signing line is written to. */
  readonly logger?: Logger;
};

/**
 * What the constructor answers with: the one thing trusted code needs and no request can express.
 *
 * `sign` is an in-process call and never an HTTP request. Decisions holds this object and calls the
 * method. A Decision published inside a transaction cannot go out over a socket and back. A Gateway
 * that signed by calling itself would take a route as a dependency of its own write path.
 *
 * There is nothing here that verifies and nothing that hands out the key. Both are routes, because
 * both are answers to somebody outside, and a caller in this process holds the `KeyObject` already.
 */
export type Signatures = Component & {
  /**
   * Signs `claims` and answers with one compact JWS: `header.payload.signature`, base64url.
   *
   * `typ` is the caller's, and nothing is reserved, not even the Decision label. It goes into the
   * protected header, so the signature covers it and swapping it invalidates the artifact. That is
   * what keeps a receipt from being presented as a Decision.
   *
   * Asynchronous because `jose` is. The only side effect is the log line: this Component stores
   * nothing, so nothing anywhere records that this was called.
   *
   * @param typ What kind of thing the artifact is, up to 128 characters.
   * @param claims The Statement, and whatever else the caller binds to it. Key order is byte order.
   * @returns One URL-safe string, verifiable against `GET /jwks.json`.
   */
  sign(typ: string, claims: SignedClaims): Promise<string>;

  /**
   * Does nothing. There is nothing here to start.
   *
   * There is no pool, no timer and no connection. The key was handed over at construction, and the
   * routes went on the two servers there too.
   */
  start(): Promise<void>;

  /**
   * Does nothing, for the reason `start` does not.
   *
   * Stopping the Gateway is nevertheless what stops all signing. That is the point of the key
   * living here rather than inside the Agent Container. A leaked key signs forever and there is
   * nothing to revoke. A key held by a process that is not running signs nothing.
   */
  stop(): Promise<void>;
};

/**
 * Builds Signatures, derives the public key, and registers its three routes.
 *
 * Nothing here connects or listens. Put the result in the Gateway's record under a key of your own,
 * ahead of the Signal Worker. Construct it before Decisions.
 *
 * @throws If the key cannot be exported as a JWK, which is what an `rsa-pss` key does.
 * @throws If the key is RSA, or on a curve this framework derives no algorithm for, and no
 *   `signingAlg` was passed.
 *
 * @example
 * Built in `extend`, and then used from the Operator's own trusted code.
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
 *         // An Ed25519 or EC key needs no `signingAlg`. An RSA key does.
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
 * const jws = await gateway.components.signatures.sign("my-receipt+jws", {
 *   statement: "paid in full",
 *   invoice: "2026-0043",
 * });
 * console.log(jws);
 * ```
 */
export function createSignatures(options: SignaturesOptions): Signatures {
  const log = options.logger ?? defaultLogger();

  // The public half, derived once and here rather than per request. `createPublicKey` on a private
  // `KeyObject` is what drops the private scalar. It is the first of the two things standing between
  // a wrong argument and `d` being served from an unauthenticated route. The second is the response
  // schema, which is a positive list of public members.
  const publicKey = createPublicKey(options.signingKey);
  const publicJwk = exportedJwk(publicKey);
  const alg = options.signingAlg ?? algorithmFor(publicJwk);

  // A JWK Set even with one key, because that is RFC 7517's own container. A client points its
  // remote-key-set helper at the URL with no glue code, where a bare JWK needs hand-parsing in
  // every language.
  const keySet: KeySet = { keys: [publicJwk] };

  /**
   * Signs `claims` under `typ`, and is the whole of what this Component does.
   *
   * Named here rather than written into the object below. The route registered on the Agent server
   * needs it before that object exists. The two must be one function. An artifact minted over HTTP
   * and one minted in process by Decisions differ in nothing.
   */
  const signStatement = async (typ: string, claims: SignedClaims): Promise<string> => {
    const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
      .setProtectedHeader({ alg, typ })
      .sign(options.signingKey);

    // The whole of the record that this happened, and the Statement is not in it. A log aggregator
    // holding every Statement the agent ever signed would be a shadow copy. The digest is enough to
    // match an artifact somebody presents against a line in the log.
    log.info(
      { typ, statementSha256: createHash("sha256").update(claims.statement).digest("hex") },
      "signed a Statement",
    );
    return jws;
  };

  /**
   * The lazy check behind `POST /verify`: is this string an artifact of ours, and what does it say.
   *
   * The library's verification and not one of ours, for the reason the library does the signing. A
   * wrong segment count, malformed base64url and an unparseable header all arrive from a caller.
   * All three are defensive code `jose` has already written. The `algorithms` list is the derived
   * `alg` and nothing else.
   *
   * Every failure is one `false`, and the `catch` is deliberately not narrowed to `jose`'s own
   * error classes. Enumerating them here would be a second copy of the library's error set. And
   * there is nothing this function could usefully do differently between them.
   */
  const verifyArtifact = async (jws: string): Promise<Verdict> => {
    try {
      const checked = await compactVerify(jws, publicKey, { algorithms: [alg] });
      return {
        verified: true,
        header: checked.protectedHeader,
        // Parsed inside the `try` on purpose, and it is the one place a `false` would mean
        // something other than "not ours". Everything this identity signs is `JSON.stringify` of an
        // object, so a verified payload parses and the case is unreachable. Were it ever reached, a
        // wrong answer said safely beats an uncaught throw becoming a 500.
        payload: JSON.parse(new TextDecoder().decode(checked.payload)),
      };
    } catch {
      return { verified: false };
    }
  };

  // The two acts of wiring, here so that an Operator's entry point does neither. Not awaited:
  // Fastify defers a plugin until the server is ready, so these are registrations made at
  // construction and loaded at `listen`.
  options.agentServer.fastify.register(agentSignatureRoutes({ sign: signStatement }));
  options.publicServer.fastify.register(
    // The Manager's own hook, passed through and not wrapped. This Component authenticates nobody.
    publicSignatureRoutes(keySet, { verify: verifyArtifact }, options.users.requireUser),
  );

  return {
    sign: signStatement,

    // The two no-ops, whose reason is on the type above.
    start: async () => {},
    stop: async () => {},
  };
}

/**
 * The public JWK, or a refusal that reads like a sentence instead of a crypto error code.
 *
 * The export is what everything else here is built on. The key set is it, and the algorithm is
 * derived from it. So a key that cannot be exported is a key this Component cannot be constructed
 * around. That holds whatever `signingAlg` says.
 *
 * `rsa-pss` is the key that reaches this. It reaches it from inside Node rather than from any check
 * of ours. The export throws `ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE`, whose message names neither the
 * key nor anything to do about it. Caught rather than predicted, because "which key types can Node
 * export" is Node's list.
 */
function exportedJwk(publicKey: KeyObject): JsonWebKey {
  try {
    return publicKey.export({ format: "jwk" });
  } catch (error) {
    throw new Error(
      `the signing key is ${publicKey.asymmetricKeyType} and cannot be exported as a JWK, so this Shared Agent would have no public key to serve and no algorithm to derive: ${reason(error)}. An rsa-pss key is what reaches this: its PSS parameters are part of its algorithm identifier and a JWK has nowhere to put them, and no re-encoding of the same key gets round it. Supply a plain RSA key and pass signingAlg "PS256": PSS is the padding, not the key.`,
      { cause: error },
    );
  }
}

/**
 * What a curve means, which is the whole of the derivation for every key that has one.
 *
 * Keyed on `crv` alone and not on the `kty`/`crv` pair, because JOSE's curve names are unique
 * across key types. `kty` is read for the one key type that has no curve at all, which is RSA. That
 * branch is a refusal.
 *
 * Ed448 and secp256k1 are absent on purpose, and their absence is the one place this table is
 * narrower than JOSE. Both determine an algorithm perfectly well, `EdDSA` and `ES256K`. But `jose`
 * can perform neither. Its `EdDSA` entry names `Ed25519` and nothing else, and `ES256K` is not in
 * its table at all. Deriving them would start a Gateway whose very first signing throws.
 *
 * The cost is that this table now knows something about the library as well as about JOSE. The day
 * `jose` grows either row, this is what has to be told.
 */
const algorithmForCurve: Readonly<Record<string, string>> = {
  Ed25519: "EdDSA",
  "P-256": "ES256",
  "P-384": "ES384",
  "P-521": "ES512",
};

/**
 * The `alg` the header declares, read off the key's own JWK export.
 *
 * From the JWK export and not from `asymmetricKeyDetails`. The latter gives OpenSSL's curve names,
 * `prime256v1` and `secp384r1`, where the JWK gives JOSE's own, `P-256` and `P-384`. The JWK is
 * already the vocabulary the header needs and the vocabulary `jose` is handed.
 *
 * There is no standard derivation to lean on. JWK has an optional `alg` member and Node leaves it
 * absent for every key type, so this table is ours. An RSA key is refused rather than guessed at.
 * Six algorithms are valid for one RSA key, and nothing in the key distinguishes them. Everything
 * else outside the table is refused too, which makes a wrong key a sentence at startup.
 *
 * What must not arrive here is an `alg` to primitive mapping or a key/alg compatibility check. Both
 * are `jose`'s. Getting this table wrong is safe in the way that matters. The library refuses to
 * sign rather than emitting something unverifiable.
 *
 * @throws If no algorithm can be derived, in a message naming what to pass instead.
 */
function algorithmFor(publicJwk: JsonWebKey): string {
  if (publicJwk.kty === "RSA") {
    throw new Error(
      'the signing key is RSA, which does not settle its own algorithm: RS256, RS384, RS512, PS256, PS384 and PS512 are all valid for it, and neither the key nor its JWK export says which was meant. Pass signingAlg: "PS256" unless a verifier you have to satisfy requires PKCS#1 v1.5, in which case "RS256".',
    );
  }

  const derived = publicJwk.crv === undefined ? undefined : algorithmForCurve[publicJwk.crv];
  if (derived === undefined) {
    throw new Error(
      `no algorithm can be derived from the signing key, whose JWK export is ${described(publicJwk)}. What is derived is EdDSA for an OKP key on Ed25519, and ES256, ES384 or ES512 for an EC key on P-256, P-384 or P-521. Pass signingAlg if this key signs with something else, though not for an Ed448 or a secp256k1 key: JOSE calls their algorithms EdDSA and ES256K, and jose can perform neither, so naming one here buys a Gateway that starts and cannot sign.`,
    );
  }
  return derived;
}

/** A key as the two members a refusal can usefully name it by. */
function described(publicJwk: JsonWebKey): string {
  const kty = `kty ${JSON.stringify(publicJwk.kty ?? null)}`;
  return publicJwk.crv === undefined ? kty : `${kty}, crv ${JSON.stringify(publicJwk.crv)}`;
}

/** What a caught throw contributes to a message of ours: its own sentence and nothing else. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
