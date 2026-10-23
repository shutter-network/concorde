import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import type { Db } from "../db/index.ts";
import type { LogFields, Logger } from "../logging/logging.ts";
import { createPasswordAuth } from "../password-auth/password-auth.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { type FakeAuth, fakeAuth } from "../test-support/fake-auth.ts";
import type { UserRecord } from "../users/routes.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers } from "../users/users.ts";
import { NoAuthRegisteredError } from "./auth.ts";
import { type ServerComponent, serverComponent } from "./components.ts";

const hour = 60 * 60 * 1000;

const cheap = { logN: 12, blockSize: 8, parallelism: 1 } as const;

const ops = "/ops";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const refusalBody = { statusCode: 401, error: "Unauthorized", message: "authentication failed" };

let database: TestDatabase;
let db: Db;
let admitted: UserRecord;
let other: UserRecord;
let existingRefusal: string;

const built: ServerComponent<FastifyInstance>[] = [];

type LogLine = { readonly fields: LogFields; readonly message: string };

async function guarded(): Promise<{
  readonly server: ServerComponent<FastifyInstance>;
  readonly warned: readonly LogLine[];
  readonly thrown: readonly unknown[];
}> {
  const warned: LogLine[] = [];
  const thrown: unknown[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (fields, message) => void warned.push({ fields, message }),
    error: () => {},
  };
  const server = serverComponent(Fastify(), nowhere, { logger });
  built.push(server);
  server.fastify.setErrorHandler(async (error: Error, _request, reply) => {
    thrown.push(error);
    return reply.code(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: error.message,
    });
  });
  await server.fastify.register(operatorRoutes(server), { prefix: ops });
  return { server, warned, thrown };
}

function operatorRoutes(server: ServerComponent<FastifyInstance>): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/whoami", { preHandler: server.requireUser }, async (request) => ({
      asked: request.concordeUser.id,
    }));

    await fastify.register(
      async (inner) => {
        inner.post<{ Body: { text: string } }>(
          "/ask",
          { preHandler: server.requireUser },
          async (request) => ({ by: request.concordeUser.id, said: request.body.text }),
        );
      },
      { prefix: "/deep" },
    );
  };
}

function ask(server: ServerComponent<FastifyInstance>, authorization = "Bearer whatever") {
  return server.fastify.inject({
    method: "GET",
    url: `${ops}/whoami`,
    headers: { authorization },
  });
}

function admits(scheme: string, user: UserRecord): FakeAuth {
  return fakeAuth(scheme, { kind: "authenticated", user });
}

before(async () => {
  database = await createTestDatabase("gateway_auths");
  db = database.db;
  await applySchema(db, usersSchema, passwordAuthSchema);

  const reference = serverComponent(Fastify(), nowhere);
  built.push(reference);
  const users = createUsers({ db });
  createPasswordAuth({ db, users, publicServer: reference, tokenTtl: hour, scrypt: cheap });
  admitted = await db.tx((tx) => users.create(tx));
  other = await db.tx((tx) => users.create(tx));

  const refused = await reference.fastify.inject({
    method: "POST",
    url: "/auth/tokens",
    payload: { user: "00000000-0000-4000-8000-000000000000", password: "not anybody's" },
  });
  assert.equal(refused.statusCode, 401, refused.body);
  existingRefusal = refused.body;
  assert.equal(refused.headers["www-authenticate"], undefined);
});

after(async () => {
  for (const server of built) await server.stop();
  await database.drop();
});

describe("the walk", () => {
  it("authenticates through the one registered Auth", async () => {
    const { server } = await guarded();
    const bearer = admits("Bearer", admitted);
    server.registerAuth(bearer);

    const answered = await ask(server, "Bearer a-token");
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { asked: admitted.id });

    assert.equal(bearer.asked.length, 1);
    assert.equal(bearer.asked[0]?.headers.authorization, "Bearer a-token");
    assert.equal(bearer.asked[0]?.url, `${ops}/whoami`);
  });

  it("asks the next Auth when the first answers absent", async () => {
    const { server } = await guarded();
    const bearer = fakeAuth("Bearer");
    const nostr = admits("Nostr", admitted);
    server.registerAuth(bearer);
    server.registerAuth(nostr);

    const answered = await ask(server, "Nostr an-event");
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { asked: admitted.id });

    assert.equal(bearer.asked.length, 1);
    assert.equal(nostr.asked.length, 1);
  });

  it("asks them in registration order and stops at the first that authenticates", async () => {
    const { server } = await guarded();
    const first = admits("Bearer", admitted);
    const second = admits("Nostr", other);
    server.registerAuth(first);
    server.registerAuth(second);

    const answered = await ask(server);
    assert.deepEqual(answered.json(), { asked: admitted.id });
    assert.equal(second.asked.length, 0, "the Auth behind the one that authenticated was asked");
  });

  it("stops at the first refusal and never asks the Auth behind it", async () => {
    const { server } = await guarded();
    const bearer = fakeAuth("Bearer", { kind: "refused", code: "invalid_token" });
    const nostr = admits("Nostr", admitted);
    server.registerAuth(bearer);
    server.registerAuth(nostr);

    const refused = await ask(server);
    assert.equal(refused.statusCode, 401, refused.body);
    assert.equal(bearer.asked.length, 1);
    assert.equal(nostr.asked.length, 0);
  });

  it("refuses a request that no Auth recognised", async () => {
    const { server } = await guarded();
    server.registerAuth(fakeAuth("Bearer"));
    server.registerAuth(fakeAuth("Nostr"));

    const refused = await ask(server, "Basic aGk6dGhlcmU=");
    assert.equal(refused.statusCode, 401, refused.body);
    assert.deepEqual(refused.json(), refusalBody);
  });
});

describe("the refusal", () => {
  it("answers the 401 Password Auth already answered, byte for byte", async () => {
    const { server } = await guarded();
    const bearer = fakeAuth("Bearer");
    server.registerAuth(bearer);

    const refusals = [await ask(server)];
    for (const code of ["invalid_request", "invalid_token"] as const) {
      bearer.answers({ kind: "refused", code });
      refusals.push(await ask(server));
    }

    for (const refused of refusals) {
      assert.equal(refused.statusCode, 401, refused.body);
      assert.deepEqual(refused.json(), refusalBody);
      assert.equal(refused.body, existingRefusal);
    }
  });

  it("names every registered scheme in the challenge", async () => {
    const { server } = await guarded();
    server.registerAuth(fakeAuth("Bearer"));

    assert.equal((await ask(server)).headers["www-authenticate"], "Bearer");

    const both = await guarded();
    both.server.registerAuth(fakeAuth("Bearer"));
    both.server.registerAuth(fakeAuth("Nostr"));
    assert.equal((await ask(both.server)).headers["www-authenticate"], "Bearer, Nostr");
  });

  it("marks the refusing scheme with its code, and marks no other", async () => {
    const { server } = await guarded();
    const bearer = fakeAuth("Bearer");
    const nostr = fakeAuth("Nostr");
    server.registerAuth(bearer);
    server.registerAuth(nostr);

    bearer.answers({ kind: "refused", code: "invalid_request" });
    assert.equal(
      (await ask(server)).headers["www-authenticate"],
      'Bearer error="invalid_request", Nostr',
    );

    bearer.answers({ kind: "absent" });
    nostr.answers({ kind: "refused", code: "invalid_token" });
    assert.equal(
      (await ask(server)).headers["www-authenticate"],
      'Bearer, Nostr error="invalid_token"',
    );
  });

  it("writes the detail to the Logger and to nothing else", async () => {
    const { server, warned } = await guarded();
    const detail = "the u tag named http://proxy.invalid/ops/whoami";
    server.registerAuth(fakeAuth("Nostr", { kind: "refused", code: "invalid_token", detail }));

    const refused = await ask(server);
    assert.equal(refused.statusCode, 401);

    assert.equal(warned.length, 1);
    assert.deepEqual(warned[0]?.fields, {
      scheme: "Nostr",
      code: "invalid_token",
      detail,
    });

    assert.equal(refused.body, existingRefusal);
    assert.ok(
      !JSON.stringify(refused.headers).includes("u tag"),
      `the detail reached a header: ${JSON.stringify(refused.headers)}`,
    );
  });

  it("says nothing to the Logger about a refusal that carried no detail", async () => {
    const { server, warned } = await guarded();
    server.registerAuth(fakeAuth("Bearer", { kind: "refused", code: "invalid_token" }));

    assert.equal((await ask(server)).statusCode, 401);
    assert.deepEqual(warned, []);
  });
});

describe("a server no Auth registered with", () => {
  it("throws rather than refusing, so a wiring mistake is not a credential problem", async () => {
    const { server, thrown } = await guarded();

    const answered = await ask(server, "Bearer a-perfectly-good-token");
    assert.equal(answered.statusCode, 500, answered.body);
    assert.notEqual(answered.statusCode, 401);

    assert.equal(thrown.length, 1);
    const error = thrown[0];
    assert.ok(error instanceof NoAuthRegisteredError, `not the wiring error: ${String(error)}`);
    assert.match(error.message, /GET \/ops\/whoami/);
    assert.equal(error.name, "NoAuthRegisteredError");

    server.registerAuth(admits("Bearer", admitted));
    assert.equal((await ask(server)).statusCode, 200);
  });
});

describe("the Operator's own routes", () => {
  it("reads the User from a sibling encapsulated plugin", async () => {
    const { server } = await guarded();
    server.registerAuth(admits("Bearer", admitted));

    const answered = await ask(server);
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { asked: admitted.id });
  });

  it("reads it from a plugin inside that plugin, on a route with a body", async () => {
    const { server } = await guarded();
    server.registerAuth(
      fakeAuth("Nostr", (request) =>
        request.headers.authorization?.startsWith("Nostr ") === true
          ? { kind: "authenticated", user: other }
          : { kind: "absent" },
      ),
    );

    const answered = await server.fastify.inject({
      method: "POST",
      url: `${ops}/deep/ask`,
      headers: { authorization: "Nostr an-event" },
      payload: { text: "what happened?" },
    });
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { by: other.id, said: "what happened?" });

    const refused = await server.fastify.inject({
      method: "POST",
      url: `${ops}/deep/ask`,
      headers: { authorization: "Basic aGk6dGhlcmU=" },
      payload: { text: "what happened?" },
    });
    assert.equal(refused.statusCode, 401, refused.body);
    assert.equal(refused.headers["www-authenticate"], "Nostr");
  });

  it("authenticates a route that was registered before the Auth was", async () => {
    const { server } = await guarded();
    await server.fastify.ready();

    server.registerAuth(admits("Bearer", admitted));
    assert.deepEqual((await ask(server)).json(), { asked: admitted.id });

    const nostr = admits("Nostr", other);
    server.registerAuth(nostr);
    assert.deepEqual((await ask(server)).json(), { asked: admitted.id });
    assert.equal(nostr.asked.length, 0);
  });
});
