/**
 * Every key an Operator can bring, and what happens to the ones that are not Ed25519.
 *
 * `signatures.test.ts` is the artifact and the routes, all of it on one key. This file
 * is the other axis: **one row of the derivation table per test**, plus
 * the keys that earn a refusal instead of an algorithm. Nothing here is a database
 * and nothing is mocked but the Users component's hook, which none of these tests reach.
 *
 * The claim under every derivation row is the same one, and it is deliberately not "the
 * function returned the right string": a derived algorithm is only worth anything if an
 * artifact carries it and somebody else can check that artifact. So each row signs, reads the
 * `alg` out of the emitted header, fetches the key from `/jwks.json` and verifies with
 * `node:crypto`. That last step is what makes the key set's response schema part of the
 * subject too: it is a positive list of members, so an `EC` key losing `y` or an `RSA` key
 * losing `n` would fail here rather than in somebody's client.
 *
 * **The oracle is `node:crypto` and it needs the `alg` → primitive mapping this framework
 * refuses to have.** That mapping lives here, in a test, which is the only place it may: the
 * shipped code hands `jose` a string and the library owns hash, padding and signature
 * encoding, and a second mapping in `src` that disagreed with the library's would be worse
 * than none. Written out here it does the opposite job, being an independent
 * implementation, so an artifact that only `jose` can read fails.
 *
 * The signature **length** is asserted for every row alongside the verification, because the
 * measured trap in this feature is an EC signature that verifies fine against itself: Node
 * emits DER unless told `ieee-p1363`, giving 71 bytes where RFC 7518 requires exactly 64, and
 * a self-consistent verifier accepts it happily while every other library rejects it.
 *
 * The refusals are asserted at the **constructor**, synchronously, on the precedent of
 * `createUsers` refusing a `tokenTtl` and `createAgentContainerRuntime` refusing an empty
 * image: an ambiguous key throws before any server exists, so there is no HTTP surface it
 * could have. Each of them is checked for naming what to pass and not merely for throwing,
 * because a refusal that does not say `signingAlg` leaves an Operator exactly where they were.
 *
 * The one refusal that is **not** the constructor's closes the file, because the shape of it
 * is the thing to know: a `signingAlg` that was given and that the key cannot perform is
 * `jose`'s to refuse, `jose`'s check is asynchronous, and construction is not. So it lands at
 * the first signing, and what stands in front of it is the wording of the refusals above.
 */

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

/** A server that is only ever injected into, and the pair a Signatures is constructed on. */
type Server = ServerComponent<FastifyInstance>;

/**
 * One keypair per key type, generated here, which is where a keypair may be generated: the
 * framework generates none, because a fresh key per restart leaves every prior artifact
 * unverifiable with nothing saying so.
 *
 * Once each and at module load rather than per test, because two of them are RSA and RSA
 * generation is the only slow thing in this file.
 */
const keys = {
  ed25519: generateKeyPairSync("ed25519").privateKey,
  ed448: generateKeyPairSync("ed448").privateKey,
  p256: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
  p384: generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey,
  p521: generateKeyPairSync("ec", { namedCurve: "P-521" }).privateKey,
  secp256k1: generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey,
  rsa: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
  rsaPss: generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).privateKey,
  // Not a signing key at all, and the case no algorithm anywhere would rescue.
  x25519: generateKeyPairSync("x25519").privateKey,
} as const;

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

/** The User every authenticated request in this file acts as, and no row anywhere. */
const somebody: UserRecord = {
  id: "3f2a1c88-5b41-4d0e-9c72-6a1e4b8d3c05",
  attributes: {},
  createdAt: new Date(0).toISOString(),
};

/** The Statement every artifact here is signed over. */
const statement = "we will ship on Friday";

/** Nothing about these tests is a log line, and none of them reads one. */
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Every server constructed here, closed at the end whether its part was built or refused. */
const opened: Component[] = [];

after(async () => {
  for (const server of opened) await server.stop();
});

describe("the algorithm it derives from the key", () => {
  // One row per key type the table derives, and the artifact is what says which was derived:
  // there is no accessor for it and there should not be, since the `alg` a verifier acts on
  // is the one in the header.
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
      // The key set says the same thing about the key in JOSE's vocabulary, which is the
      // vocabulary the derivation read it in. `prime256v1` here would mean the switch had
      // gone through `asymmetricKeyDetails` and OpenSSL's names after all.
      const served = await servedKey();
      assert.equal(served.kty, kty);
      assert.equal(served.crv, crv);
      // The length RFC 7518 requires for this curve, and not a DER-encoded one, which is
      // both longer and variable.
      assert.equal(signatureBytes(jws), bytes, jws);
      assert.equal(checksUnder(alg, jws, served), true);

      // And the oracle is not vacuous, which for a verification written per algorithm is
      // worth one line: a payload saying something else, under the signature of the thing it
      // does not say, answers false rather than passing through a branch that always agrees.
      const [header, , signature] = jws.split(".");
      const relabelled = Buffer.from(
        JSON.stringify({ statement: "we will ship on Monday" }),
        "utf8",
      ).toString("base64url");
      assert.equal(checksUnder(alg, `${header}.${relabelled}.${signature}`, served), false);
    });
  }

  it("pins the derived algorithm on the check it does for a User, so an EC artifact is checkable there too", async () => {
    // `POST /verify` passes `algorithms: [alg]` to the library, so the derived value is
    // load-bearing in both directions: a wrong one would refuse this Gateway's own artifact.
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
    // Six algorithms are valid for one RSA key and nothing in the key distinguishes them, so
    // this is the one key type a derivation cannot serve. Guessing would be silent: an
    // artifact signed under the wrong one of the six is refused by the verifier and by
    // nobody here.
    assert.throws(
      () => constructedWith(keys.rsa),
      (error: Error) => {
        assert.match(error.message, /signingAlg/);
        // The two ends of the choice by name, because "pass an algorithm" is not an answer to
        // somebody who does not know that PSS and PKCS#1 v1.5 are the question.
        assert.match(error.message, /RS256/);
        assert.match(error.message, /PS256/);
        return true;
      },
    );
  });

  for (const alg of ["PS256", "RS256"]) {
    it(`signs with an RSA key once it is told ${alg}`, async () => {
      // The other half of the refusal above: the key was never the problem, the ambiguity
      // was, and naming the algorithm resolves it. Both ends of the choice work, which is
      // what makes the refusal a real question rather than a preference of ours.
      const { signatures, servedKey } = constructedWith(keys.rsa, alg);

      const jws = await signatures.sign("concorde-decision+jws", { statement });

      assert.deepEqual(headerOf(jws), { alg, typ: "concorde-decision+jws" });
      const served = await servedKey();
      assert.equal(served.kty, "RSA");
      // `n` and `e` survived the response schema, which a positive list of members is
      // otherwise free to drop silently.
      assert.equal(typeof served.n, "string");
      assert.equal(typeof served.e, "string");
      assert.equal(checksUnder(alg, jws, served), true);
    });
  }

  it("refuses an rsa-pss key in a sentence, not with the crypto error code the export throws", () => {
    // Node's own failure here is `ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE`, whose whole message
    // is `Unsupported JWK Key Type.`, which names neither the key nor anything to do about it,
    // and it would otherwise surface from inside a line an Operator did not write.
    assert.throws(
      () => constructedWith(keys.rsaPss),
      (error: Error) => {
        assert.match(error.message, /rsa-pss/);
        assert.match(error.message, /signingAlg "PS256"/);
        // The library's own words are kept, at the end and as a clause: they are the only part
        // of this that is evidence rather than explanation.
        assert.match(error.message, /Unsupported JWK Key Type/);
        // And the code is still reachable for anybody who wants it, rather than swallowed.
        assert.equal(
          (error.cause as NodeJS.ErrnoException)?.code,
          "ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE",
        );
        return true;
      },
    );
  });

  // An explicit algorithm does not rescue this one and must not appear to: the JWK export is
  // what the key set is made of, so a key that cannot be exported has no public half to serve
  // whatever it can sign with.
  it("refuses an rsa-pss key even when it was told the algorithm", () => {
    assert.throws(() => constructedWith(keys.rsaPss, "PS256"), /cannot be exported as a JWK/);
  });

  for (const [what, key] of [
    // The two near misses, and the reason the table is narrower than JOSE. Both determine an
    // algorithm, `EdDSA` and `ES256K`, and `jose`'s own algorithm table can perform neither:
    // its `EdDSA` entry is Ed25519 alone and it has no `ES256K` at all. Deriving them would
    // start a Gateway whose first signing fails.
    ["an Ed448 key", keys.ed448],
    ["a secp256k1 key", keys.secp256k1],
    // And a key that is not for signing at all, which no algorithm anywhere would rescue.
    ["an X25519 key", keys.x25519],
  ] as const) {
    it(`refuses ${what}, naming what it read off the key`, () => {
      assert.throws(
        () => constructedWith(key),
        (error: Error) => {
          assert.match(error.message, /no algorithm can be derived/);
          // The curve, in JOSE's spelling, so that the sentence describes the key the Operator
          // is holding rather than a category it fell into.
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
  // Everything above is refused before a server exists. This is the exposure that leaves:
  // a `signingAlg` that was *given* is passed to `jose` unexamined, because whether a key
  // can perform an algorithm is the library's question and a second answer of ours would be
  // a second opinion. The library's answer is asynchronous and construction is
  // not, so it arrives at the first signing. Pinned rather than merely recorded, because a
  // documented exposure that nothing exercises is a documented guess.
  for (const [what, key, signingAlg] of [
    ["an algorithm this key cannot perform", keys.ed25519, "ES256"],
    // The sharper case, and the one the table above cannot reach: EdDSA is genuinely Ed448's
    // algorithm, and passing it walks straight past the construction refusal that exists
    // because `jose` cannot perform it.
    ["EdDSA for an Ed448 key, which construction would have refused", keys.ed448, "EdDSA"],
    // And a string that is no algorithm at all, which the library names as such.
    ["a string that is no algorithm at all", keys.ed25519, "P-256"],
  ] as const) {
    it(`constructs with ${what}, and refuses at the first signing instead`, async () => {
      const { signatures } = constructedWith(key, signingAlg);

      await assert.rejects(() => signatures.sign("concorde-decision+jws", { statement }));
    });
  }
});

/**
 * One whole Signatures around one key, on servers of its own.
 *
 * A pair of servers each time rather than one shared pair, because both plugins register at
 * no prefix and a second registration of `/sign` on the same instance is a Fastify error
 * rather than a second Signatures. They are never started; `after` closes them all, including
 * the pair belonging to a construction that threw.
 */
function constructedWith(
  signingKey: KeyObject,
  signingAlg?: string,
): { signatures: Signatures; publicServer: Server; servedKey: () => Promise<JsonWebKey> } {
  const agentServer = serverComponent(Fastify(), nowhere);
  const publicServer = serverComponent(Fastify(), nowhere);
  // A scheme that takes any `Authorization` header, because `POST /verify` takes the server's
  // hook and a server with no scheme registered throws rather than refusing. Only the
  // one test that reaches that route presents a header; what a real scheme does is
  // `src/password-auth/`'s.
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

/** The one key the Public server serves, fetched the way a third party fetches it. */
async function oneServedKey(publicServer: Server): Promise<JsonWebKey> {
  const answered = await publicServer.fastify.inject({ method: "GET", url: "/jwks.json" });
  assert.equal(answered.statusCode, 200, answered.body);
  const [key] = answered.json<{ keys: JsonWebKey[] }>().keys;
  assert.ok(key !== undefined, answered.body);
  return key;
}

/** The protected header of an artifact, decoded from the string that was emitted. */
function headerOf(jws: string): unknown {
  const [header] = jws.split(".");
  return JSON.parse(Buffer.from(String(header), "base64url").toString("utf8"));
}

/** How long the signature segment is, which is the one thing about it a curve fixes. */
function signatureBytes(jws: string): number {
  const [, , signature] = jws.split(".");
  return Buffer.from(String(signature), "base64url").length;
}

/**
 * One verification, done with the built-in against the key the Public server served.
 *
 * The signing input is **reconstructed by splitting the emitted string**, never rebuilt from
 * a header and a payload of this file's own: a rebuilt input would agree with a `sign` that
 * had serialized something else and the artifact would still be unverifiable by everybody.
 */
function checksUnder(alg: string, jws: string, served: JsonWebKey): boolean {
  const [header, payload, signature] = jws.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return false;

  const input = Buffer.from(`${header}.${payload}`, "utf8");
  const sig = Buffer.from(signature, "base64url");
  const key = createPublicKey({ key: served, format: "jwk" });

  // The mapping the shipped code does not have and this one needs, because `node:crypto`
  // takes a digest, a padding and a signature encoding where `jose` takes the `alg` itself.
  // Ed25519 is the case with no digest argument at all: the hash is inside the scheme.
  if (alg === "EdDSA") return verify(null, input, key, sig);

  // Every remaining algorithm here names its digest in its own last three characters, which
  // is JOSE's own naming and not a coincidence worth abstracting.
  const digest = `sha${alg.slice(2)}`;
  if (alg.startsWith("ES")) {
    // `ieee-p1363` and not the default: Node reads DER otherwise, and a DER-encoded
    // signature of the same key would be accepted here and refused everywhere else.
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
