import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  verify,
} from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import type { LogFields, Logger } from "../logging/logging.ts";
import { type FakeAuth, fakeAuth } from "../test-support/fake-auth.ts";
import type { UserRecord } from "../users/routes.ts";
import { createSignatures, type Signatures } from "./signatures.ts";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const statement = "we will ship on Friday";

const withAToken = { authorization: "Bearer whatever this file's hook accepts" } as const;

const somebody: UserRecord = {
  id: "3f2a1c88-5b41-4d0e-9c72-6a1e4b8d3c05",
  attributes: {},
  createdAt: new Date(0).toISOString(),
};

function anyHeader(): FakeAuth {
  return fakeAuth("Bearer", (request) =>
    request.headers.authorization === undefined
      ? { kind: "absent" }
      : { kind: "authenticated", user: somebody },
  );
}

type Line = { readonly fields: LogFields; readonly message: string };

const written: Line[] = [];

const capturing: Logger = {
  debug: () => {},
  info: (fields, message) => void written.push({ fields, message }),
  warn: () => {},
  error: () => {},
};

const { privateKey } = generateKeyPairSync("ed25519");

const { privateKey: someoneElsesKey } = generateKeyPairSync("ed25519");

let agentServer: ServerComponent<FastifyInstance>;
let publicServer: ServerComponent<FastifyInstance>;
let signatures: Signatures;

let elsewhere: ServerComponent<FastifyInstance>;
let someoneElse: Signatures;

before(() => {
  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);
  publicServer.registerAuth(anyHeader());
  signatures = createSignatures({
    signingKey: privateKey,
    agentServer,
    publicServer,
    logger: capturing,
  });

  elsewhere = serverComponent(Fastify(), nowhere);
  elsewhere.registerAuth(anyHeader());
  someoneElse = createSignatures({
    signingKey: someoneElsesKey,
    agentServer: elsewhere,
    publicServer: elsewhere,
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
    const answered = await publicServer.fastify.inject({ method: "GET", url: "/jwks.json" });

    assert.equal(answered.statusCode, 200, answered.body);
    const set = answered.json<{ keys: JsonWebKey[] }>();
    assert.equal(set.keys.length, 1);
    const [key] = set.keys;
    assert.ok(key !== undefined);
    assert.equal(key.kty, "OKP");
    assert.equal(key.crv, "Ed25519");
    assert.equal(typeof key.x, "string");
  });

  it("carries no private member, which is the assertion this whole part is arranged around", async () => {
    const answered = await publicServer.fastify.inject({ method: "GET", url: "/jwks.json" });
    const [key] = answered.json<{ keys: JsonWebKey[] }>().keys;

    assert.equal(Object.hasOwn(key ?? {}, "d"), false, `the key set carried d: ${answered.body}`);
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
    const jws = await signatures.sign("concorde-decision+jws", { statement });

    const segments = jws.split(".");
    assert.equal(segments.length, 3, jws);
    for (const segment of segments) {
      assert.match(segment, /^[A-Za-z0-9_-]+$/, jws);
    }

    const [, , signature] = segments;
    assert.equal(Buffer.from(String(signature), "base64url").length, 64);
  });

  it("declares the algorithm and the type in the protected header", async () => {
    const jws = await signatures.sign("concorde-receipt+jws", { statement });

    assert.deepEqual(headerOf(jws), { alg: "EdDSA", typ: "concorde-receipt+jws" });
  });

  it("carries the claims it was given, in the order they were written", async () => {
    const jws = await signatures.sign("concorde-decision+jws", { seq: 7, statement });

    assert.equal(payloadTextOf(jws), JSON.stringify({ seq: 7, statement }));
  });

  it("verifies with node:crypto against the key the Public server serves", async () => {
    const jws = await signatures.sign("concorde-decision+jws", { statement });

    assert.equal(await checks(jws), true);
  });

  it("fails verification when either segment is tampered with", async () => {
    const jws = await signatures.sign("concorde-decision+jws", { statement });
    const [header, payload, signature] = jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined);

    const relabelled = Buffer.from(
      JSON.stringify({ statement: "we will ship on Monday" }),
      "utf8",
    ).toString("base64url");
    assert.equal(await checks(`${header}.${relabelled}.${signature}`), false);

    const forged = Buffer.alloc(64, 7).toString("base64url");
    assert.equal(await checks(`${header}.${payload}.${forged}`), false);
  });

  it("fails verification when only the type is swapped, which is what proves the header is signed", async () => {
    const jws = await signatures.sign("concorde-receipt+jws", { statement });
    const [, payload, signature] = jws.split(".");
    const relabelled = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "concorde-decision+jws" }),
      "utf8",
    ).toString("base64url");

    assert.equal(await checks(`${relabelled}.${payload}.${signature}`), false);
  });
});

describe("what the agent can have signed", () => {
  it("signs the Statement it was posted, and the artifact verifies against the served key", async () => {
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
      typ: "concorde-statement+jws",
    });
  });

  it("accepts any type at all, the Decision label included", async () => {
    for (const typ of [
      "concorde-decision+jws",
      "concorde-receipt+jws",
      "the votes of the March meeting",
    ]) {
      const answered = await signing({ statement, typ });

      assert.equal(answered.statusCode, 200, answered.body);
      const { jws } = answered.json<{ jws: string }>();
      assert.deepEqual(headerOf(jws), { alg: "EdDSA", typ }, typ);
      assert.equal(await checks(jws), true, typ);
    }
  });

  it("keeps the type out of the payload, where a second copy could disagree with the header", async () => {
    const jws = signedBy(await signing({ statement, typ: "concorde-receipt+jws" }));

    assert.equal(payloadTextOf(jws), JSON.stringify({ statement }));
  });

  it("refuses an empty Statement, and a type that is empty or absurdly long", async () => {
    for (const [what, body] of [
      ["nothing at all", {}],
      ["an empty Statement", { statement: "" }],
      ["an empty type", { statement, typ: "" }],
      ["a type of 129 characters", { statement, typ: "x".repeat(129) }],
    ] as const) {
      const answered = await signing(body);

      assert.equal(answered.statusCode, 400, `${what}: ${answered.body}`);
    }

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
    const jws = signedBy(await signing({ statement, typ: "concorde-receipt+jws" }));

    const answered = await checking({ jws });

    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), {
      verified: true,
      header: { alg: "EdDSA", typ: "concorde-receipt+jws" },
      payload: { statement },
    });
  });

  it("answers false, and not an error, for every way a string can fail to be ours", async () => {
    const jws = signedBy(await signing({ statement }));
    const [header, payload, signature] = jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined);

    const foreign = await someoneElse.sign("concorde-statement+jws", { statement });
    const unparseable = Buffer.from("this is not a header", "utf8").toString("base64url");

    for (const [what, presented] of [
      ["another identity's artifact", foreign],
      ["a tampered signature", `${header}.${payload}.${Buffer.alloc(64, 7).toString("base64url")}`],
      ["a swapped type", `${headerFor("concorde-decision+jws")}.${payload}.${signature}`],
      ["two segments", `${header}.${payload}`],
      ["four segments", `${jws}.${signature}`],
      ["an unparseable header", `${unparseable}.${payload}.${signature}`],
      ["base64url that is not", `${header}.not+valid/base64=.${signature}`],
      ["a string that is nothing of the kind", "hello"],
    ] as const) {
      const answered = await checking({ jws: presented });

      assert.equal(answered.statusCode, 200, `${what}: ${answered.body}`);
      assert.deepEqual(answered.json(), { verified: false }, what);
      assert.equal(answered.body.includes("header"), false, what);
    }
  });

  it("runs the server's hook before its own handler, so a refusal answers no verdict", async () => {
    const jws = signedBy(await signing({ statement }));

    const answered = await publicServer.fastify.inject({
      method: "POST",
      url: "/verify",
      payload: { jws },
    });

    assert.equal(answered.statusCode, 401, answered.body);
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
    const secret = "the thing nobody should find in stdout";
    written.length = 0;
    await signatures.sign("concorde-decision+jws", { statement: secret });

    assert.equal(written.length, 1, "one signing should write one line");
    const [line] = written;
    assert.ok(line !== undefined);
    assert.equal(line.fields.typ, "concorde-decision+jws");
    assert.equal(line.fields.statementSha256, sha256(secret));
    assert.equal(JSON.stringify(line).includes(secret), false, JSON.stringify(line));
  });

  it("writes the same one line for a signing that came in over the route", async () => {
    const secret = "the other thing nobody should find in stdout";
    written.length = 0;
    await signing({ statement: secret, typ: "concorde-receipt+jws" });

    assert.equal(written.length, 1, "one signing should write one line");
    const [line] = written;
    assert.ok(line !== undefined);
    assert.equal(line.fields.typ, "concorde-receipt+jws");
    assert.equal(line.fields.statementSha256, sha256(secret));
    assert.equal(JSON.stringify(line).includes(secret), false, JSON.stringify(line));
  });
});

function signing(body: Record<string, unknown>) {
  return agentServer.fastify.inject({ method: "POST", url: "/sign", payload: body });
}

function checking(body: Record<string, unknown>) {
  return publicServer.fastify.inject({
    method: "POST",
    url: "/verify",
    headers: withAToken,
    payload: body,
  });
}

function signedBy(answered: Awaited<ReturnType<typeof signing>>): string {
  assert.equal(answered.statusCode, 200, answered.body);
  return JSON.parse(answered.body).jws;
}

function headerFor(typ: string): string {
  return Buffer.from(JSON.stringify({ alg: "EdDSA", typ }), "utf8").toString("base64url");
}

function headerOf(jws: string): unknown {
  const [header] = jws.split(".");
  return JSON.parse(Buffer.from(String(header), "base64url").toString("utf8"));
}

function payloadTextOf(jws: string): string {
  const [, payload] = jws.split(".");
  return Buffer.from(String(payload), "base64url").toString("utf8");
}

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
