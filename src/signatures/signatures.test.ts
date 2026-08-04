/**
 * What Signatures signs, what it will check for a User, and what it serves so that somebody
 * else can check it without asking.
 *
 * The subject is the artifact and the key set, so this is the one suite in the repository
 * with **no database in it**: this part stores nothing, and there is nothing here a row could
 * be read back from (ADR-0042). Everything else is real — two real Fastify instances, two real
 * Ed25519 keypairs, and the real `jose` doing the signing.
 *
 * **The oracle is `node:crypto`, deliberately not `jose`.** `jose` is what signs, so a `jose`
 * verification here would be self-verification and would pass against an artifact nobody else
 * on earth could check. The built-in is the independent implementation, and the signing input
 * is reconstructed by **splitting the emitted string** rather than rebuilt from our own header
 * and payload objects — which is what catches signing the wrong bytes, the one failure a
 * self-consistent implementation cannot see.
 *
 * Alongside that, four structural assertions that route through no format code of ours at all:
 * the signature segment is exactly 64 bytes for Ed25519, all three segments are base64url with
 * no `+`, `/` or `=`, tampering with either segment fails verification **including swapping
 * `typ` alone**, and **the key set contains no private member**. The last one guards the worst
 * failure available here — a wrong key argument serving the private scalar from an
 * unauthenticated route — and it is the single most valuable assertion in the feature.
 *
 * The keypairs are generated here, in the test, which is where a keypair may be generated: the
 * framework generates none, because a fresh key per restart leaves every prior artifact
 * unverifiable with nothing saying so (ADR-0041). The second one is a **whole second
 * Signatures**, which is how a foreign artifact is obtained without this file learning to build
 * one: a string another identity really signed is the case `POST /verify` most has to get
 * right, and a hand-assembled forgery would be testing our own idea of what one looks like.
 *
 * The one thing stood in for is the User Manager's hook, and what that costs is recorded on
 * `presentedUser` below.
 */

import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  verify,
} from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from "fastify";
import { type Component, serverComponent } from "../components.ts";
import type { LogFields, Logger } from "../logging.ts";
import { createSignatures, type Signatures } from "./signatures.ts";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

/** The Statement everything here is signed over. */
const statement = "we will ship on Friday";

/** What a request that has authenticated carries, whatever the hook below is standing in for. */
const withAToken = { authorization: "Bearer whatever this file's hook accepts" } as const;

/**
 * A stand-in for the User Manager's `requireUser`, and the whole of the authentication here.
 *
 * The real one needs a Db and a Token bought with a real password, and this suite has neither
 * by design — its subject is an artifact and a key, and nothing about either is a row. So what
 * is asserted below is what belongs to *this* part: the check route runs the hook it was handed
 * and runs it **before** its own handler, so a caller who does not get past it gets no verdict.
 *
 * What that cannot say is that the hook is the Manager's own and that the refusal is therefore
 * the same single 401 the routes under `/auth` answer. That claim is about the assembly, and it
 * is made in `default-gateway.test.ts` against the real one (ADR-0030).
 */
const presentedUser: preHandlerAsyncHookHandler = async (request, reply) => {
  // Returning the reply is how an async hook says the lifecycle is over; without it Fastify
  // would carry on to the handler after the 401 had been sent.
  if (request.headers.authorization === undefined) {
    return reply
      .code(401)
      .send({ statusCode: 401, error: "Unauthorized", message: "authentication failed" });
  }
  return undefined;
};

/** One line the part wrote, as the fields and the message it was written with. */
type Line = { readonly fields: LogFields; readonly message: string };

const written: Line[] = [];

/**
 * A Logger that keeps what it was told, which is the only way "the Statement is not in the
 * log" is observable at all.
 *
 * Structural, like every Logger: four methods and no `pino` anywhere (ADR-0027).
 */
const capturing: Logger = {
  debug: () => {},
  info: (fields, message) => void written.push({ fields, message }),
  warn: () => {},
  error: () => {},
};

const { privateKey } = generateKeyPairSync("ed25519");

/** Somebody else's identity entirely, and the only thing it is ever asked to do is sign. */
const { privateKey: someoneElsesKey } = generateKeyPairSync("ed25519");

let agentServer: Component & { readonly fastify: FastifyInstance };
let publicServer: Component & { readonly fastify: FastifyInstance };
let signatures: Signatures;

/** The other Shared Agent's servers, which exist only so that its constructor has somewhere. */
let elsewhere: Component & { readonly fastify: FastifyInstance };
let someoneElse: Signatures;

before(() => {
  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);
  // The whole construction: a key, the two servers its three routes go on, and where the
  // check's 401 comes from. No Db, because there is nothing to store, and this is the only
  // part of which that is true.
  signatures = createSignatures({
    signingKey: privateKey,
    agentServer,
    publicServer,
    users: { requireUser: presentedUser },
    logger: capturing,
  });

  elsewhere = serverComponent(Fastify(), nowhere);
  someoneElse = createSignatures({
    signingKey: someoneElsesKey,
    agentServer: elsewhere,
    publicServer: elsewhere,
    users: { requireUser: presentedUser },
    logger: capturing,
  });
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await elsewhere.stop();
});

describe("the key set", () => {
  it("is served to somebody holding no Token at all", async () => {
    // Every other read on this server is behind the User Manager's single 401, and this is
    // the stated exception: a public key is public, and the whole audience for it is a third
    // party who has no Token and never touches the rest of the Gateway (ADR-0042).
    const answered = await publicServer.fastify.inject({ method: "GET", url: "/jwks.json" });

    assert.equal(answered.statusCode, 200, answered.body);
    const set = answered.json<{ keys: JsonWebKey[] }>();
    // A Set even with one key, which is RFC 7517's own container and what a client's
    // remote-key-set helper consumes with no glue code.
    assert.equal(set.keys.length, 1);
    const [key] = set.keys;
    assert.ok(key !== undefined);
    assert.equal(key.kty, "OKP");
    assert.equal(key.crv, "Ed25519");
    assert.equal(typeof key.x, "string");
  });

  it("carries no private member, which is the assertion this whole part is arranged around", async () => {
    // The worst failure available on this surface is the private scalar being served from an
    // unauthenticated route, and two things stand between a wrong `KeyObject` and it:
    // `createPublicKey` in the constructor, and the response schema being a positive list of
    // public members. This is what notices if both are undone at once.
    const answered = await publicServer.fastify.inject({ method: "GET", url: "/jwks.json" });
    const [key] = answered.json<{ keys: JsonWebKey[] }>().keys;

    assert.equal(Object.hasOwn(key ?? {}, "d"), false, `the key set carried d: ${answered.body}`);
    // And on the bytes as well as on the parsed object, because a scalar nested anywhere at
    // all would parse into a field nobody thought to look at. The private JWK of this exact
    // key is what is looked for, so this cannot pass by the string simply being absent.
    const secret = privateKey.export({ format: "jwk" }).d;
    assert.equal(typeof secret, "string", "an Ed25519 private JWK should have a d to look for");
    assert.equal(answered.body.includes(String(secret)), false, "the private scalar was served");
  });

  it("refuses a query parameter it does not have rather than answering anyway", async () => {
    const answered = await publicServer.fastify.inject({ method: "GET", url: "/jwks.json?kid=1" });

    assert.equal(answered.statusCode, 400, answered.body);
    assert.match(answered.json<{ message: string }>().message, /"kid" is not a parameter/);
  });
});

describe("what it signs", () => {
  it("is three base64url segments, and the signature is exactly 64 bytes", async () => {
    const jws = await signatures.sign("saf-decision+jws", { statement });

    const segments = jws.split(".");
    assert.equal(segments.length, 3, jws);
    for (const segment of segments) {
      // No `+`, `/` or `=`: base64url and not base64, which is what makes the artifact
      // URL-safe and is a property of the encoding rather than of anything we assert about
      // its contents.
      assert.match(segment, /^[A-Za-z0-9_-]+$/, jws);
    }

    const [, , signature] = segments;
    // Exactly 64 for Ed25519, per RFC 8037. The measured trap this stands against is the
    // neighbouring one: Node emits DER for EC unless told otherwise, giving a 71-byte
    // signature where RFC 7518 requires 64, and a self-consistent verifier accepts it happily
    // (ADR-0042). The length is checked here because nothing else would.
    assert.equal(Buffer.from(String(signature), "base64url").length, 64);
  });

  it("declares the algorithm and the type in the protected header", async () => {
    const jws = await signatures.sign("saf-receipt+jws", { statement });

    assert.deepEqual(headerOf(jws), { alg: "EdDSA", typ: "saf-receipt+jws" });
  });

  it("carries the claims it was given, in the order they were written", async () => {
    // The payload is signed as the exact bytes emitted and nothing re-serializes it, so the
    // order of the caller's own object is the order of the bytes. Asserted on the decoded
    // string rather than on a parsed object, because a parsed object is where that fact stops
    // being visible (ADR-0042).
    const jws = await signatures.sign("saf-decision+jws", { seq: 7, statement });

    assert.equal(payloadTextOf(jws), JSON.stringify({ seq: 7, statement }));
  });

  it("verifies with node:crypto against the key the Public server serves", async () => {
    // The demoable claim, in its smallest form: nothing here holds the `KeyObject` the part
    // was constructed with. The key comes off the wire, the artifact comes out of `sign`, and
    // the check is the built-in's.
    const jws = await signatures.sign("saf-decision+jws", { statement });

    assert.equal(await checks(jws), true);
  });

  it("fails verification when either segment is tampered with", async () => {
    const jws = await signatures.sign("saf-decision+jws", { statement });
    const [header, payload, signature] = jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined);

    // A payload that says something else, signed with the signature of the thing it does not
    // say. This is the case the whole artifact exists to make impossible.
    const relabelled = Buffer.from(
      JSON.stringify({ statement: "we will ship on Monday" }),
      "utf8",
    ).toString("base64url");
    assert.equal(await checks(`${header}.${relabelled}.${signature}`), false);

    // And a signature from somewhere else entirely, which is a different key's or nobody's.
    const forged = Buffer.alloc(64, 7).toString("base64url");
    assert.equal(await checks(`${header}.${payload}.${forged}`), false);
  });

  it("fails verification when only the type is swapped, which is what proves the header is signed", async () => {
    // The sharpest of the tampering cases, and the reason the scheme is inside the signature
    // rather than beside it: a receipt presented as a Decision changes nothing but `typ`, and
    // a hand-rolled preimage has to remember to cover its own version tag where JWS cannot
    // omit it (ADR-0042).
    const jws = await signatures.sign("saf-receipt+jws", { statement });
    const [, payload, signature] = jws.split(".");
    const relabelled = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "saf-decision+jws" }),
      "utf8",
    ).toString("base64url");

    assert.equal(await checks(`${relabelled}.${payload}.${signature}`), false);
  });
});

describe("what the agent can have signed", () => {
  it("signs the Statement it was posted, and the artifact verifies against the served key", async () => {
    // The route's whole claim, in the form a third party meets it: the agent posts a string on
    // the Agent server, and the artifact that comes back checks out against a key fetched from
    // the other server by somebody holding nothing else.
    const answered = await signing({ statement });

    assert.equal(answered.statusCode, 200, answered.body);
    const { jws } = answered.json<{ jws: string }>();
    assert.equal(await checks(jws), true);
    assert.equal(payloadTextOf(jws), JSON.stringify({ statement }));
  });

  it("labels it generically when the agent asks for no type", async () => {
    const answered = await signing({ statement });

    assert.deepEqual(headerOf(answered.json<{ jws: string }>().jws), {
      alg: "EdDSA",
      typ: "saf-statement+jws",
    });
  });

  it("accepts any type at all, the Decision label included", async () => {
    // **Nothing is reserved**, and this is the assertion that says so. The agent already holds
    // the authority to publish Decisions, so a decision-typed artifact minted here is that
    // authority exercised without a log row rather than a forgery (ADR-0042). The third label
    // is here because the first two are ours and the point is that the framework has no list.
    for (const typ of ["saf-decision+jws", "saf-receipt+jws", "the votes of the March meeting"]) {
      const answered = await signing({ statement, typ });

      assert.equal(answered.statusCode, 200, answered.body);
      const { jws } = answered.json<{ jws: string }>();
      assert.deepEqual(headerOf(jws), { alg: "EdDSA", typ }, typ);
      // And it is a real artifact under that label rather than a string echoed back, which is
      // what makes the freedom above worth something to a verifier doing domain separation.
      assert.equal(await checks(jws), true, typ);
    }
  });

  it("keeps the type out of the payload, where a second copy could disagree with the header", async () => {
    // `typ` is a header parameter, and the body carrying it is not the claims: an artifact
    // labelled in two places is an artifact a verifier can find labelled two ways.
    const jws = signedBy(await signing({ statement, typ: "saf-receipt+jws" }));

    assert.equal(payloadTextOf(jws), JSON.stringify({ statement }));
  });

  it("refuses an empty Statement, and a type that is empty or absurdly long", async () => {
    // The Statement has no `maxLength` of ours — the Operator's own body limit is the bound —
    // and the type does, so that it cannot be a megabyte inside a header that is base64url'd
    // into every copy of the artifact forever. That bound is the whole of the validation.
    for (const [what, body] of [
      ["nothing at all", {}],
      ["an empty Statement", { statement: "" }],
      ["an empty type", { statement, typ: "" }],
      ["a type of 129 characters", { statement, typ: "x".repeat(129) }],
    ] as const) {
      const answered = await signing(body);

      assert.equal(answered.statusCode, 400, `${what}: ${answered.body}`);
    }

    // And the length either side of the bound, so that the number is pinned rather than the
    // idea of one: 128 signs.
    assert.equal((await signing({ statement, typ: "x".repeat(128) })).statusCode, 200);
  });

  it("refuses a query parameter it does not have rather than signing anyway", async () => {
    const answered = await agentServer.fastify.inject({
      method: "POST",
      url: "/sign?statement=hello",
      payload: { statement },
    });

    assert.equal(answered.statusCode, 400, answered.body);
    assert.match(answered.json<{ message: string }>().message, /"statement" is not a parameter/);
  });
});

describe("the check it will do for a User", () => {
  it("answers the header and the payload it read out of an artifact that is ours", async () => {
    const jws = signedBy(await signing({ statement, typ: "saf-receipt+jws" }));

    const answered = await checking({ jws });

    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), {
      verified: true,
      header: { alg: "EdDSA", typ: "saf-receipt+jws" },
      payload: { statement },
    });
  });

  it("answers false, and not an error, for every way a string can fail to be ours", async () => {
    const jws = signedBy(await signing({ statement }));
    const [header, payload, signature] = jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined);

    // A real artifact of another identity's, really signed by a whole second Signatures. This
    // is the case the route exists for and the one a hand-built forgery would not have been.
    const foreign = await someoneElse.sign("saf-statement+jws", { statement });
    // A header that is not JSON at all, which is a parse failure inside the library rather
    // than a signature that did not check out.
    const unparseable = Buffer.from("this is not a header", "utf8").toString("base64url");

    for (const [what, presented] of [
      ["another identity's artifact", foreign],
      ["a tampered signature", `${header}.${payload}.${Buffer.alloc(64, 7).toString("base64url")}`],
      ["a swapped type", `${headerFor("saf-decision+jws")}.${payload}.${signature}`],
      ["two segments", `${header}.${payload}`],
      ["four segments", `${jws}.${signature}`],
      ["an unparseable header", `${unparseable}.${payload}.${signature}`],
      ["base64url that is not", `${header}.not+valid/base64=.${signature}`],
      ["a string that is nothing of the kind", "hello"],
    ] as const) {
      const answered = await checking({ jws: presented });

      // 200, because none of these is this Gateway failing: they all arrive from a caller,
      // and "no" is the answer to the question that was asked (ADR-0042).
      assert.equal(answered.statusCode, 200, `${what}: ${answered.body}`);
      assert.deepEqual(answered.json(), { verified: false }, what);
      // And nothing about the artifact reported beside it. A header echoed off a `false` would
      // be answering with the unverified assertions of a string somebody posted.
      assert.equal(answered.body.includes("header"), false, what);
    }
  });

  it("runs the hook it was handed before its own handler, so a refusal answers no verdict", async () => {
    const jws = signedBy(await signing({ statement }));

    const answered = await publicServer.fastify.inject({
      method: "POST",
      url: "/verify",
      payload: { jws },
    });

    assert.equal(answered.statusCode, 401, answered.body);
    // The artifact is genuinely ours, so a `true` here would be the handler having run behind
    // the refusal. That the 401 is the User Manager's own is the assembly's claim and is
    // asserted in `default-gateway.test.ts`, this file's hook being a stand-in.
    assert.equal(answered.body.includes("verified"), false, answered.body);
  });

  it("refuses a missing artifact, and a query parameter it does not have", async () => {
    for (const body of [{}, { jws: "" }]) {
      assert.equal((await checking(body)).statusCode, 400, JSON.stringify(body));
    }

    const withQuery = await publicServer.fastify.inject({
      method: "POST",
      url: "/verify?jws=hello",
      headers: withAToken,
      payload: { jws: "hello" },
    });
    assert.equal(withQuery.statusCode, 400, withQuery.body);
    assert.match(withQuery.json<{ message: string }>().message, /"jws" is not a parameter/);

    // And the order the two refusals come in, which is the lifecycle rather than a choice of
    // ours: the hook is a `preHandler` and the parameter check a `preValidation`, so a caller
    // with a mistyped parameter and no Token at all is told about the parameter. It leaks
    // nothing — the refusal names a parameter of the route and never a User, and nobody has
    // looked at the artifact.
    const neither = await publicServer.fastify.inject({
      method: "POST",
      url: "/verify?jws=hello",
      payload: { jws: "hello" },
    });
    assert.equal(neither.statusCode, 400, neither.body);
  });
});

describe("what it writes down", () => {
  it("logs the type and a digest, and never the Statement", async () => {
    // Signing is otherwise unrecorded, which is a real regression and is mitigated rather
    // than solved by this line: an injected agent mints unlimited artifacts and the only
    // trail is here (ADR-0042). What must not be here is the Statement itself, or a log
    // aggregator becomes a shadow copy of every private thing the agent ever signed.
    const secret = "the thing nobody should find in stdout";
    written.length = 0;
    await signatures.sign("saf-decision+jws", { statement: secret });

    assert.equal(written.length, 1, "one signing should write one line");
    const [line] = written;
    assert.ok(line !== undefined);
    assert.equal(line.fields.typ, "saf-decision+jws");
    // A SHA-256 of the Statement, and the digest is recomputed here rather than copied off
    // the line, so a line carrying a digest of something else fails.
    assert.equal(line.fields.statementSha256, sha256(secret));
    // And the Statement is in none of it, fields or message.
    assert.equal(JSON.stringify(line).includes(secret), false, JSON.stringify(line));
  });

  it("writes the same one line for a signing that came in over the route", async () => {
    // Signing through `POST /sign` is the same function Decisions calls, so the trail is the
    // same trail: one line, the `typ` that was asked for, and a digest instead of the string.
    // A route with a log line of its own would have been a second answer to "what was signed".
    const secret = "the other thing nobody should find in stdout";
    written.length = 0;
    await signing({ statement: secret, typ: "saf-receipt+jws" });

    assert.equal(written.length, 1, "one signing should write one line");
    const [line] = written;
    assert.ok(line !== undefined);
    assert.equal(line.fields.typ, "saf-receipt+jws");
    assert.equal(line.fields.statementSha256, sha256(secret));
    assert.equal(JSON.stringify(line).includes(secret), false, JSON.stringify(line));
  });
});

/** One `POST /sign`, which is the only way the agent reaches the key at all. */
function signing(body: Record<string, unknown>) {
  return agentServer.fastify.inject({ method: "POST", url: "/sign", payload: body });
}

/** One `POST /verify`, by somebody the hook above lets through. */
function checking(body: Record<string, unknown>) {
  return publicServer.fastify.inject({
    method: "POST",
    url: "/verify",
    headers: withAToken,
    payload: body,
  });
}

/** The artifact out of a signing that was supposed to have worked. */
function signedBy(answered: Awaited<ReturnType<typeof signing>>): string {
  assert.equal(answered.statusCode, 200, answered.body);
  return JSON.parse(answered.body).jws;
}

/** A protected header of this file's own, for the one tampering case that rewrites one. */
function headerFor(typ: string): string {
  return Buffer.from(JSON.stringify({ alg: "EdDSA", typ }), "utf8").toString("base64url");
}

/** The protected header of an artifact, decoded from the string that was emitted. */
function headerOf(jws: string): unknown {
  const [header] = jws.split(".");
  return JSON.parse(Buffer.from(String(header), "base64url").toString("utf8"));
}

/** The payload as the bytes it was signed as, rather than as an object parsed out of them. */
function payloadTextOf(jws: string): string {
  const [, payload] = jws.split(".");
  return Buffer.from(String(payload), "base64url").toString("utf8");
}

/**
 * One verification, done the way a third party does it: fetch the key set, take the key, split
 * the artifact, and check with the built-in.
 *
 * The signing input is **reconstructed by splitting the emitted string** and never rebuilt
 * from a header and a payload of this file's own, which is the whole point: a rebuilt input
 * would agree with a `sign` that had serialized something else, and the artifact would still
 * be unverifiable by everybody.
 */
async function checks(jws: string): Promise<boolean> {
  const answered = await publicServer.fastify.inject({ method: "GET", url: "/jwks.json" });
  const [key] = answered.json<{ keys: JsonWebKey[] }>().keys;
  assert.ok(key !== undefined, answered.body);

  const [header, payload, signature] = jws.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return false;
  return verify(
    null,
    Buffer.from(`${header}.${payload}`, "utf8"),
    createPublicKey({ key, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
}

/** SHA-256 in hex, computed here so that the assertion is not a copy of the code under test. */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
