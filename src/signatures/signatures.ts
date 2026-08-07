/**
 * `jose` owns two things, and this is the only module that imports it: the `alg` to primitive
 * mapping, and the key/alg compatibility check. Both were the most dangerous code in the design.
 * Do not reintroduce either. A second mapping that disagrees with the library's is worse than
 * none, because a self-consistent implementation cannot see its own bug. `algorithmForCurve` below
 * is not that mapping: it answers which `alg` to declare, and `jose` still decides whether the key
 * can perform it.
 *
 * The key is a `KeyObject` and not a PEM string so that its material stays in the OpenSSL layer
 * and cannot stringify into a log line by accident. The public half is derived rather than taken
 * as a second option, because a second option is a second answer to which key this is. The
 * `users` option is the bare hook rather than a `Users`, unlike Decisions': nothing here reads a
 * User, and there is no second thing this could want off the Manager. What that costs is that the
 * assembly rather than the type makes it the real Manager's hook, which is why `gateway.test.ts`
 * proves the 401 is the same one.
 *
 * `algorithmForCurve` is deliberately narrower than JOSE. Ed448 and secp256k1 determine `EdDSA`
 * and `ES256K` perfectly well, and `jose` can perform neither, so deriving them would start a
 * Gateway whose first signing throws. The cost is that the table knows something about the library
 * as well as about the standard: the day `jose` grows either row, this is what has to be told.
 *
 * Signing is logged and never stored, and the regression underneath is recorded rather than
 * solved: an injected agent mints unlimited Signed Statements with no row anywhere.
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
 * What a signature commits to: the Statement, and whatever else the caller binds to it.
 *
 * `statement` is the one member this component reads for itself, and it reads it only to digest it
 * into the log line.
 *
 * The object is serialized as it was written, so the order of its keys is the order of the signed
 * bytes. A caller that builds the claims decides the payload byte for byte.
 */
export type SignedClaims = {
  readonly statement: string;
} & Readonly<Record<string, unknown>>;

export type SignaturesOptions = {
  /**
   * The Shared Agent's private key, and the whole of its identity.
   *
   * The deployment loads it: nothing here parses a PEM, opens a file or generates a keypair, and
   * `createPrivateKey(readFileSync(path))` is the usual spelling. Copying this key copies the
   * agent. Nothing inside a signed artifact names the deployment that made it, so there is no
   * second thing a verifier could hold it against.
   */
  readonly signingKey: KeyObject;
  /**
   * The JOSE algorithm the protected header declares.
   *
   * Derived from the key when absent: `EdDSA` for an Ed25519 key, and `ES256`, `ES384` or `ES512`
   * for an EC key on P-256, P-384 or P-521. Every other key is refused at construction in a
   * sentence naming what to pass. An RSA key is refused because six algorithms are valid for it
   * and nothing in the key says which was meant, an `rsa-pss` key because it exports to no JWK at
   * all, and any other curve including Ed448 and secp256k1.
   *
   * A value given here reaches `jose` unexamined, and the compatibility check is the library's and
   * asynchronous. So an algorithm this key cannot perform is refused at the first `sign` rather
   * than at construction.
   */
  readonly signingAlg?: string;
  /**
   * Where `POST /sign` is registered.
   *
   * The key stays in this process, and the agent reaches it only over that route, so a compromised
   * Agent Container mints nothing once the Gateway is stopped.
   *
   * Structural: anything carrying a Fastify instance satisfies it, including what
   * `serverComponent` returns.
   */
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
  /**
   * Where `POST /verify` and `GET /jwks.json` are registered.
   *
   * `GET /jwks.json` asks for no Token. A public key is public, and the party this identity exists
   * for has nothing to log in with.
   *
   * Structural, on the same terms as `agentServer`.
   */
  readonly publicServer: {
    readonly fastify: FastifyInstance;
  };
  /**
   * Supplies the `requireUser` hook that `POST /verify` runs as one option on the route.
   *
   * Taken and neither wrapped nor re-implemented, so this component authenticates nobody and an
   * unauthenticated check is refused with the same 401 the routes under `/auth` answer.
   */
  readonly users: {
    readonly requireUser: preHandlerAsyncHookHandler;
  };
  /**
   * Defaults to a `pino` instance on stdout.
   *
   * One info line per signing, carrying the `typ` and a SHA-256 digest of the Statement. The
   * Statement itself is never written, so an aggregator collecting these lines holds no copy of
   * what the agent committed to.
   */
  readonly logger?: Logger;
};

/**
 * The signing identity as a Component: one in-process method, and nothing kept.
 *
 * Nothing is stored. No tables, no route that lists what has been signed, and no record anywhere
 * that a signing happened beyond the one log line. The artifact `sign` answers with is the whole
 * of what happened, and losing it means signing again.
 *
 * Verifying and handing out the public key are routes rather than methods here. Both answer
 * somebody outside, and a caller in this process holds the key already.
 *
 * Stopping the Gateway is what stops all signing. The key lives in this process and nothing about
 * it can be revoked, so a key that outlived the process would sign forever.
 *
 * `start` and `stop` do nothing.
 */
export type Signatures = Component & {
  /**
   * Signs `claims` and answers with one compact JWS: `header.payload.signature`, base64url.
   *
   * `typ` goes into the protected header, so the signature covers it and swapping it invalidates
   * the artifact. Nothing is reserved, `saf-decision+jws` included, and the label is this
   * identity's own claim about its artifact rather than a promise about the artifact's shape.
   *
   * A `signingAlg` the key cannot perform is refused here, at the first call, rather than at
   * construction.
   *
   * It stores nothing and numbers nothing. A commitment that has to be citable afterwards is a
   * Decision instead.
   */
  sign(typ: string, claims: SignedClaims): Promise<string>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

/**
 * Builds Signatures, derives the public key, and registers `POST /sign` on the Agent server and
 * `POST /verify` and `GET /jwks.json` on the Public one.
 *
 * @throws If the key exports to no JWK, which is what an `rsa-pss` key does.
 * @throws If no algorithm can be derived from the key and no `signingAlg` was passed.
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

  // Named here rather than written into the returned object, because the route registered below
  // needs it before that object exists. The two must stay one function: an artifact minted over
  // HTTP and one minted in process differ in nothing.
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

  // The library's verification and not one of ours, for the reason the library does the signing. A
  // wrong segment count, malformed base64url and an unparseable header all arrive from a caller,
  // and all three are defensive code `jose` has already written. Every failure is one `false`, and
  // the `catch` is deliberately not narrowed to `jose`'s own error classes: enumerating them would
  // be a second copy of the library's error set, and nothing here could act on the difference.
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

    start: async () => {},
    stop: async () => {},
  };
}

// The export is what everything else here is built on: the key set is it, and the algorithm is
// derived from it, so a key that cannot be exported cannot be built around whatever `signingAlg`
// says. `rsa-pss` is what reaches this, and it reaches it from inside Node rather than from a check
// of ours. Caught rather than predicted, because "which key types can Node export" is Node's list.
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

// Keyed on `crv` alone and not on the `kty`/`crv` pair, because JOSE's curve names are unique
// across key types. `kty` is read below only for the one key type that has no curve, which is RSA,
// and that branch is a refusal. Ed448 and secp256k1 are absent on purpose; see the file header.
const algorithmForCurve: Readonly<Record<string, string>> = {
  Ed25519: "EdDSA",
  "P-256": "ES256",
  "P-384": "ES384",
  "P-521": "ES512",
};

// From the JWK export and not from `asymmetricKeyDetails`: the latter gives OpenSSL's curve names,
// `prime256v1` and `secp384r1`, where the JWK gives JOSE's own, which is already the vocabulary the
// header needs and the vocabulary `jose` is handed. There is no standard derivation to lean on,
// JWK's `alg` member being optional and left absent by Node for every key type, so this table is
// ours. Getting it wrong is safe in the way that matters: the library refuses to sign rather
// than emitting something unverifiable.
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

function described(publicJwk: JsonWebKey): string {
  const kty = `kty ${JSON.stringify(publicJwk.kty ?? null)}`;
  return publicJwk.crv === undefined ? kty : `${kty}, crv ${JSON.stringify(publicJwk.crv)}`;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
