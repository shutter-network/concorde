/**
 * Signatures: the part of the Gateway that holds the Shared Agent's signing identity.
 *
 * Constructed like every other part — one call, an ordinary object back, and nothing to
 * register it with. It wires itself the way every part does, registering a route group on each
 * of the two servers it is handed (ADR-0032): the signing on the Agent server, the lazy check
 * and the public key on the Public server.
 *
 * It is the **first part of the framework with no storage at all**: no schema, no tables and
 * no `/schema` subpath, so there is no Db argument either
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
 *    `BASE_DIR_HOST` in the reference deployment, and ADR-0016's instinct applied to a secret. A
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
   * (ADR-0042). The table is `algorithmForCurve` at the foot of this file, and it is short:
   * `EdDSA` for an Ed25519 key, and `ES256`, `ES384` or `ES512` for an EC key on P-256, P-384
   * or P-521.
   *
   * **Every other key is refused at construction**, in a sentence naming what to pass rather
   * than in a crypto error code. Three kinds reach that: an RSA key, for which six algorithms
   * are valid and nothing in the key says which was meant; an `rsa-pss` key, which cannot be
   * exported as a JWK at all and which `exportedJwk` refuses before this option is even read;
   * and any other curve, Ed448 and secp256k1 included.
   *
   * Given, it is passed to `jose` unexamined: there is no key/alg compatibility check of
   * ours, because there is one of the library's and a second would be a second opinion.
   * That is also the one refusal that is **not** at construction, because `jose`'s check is
   * asynchronous and construction is not: an algorithm this key cannot perform is refused at
   * the first signing, in the library's own words.
   */
  readonly signingAlg?: string;
  /**
   * The Agent server, where the Shared Agent signs, at **`POST /sign`**.
   *
   * Required, and it is the reason the key lives in this process rather than in the Agent
   * Container: signing is a route the agent calls and never a key it holds, so a compromise of
   * the container mints nothing once the Gateway is stopped (ADR-0041). Signatures the agent
   * cannot reach signs nothing but Decisions, which is broken rather than smaller.
   *
   * Structural, and asks for nothing but the Fastify instance, for the purely technical reason
   * every other part's server option is — `FastifyInstance` has five generic parameters — so
   * what satisfies it is what `serverComponent` returns.
   */
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
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
  /**
   * Where `POST /verify`'s authentication comes from: the User Manager's own hook, taken as
   * one option on that route and neither wrapped nor re-implemented, so this part
   * authenticates nobody and its one refusal is the Manager's single 401 (ADR-0030).
   *
   * **The hook and not a `Users`**, which is the one option here shaped differently from
   * Decisions' and is worth a sentence. This part stores nothing and reads no User: it needs
   * `requireUser` and there is no second thing it could ever want off the Manager, so asking
   * for the whole object would be asking for a Db-backed part in order to use a function.
   * What it costs is that the assembly, not the type, is what makes this the *real* Manager's
   * hook — which is why `gateway.test.ts` is where the 401 on this route is proven to
   * be the same 401 the routes under `/auth` answer.
   */
  readonly users: {
    readonly requireUser: preHandlerAsyncHookHandler;
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
   * the routes went on the two servers there too (ADR-0032). This part is in the Gateway's
   * record for its membership and for the position that comes with it (ADR-0037).
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
  const publicKey = createPublicKey(options.signingKey);
  const publicJwk = exportedJwk(publicKey);
  const alg = options.signingAlg ?? algorithmFor(publicJwk);

  // A JWK **Set** even with one key, because that is RFC 7517's own container and it means a
  // client points its remote-key-set helper at the URL with no glue code. A bare JWK needs
  // hand-parsing in every language (ADR-0042).
  const keySet: KeySet = { keys: [publicJwk] };

  /**
   * Signs `claims` under `typ`, and is the whole of what this part does.
   *
   * Named here rather than written into the object below because the route registered on the
   * Agent server needs it before that object exists, and the two must be one function: an
   * artifact minted over HTTP and one minted in process by Decisions differ in nothing, which
   * is what makes "the agent may ask for the Decision label" a statement about authority
   * rather than about two code paths.
   */
  const signStatement = async (typ: string, claims: SignedClaims): Promise<string> => {
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
  };

  /**
   * The lazy check behind `POST /verify`: is this string an artifact of ours, and what does it
   * say if it is.
   *
   * **The library's verification and not one of ours**, for the reason the library does the
   * signing: a wrong segment count, malformed base64url and an unparseable header all arrive
   * from a caller, and all three are defensive code `jose` has already written (ADR-0042). The
   * `algorithms` list is the derived `alg` and nothing else, so an artifact naming another one
   * is refused by the library rather than reaching a primitive.
   *
   * Every failure is one `false`, and the `catch` is deliberately not narrowed to `jose`'s own
   * error classes: enumerating them here would be a second copy of the library's error set,
   * going stale the day it grows one, and there is nothing this function could usefully do
   * differently between them. What reaches it is a string somebody posted, and the honest
   * answer to every unacceptable string is the same answer.
   */
  const verifyArtifact = async (jws: string): Promise<Verdict> => {
    try {
      const checked = await compactVerify(jws, publicKey, { algorithms: [alg] });
      return {
        verified: true,
        header: checked.protectedHeader,
        // Parsed inside the `try` on purpose, and it is the one place a `false` would mean
        // something other than "not ours". Everything this identity signs is `JSON.stringify`
        // of an object, so a verified payload parses and the case is unreachable; were it ever
        // reached, a wrong answer said safely beats an uncaught throw becoming a 500 on a route
        // whose whole job is to answer about a caller's string.
        payload: JSON.parse(new TextDecoder().decode(checked.payload)),
      };
    } catch {
      return { verified: false };
    }
  };

  // The two acts of wiring, here so that an Operator's entry point does none of them
  // (ADR-0032). Not awaited: Fastify defers a plugin until the server is ready, so these are
  // registrations made at construction and loaded at `listen`.
  options.agentServer.fastify.register(agentSignatureRoutes({ sign: signStatement }));
  options.publicServer.fastify.register(
    // The Manager's own hook, passed through and not wrapped: this part authenticates nobody
    // (ADR-0030).
    publicSignatureRoutes(keySet, { verify: verifyArtifact }, options.users.requireUser),
  );

  return {
    sign: signStatement,

    // The two no-ops, whose reason is on the type above: membership in the Gateway's record,
    // and the position that comes with it (ADR-0037).
    start: async () => {},
    stop: async () => {},
  };
}

/**
 * The public JWK, or a refusal that reads like a sentence instead of a crypto error code.
 *
 * The export is what every other thing here is built on. The key set *is* it and the algorithm
 * is derived from it, so a key that cannot be exported is a key this part cannot be
 * constructed around at all, whatever `signingAlg` says.
 *
 * **`rsa-pss` is the key that reaches this**, and it reaches it from inside Node rather than
 * from any check of ours: the export throws `ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE`, whose
 * message is `Unsupported JWK Key Type.` and which names neither the key nor anything to do
 * about it. Caught rather than predicted, because "which key types can Node export" is Node's
 * list and a copy of it here would be a copy going stale.
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
 * across key types (`OKP` has the Edwards and Montgomery curves, `EC` the NIST ones), so the
 * pair would be two lookups where the curve is already the answer. `kty` is read for the one
 * key type that has no curve at all, which is RSA, and that branch is a refusal.
 *
 * **Ed448 and secp256k1 are absent on purpose**, and their absence is the one place this table
 * is narrower than JOSE. Both determine an algorithm perfectly well, `EdDSA` and `ES256K`, and
 * **`jose`'s own algorithm table can perform neither**: its `EdDSA` entry names `Ed25519` and
 * nothing else, so an Ed448 key is refused with `Invalid key type` however the header reads,
 * and `ES256K` is not in that table at all. It is the library and not the platform that stops
 * them, Node's WebCrypto having grown an experimental Ed448 that `jose` never asks it for.
 * Deriving them would start a Gateway whose very first signing throws, having named an
 * algorithm in a header nobody could ever obtain, so a row that cannot produce an artifact is
 * not a derivation and these two are refused at construction with that reason instead. The
 * cost is that this table now knows something about the library as well as about JOSE, and it
 * is recorded rather than guarded against: the day `jose` grows either row, this is what has
 * to be told.
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
 * From the **JWK export** and not from `asymmetricKeyDetails`, which is the one detail that is
 * still a bug written the other way round: the latter gives OpenSSL's curve names,
 * `prime256v1` and `secp384r1`, where the JWK gives JOSE's own, `P-256` and `P-384`. The JWK
 * is already the vocabulary the header needs and the vocabulary `jose` is handed.
 *
 * There is no standard derivation to lean on. JWK has an optional `alg` member (RFC 7517
 * §4.4) and Node leaves it absent for every key type, so this table is ours (ADR-0042).
 *
 * **An RSA key is refused rather than guessed at.** `RS256`, `RS384`, `RS512`, `PS256`,
 * `PS384` and `PS512` are all valid for one RSA key and nothing in the key distinguishes
 * them, so the choice is the Operator's and the message names it. Everything else that is not
 * in the table above is refused too, which is what makes a wrong key a sentence at startup
 * rather than an artifact nobody can verify weeks later.
 *
 * What is **not** here, and must not arrive, is an `alg` → primitive mapping or a key/alg
 * compatibility check: both are `jose`'s, and a second one that disagreed with the library's
 * would be worse than none (ADR-0042). Getting this table wrong is safe in the way that
 * matters: the library refuses to sign rather than emitting something unverifiable.
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
