import { createHash, createPublicKey, type JsonWebKey, type KeyObject } from "node:crypto";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { CompactSign, compactVerify } from "jose";
import type { Component } from "../gateway/components.ts";
import { defaultLogger, type Logger } from "../logging/logging.ts";
import {
  agentSignatureRoutes,
  type KeySet,
  publicSignatureRoutes,
  type Verdict,
} from "./routes.ts";

export type SignedClaims = {
  readonly statement: string;
} & Readonly<Record<string, unknown>>;

export type SignaturesOptions = {
  /** Private key retained in the gateway. Must support JWK export; restricted `rsa-pss` keys do not. */
  readonly signingKey: KeyObject;
  /** Derived for Ed25519 and P-256/P-384/P-521. RSA requires an explicit JOSE algorithm. */
  readonly signingAlg?: string;
  readonly agentServer: {
    readonly fastify: FastifyInstance;
  };
  readonly publicServer: {
    readonly fastify: FastifyInstance;
    readonly requireUser: preHandlerAsyncHookHandler;
  };
  readonly logger?: Logger;
};

export type Signatures = Component & {
  /** Returns a compact JWS without storing it. `typ` is a caller-defined protected header. */
  sign(typ: string, claims: SignedClaims): Promise<string>;

  start(): Promise<void>;

  stop(): Promise<void>;
};

export function createSignatures(options: SignaturesOptions): Signatures {
  const log = options.logger ?? defaultLogger();

  const publicKey = createPublicKey(options.signingKey);
  const publicJwk = exportedJwk(publicKey);
  const alg = options.signingAlg ?? algorithmFor(publicJwk);

  const keySet: KeySet = { keys: [publicJwk] };

  const signStatement = async (typ: string, claims: SignedClaims): Promise<string> => {
    const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
      .setProtectedHeader({ alg, typ })
      .sign(options.signingKey);

    log.info(
      { typ, statementSha256: createHash("sha256").update(claims.statement).digest("hex") },
      "signed a Statement",
    );
    return jws;
  };

  const verifyArtifact = async (jws: string): Promise<Verdict> => {
    try {
      const checked = await compactVerify(jws, publicKey, { algorithms: [alg] });
      return {
        verified: true,
        header: checked.protectedHeader,
        payload: JSON.parse(new TextDecoder().decode(checked.payload)),
      };
    } catch {
      return { verified: false };
    }
  };

  options.agentServer.fastify.register(agentSignatureRoutes({ sign: signStatement }));
  options.publicServer.fastify.register(
    publicSignatureRoutes(keySet, { verify: verifyArtifact }, options.publicServer.requireUser),
  );

  return {
    sign: signStatement,

    start: async () => {},
    stop: async () => {},
  };
}

function exportedJwk(publicKey: KeyObject): JsonWebKey {
  try {
    return publicKey.export({ format: "jwk" });
  } catch (error) {
    throw new Error(
      `the signing key is ${publicKey.asymmetricKeyType} and cannot be exported as a JWK, so this shared agent would have no public key to serve and no algorithm to derive: ${reason(error)}. An rsa-pss key is what reaches this: its PSS parameters are part of its algorithm identifier and a JWK has nowhere to put them, and no re-encoding of the same key gets round it. Supply a plain RSA key and pass signingAlg "PS256": PSS is the padding, not the key.`,
      { cause: error },
    );
  }
}

const algorithmForCurve: Readonly<Record<string, string>> = {
  Ed25519: "EdDSA",
  "P-256": "ES256",
  "P-384": "ES384",
  "P-521": "ES512",
};

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
