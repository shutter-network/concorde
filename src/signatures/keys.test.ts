import assert from "node:assert/strict";
import {
  constants,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
  verify,
} from "node:crypto";
import { after, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { type Component, type ServerComponent, serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import { fakeAuth } from "../test-support/fake-auth.ts";
import type { UserRecord } from "../users/routes.ts";
import { createSignatures, type Signatures } from "./signatures.ts";

type Server = ServerComponent<FastifyInstance>;

const keys = {
  ed25519: generateKeyPairSync("ed25519").privateKey,
  ed448: generateKeyPairSync("ed448").privateKey,
  p256: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
  p384: generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey,
  p521: generateKeyPairSync("ec", { namedCurve: "P-521" }).privateKey,
  secp256k1: generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey,
  rsa: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
  rsaPss: generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).privateKey,
  x25519: generateKeyPairSync("x25519").privateKey,
} as const;

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const somebody: UserRecord = {
  id: "3f2a1c88-5b41-4d0e-9c72-6a1e4b8d3c05",
  attributes: {},
  createdAt: new Date(0).toISOString(),
};

const statement = "we will ship on Friday";

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const opened: Component[] = [];

after(async () => {
  for (const server of opened) await server.stop();
});

describe("the algorithm it derives from the key", () => {
  for (const { what, key, kty, crv, alg, bytes } of [
    {
      what: "an Ed25519 key",
      key: keys.ed25519,
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      bytes: 64,
    },
    { what: "a P-256 key", key: keys.p256, kty: "EC", crv: "P-256", alg: "ES256", bytes: 64 },
    { what: "a P-384 key", key: keys.p384, kty: "EC", crv: "P-384", alg: "ES384", bytes: 96 },
    { what: "a P-521 key", key: keys.p521, kty: "EC", crv: "P-521", alg: "ES512", bytes: 132 },
  ]) {
    it(`signs with ${alg} for ${what}, and the artifact checks out against the key it serves`, async () => {
      const { signatures, servedKey } = constructedWith(key);

      const jws = await signatures.sign("concorde-decision+jws", { statement });

      assert.deepEqual(headerOf(jws), { alg, typ: "concorde-decision+jws" });
      const served = await servedKey();
      assert.equal(served.kty, kty);
      assert.equal(served.crv, crv);
      assert.equal(signatureBytes(jws), bytes, jws);
      assert.equal(checksUnder(alg, jws, served), true);

      const [header, , signature] = jws.split(".");
      const relabelled = Buffer.from(
        JSON.stringify({ statement: "we will ship on Monday" }),
        "utf8",
      ).toString("base64url");
      assert.equal(checksUnder(alg, `${header}.${relabelled}.${signature}`, served), false);
    });
  }

  it("pins the derived algorithm on the check it does for a User, so an EC artifact is checkable there too", async () => {
    const { signatures, publicServer } = constructedWith(keys.p256);
    const jws = await signatures.sign("concorde-receipt+jws", { statement });

    const answered = await publicServer.fastify.inject({
      method: "POST",
      url: "/verify",
      headers: { authorization: "Bearer whatever this file's hook accepts" },
      payload: { jws },
    });

    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), {
      verified: true,
      header: { alg: "ES256", typ: "concorde-receipt+jws" },
      payload: { statement },
    });
  });
});

describe("the keys it refuses to be constructed with", () => {
  it("refuses an RSA key that came with no algorithm, naming the choice rather than making it", () => {
    assert.throws(
      () => constructedWith(keys.rsa),
      (error: Error) => {
        assert.match(error.message, /signingAlg/);
        assert.match(error.message, /RS256/);
        assert.match(error.message, /PS256/);
        return true;
      },
    );
  });

  for (const alg of ["PS256", "RS256"]) {
    it(`signs with an RSA key once it is told ${alg}`, async () => {
      const { signatures, servedKey } = constructedWith(keys.rsa, alg);

      const jws = await signatures.sign("concorde-decision+jws", { statement });

      assert.deepEqual(headerOf(jws), { alg, typ: "concorde-decision+jws" });
      const served = await servedKey();
      assert.equal(served.kty, "RSA");
      assert.equal(typeof served.n, "string");
      assert.equal(typeof served.e, "string");
      assert.equal(checksUnder(alg, jws, served), true);
    });
  }

  it("refuses an rsa-pss key in a sentence, not with the crypto error code the export throws", () => {
    assert.throws(
      () => constructedWith(keys.rsaPss),
      (error: Error) => {
        assert.match(error.message, /rsa-pss/);
        assert.match(error.message, /signingAlg "PS256"/);
        assert.match(error.message, /Unsupported JWK Key Type/);
        assert.equal(
          (error.cause as NodeJS.ErrnoException)?.code,
          "ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE",
        );
        return true;
      },
    );
  });

  it("refuses an rsa-pss key even when it was told the algorithm", () => {
    assert.throws(() => constructedWith(keys.rsaPss, "PS256"), /cannot be exported as a JWK/);
  });

  for (const [what, key] of [
    ["an Ed448 key", keys.ed448],
    ["a secp256k1 key", keys.secp256k1],
    ["an X25519 key", keys.x25519],
  ] as const) {
    it(`refuses ${what}, naming what it read off the key`, () => {
      assert.throws(
        () => constructedWith(key),
        (error: Error) => {
          assert.match(error.message, /no algorithm can be derived/);
          const { crv } = createPublicKey(key).export({ format: "jwk" });
          assert.match(error.message, new RegExp(String(crv)));
          assert.match(error.message, /signingAlg/);
          return true;
        },
      );
    });
  }
});

describe("the refusal that is not the constructor's", () => {
  for (const [what, key, signingAlg] of [
    ["an algorithm this key cannot perform", keys.ed25519, "ES256"],
    ["EdDSA for an Ed448 key, which construction would have refused", keys.ed448, "EdDSA"],
    ["a string that is no algorithm at all", keys.ed25519, "P-256"],
  ] as const) {
    it(`constructs with ${what}, and refuses at the first signing instead`, async () => {
      const { signatures } = constructedWith(key, signingAlg);

      await assert.rejects(() => signatures.sign("concorde-decision+jws", { statement }));
    });
  }
});

function constructedWith(
  signingKey: KeyObject,
  signingAlg?: string,
): { signatures: Signatures; publicServer: Server; servedKey: () => Promise<JsonWebKey> } {
  const agentServer = serverComponent(Fastify(), nowhere);
  const publicServer = serverComponent(Fastify(), nowhere);
  publicServer.registerAuth(
    fakeAuth("Bearer", (request) =>
      request.headers.authorization === undefined
        ? { kind: "absent" }
        : { kind: "authenticated", user: somebody },
    ),
  );
  opened.push(agentServer, publicServer);

  const signatures = createSignatures({
    signingKey,
    ...(signingAlg === undefined ? {} : { signingAlg }),
    agentServer,
    publicServer,
    logger: silent,
  });

  return { signatures, publicServer, servedKey: () => oneServedKey(publicServer) };
}

async function oneServedKey(publicServer: Server): Promise<JsonWebKey> {
  const answered = await publicServer.fastify.inject({ method: "GET", url: "/jwks.json" });
  assert.equal(answered.statusCode, 200, answered.body);
  const [key] = answered.json<{ keys: JsonWebKey[] }>().keys;
  assert.ok(key !== undefined, answered.body);
  return key;
}

function headerOf(jws: string): unknown {
  const [header] = jws.split(".");
  return JSON.parse(Buffer.from(String(header), "base64url").toString("utf8"));
}

function signatureBytes(jws: string): number {
  const [, , signature] = jws.split(".");
  return Buffer.from(String(signature), "base64url").length;
}

function checksUnder(alg: string, jws: string, served: JsonWebKey): boolean {
  const [header, payload, signature] = jws.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return false;

  const input = Buffer.from(`${header}.${payload}`, "utf8");
  const sig = Buffer.from(signature, "base64url");
  const key = createPublicKey({ key: served, format: "jwk" });

  if (alg === "EdDSA") return verify(null, input, key, sig);

  const digest = `sha${alg.slice(2)}`;
  if (alg.startsWith("ES")) {
    return verify(digest, input, { key, dsaEncoding: "ieee-p1363" }, sig);
  }
  if (alg.startsWith("PS")) {
    return verify(
      digest,
      input,
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(alg.slice(2)) / 8 },
      sig,
    );
  }
  return verify(digest, input, { key, padding: constants.RSA_PKCS1_PADDING }, sig);
}
