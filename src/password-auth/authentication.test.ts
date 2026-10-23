import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import type { LogFields, Logger } from "../logging/logging.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { type FakeAuth, fakeAuth } from "../test-support/fake-auth.ts";
import type { UserRecord } from "../users/routes.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createPasswordAuth, type PasswordAuth } from "./password-auth.ts";
import type { IssuedToken } from "./routes.ts";
import * as passwordAuthSchema from "./schema/index.ts";

const hour = 60 * 60 * 1000;
const cheap = { logN: 12, blockSize: 8, parallelism: 1 } as const;
const password = "correct horse battery staple";
const nowhere = { port: 0, host: "127.0.0.1" } as const;

const ops = "/ops";

type LogLine = { readonly fields: LogFields; readonly message: string };

let database: TestDatabase;
let db: Db;
let users: Users;
let passwordAuth: PasswordAuth;
let publicServer: ServerComponent<FastifyInstance>;
let secondScheme: FakeAuth;
const warned: LogLine[] = [];

const built: ServerComponent<FastifyInstance>[] = [];

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (fields, message) => void warned.push({ fields, message }),
  error: () => {},
};

const operatorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/whoami", { preHandler: publicServer.requireUser }, async (request) => ({
    asked: request.concordeUser.id,
  }));

  await fastify.register(
    async (inner) => {
      inner.post<{ Body: { text: string } }>(
        "/ask",
        { preHandler: publicServer.requireUser },
        async (request) => ({ by: request.concordeUser.id, said: request.body.text }),
      );
    },
    { prefix: "/deep" },
  );

  fastify.get("/unguarded", async (request) => request.concordeUser);
  fastify.get("/unguarded-id", async (request) => ({ id: request.concordeUser.id }));
};

before(async () => {
  database = await createTestDatabase("password_auth_authentication");
  db = database.db;
  await applySchema(db, usersSchema, passwordAuthSchema);

  publicServer = serverComponent(Fastify(), nowhere, { logger });
  built.push(publicServer);
  users = createUsers({ db });
  passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl: hour, scrypt: cheap });

  secondScheme = fakeAuth("Nostr");
  publicServer.registerAuth(secondScheme);

  await publicServer.fastify.register(operatorRoutes, { prefix: ops });
});

after(async () => {
  for (const server of built) await server.stop();
  await database.drop();
});

async function admit(): Promise<UserRecord> {
  return db.tx(async (tx) => {
    const user = await users.create(tx);
    await passwordAuth.setPassword(tx, user.id, password);
    return user;
  });
}

async function logIn(user: string, server = () => publicServer.fastify): Promise<IssuedToken> {
  const response = await server().inject({
    method: "POST",
    url: "/auth/tokens",
    payload: { user, password },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<IssuedToken>();
}

function ask(authorization?: string) {
  return publicServer.fastify.inject(
    authorization === undefined
      ? { method: "GET", url: `${ops}/whoami` }
      : { method: "GET", url: `${ops}/whoami`, headers: { authorization } },
  );
}

function bearing(token: string) {
  return ask(`Bearer ${token}`);
}

describe("authenticating a request", () => {
  it("names the User the presented Token belongs to", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    const alreadyAsked = secondScheme.asked.length;
    const answered = await bearing(issued.token);
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { asked: user.id });
    assert.equal(secondScheme.asked.length, alreadyAsked);
  });

  it("takes the scheme however the client capitalised it, and nothing else", async () => {
    const issued = await logIn((await admit()).id);

    for (const header of [
      `Bearer ${issued.token}`,
      `bearer ${issued.token}`,
      `BEARER ${issued.token}`,
      `Bearer  ${issued.token}`,
    ]) {
      assert.equal((await ask(header)).statusCode, 200, header);
    }
  });

  it("tells one User's Token from another's", async () => {
    const first = await admit();
    const second = await admit();
    const forFirst = await logIn(first.id);
    const forSecond = await logIn(second.id);

    assert.deepEqual((await bearing(forFirst.token)).json(), { asked: first.id });
    assert.deepEqual((await bearing(forSecond.token)).json(), { asked: second.id });
  });

  it("reads the User from a sibling encapsulated plugin", async () => {
    const user = await admit();
    const issued = await logIn(user.id);
    assert.deepEqual((await bearing(issued.token)).json(), { asked: user.id });

    const deeper = await publicServer.fastify.inject({
      method: "POST",
      url: `${ops}/deep/ask`,
      headers: { authorization: `Bearer ${issued.token}` },
      payload: { text: "what happened?" },
    });
    assert.equal(deeper.statusCode, 200, deeper.body);
    assert.deepEqual(deeper.json(), { by: user.id, said: "what happened?" });
  });
});

describe("a route of the Operator's own", () => {
  it("serves nothing to a route that forgot the preHandler", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    const answered = await unguarded("/unguarded", `Bearer ${issued.token}`);
    assert.equal(answered.statusCode, 200, answered.body);
    assert.equal(answered.body, "", "a route without the preHandler has No user to answer with");

    const threw = await unguarded("/unguarded-id", `Bearer ${issued.token}`);
    assert.equal(threw.statusCode, 500, threw.body);

    assert.equal((await unguarded("/unguarded")).body, "");
    assert.equal((await unguarded("/unguarded-id")).statusCode, 500);

    for (const response of [answered, threw]) {
      assert.ok(!response.body.includes(user.id), `a User leaked: ${response.body}`);
    }
  });
});

describe("the three outcomes", () => {
  it("falls through to the next scheme rather than refusing on its behalf", async () => {
    const user = await admit();
    const alreadyAsked = secondScheme.asked.length;
    secondScheme.answers({ kind: "authenticated", user });
    try {
      for (const header of [undefined, "Nostr an-event", "Basic aGk6dGhlcmU="]) {
        const answered = await ask(header);
        assert.equal(answered.statusCode, 200, `${header}: ${answered.body}`);
        assert.deepEqual(answered.json(), { asked: user.id });
      }
      assert.equal(secondScheme.asked.length, alreadyAsked + 3);
    } finally {
      secondScheme.answers({ kind: "absent" });
    }
  });

  it("shuts the schemes behind it out when its own credential failed", async () => {
    const user = await admit();
    const alreadyAsked = secondScheme.asked.length;
    secondScheme.answers({ kind: "authenticated", user });
    try {
      const refused = await bearing("concorde_not-a-token");
      assert.equal(refused.statusCode, 401, refused.body);
      assert.equal(secondScheme.asked.length, alreadyAsked);
    } finally {
      secondScheme.answers({ kind: "absent" });
    }
  });

  it("tells a broken header apart from a bad Token, in the log and in the challenge", async () => {
    warned.length = 0;

    const malformed = await ask("Bearer");
    assert.equal(malformed.statusCode, 401, malformed.body);
    assert.equal(malformed.headers["www-authenticate"], 'Bearer error="invalid_request", Nostr');
    assert.equal(warned.length, 1);
    assert.deepEqual(warned[0]?.fields, {
      scheme: "Bearer",
      code: "invalid_request",
      detail: "Missing token after Bearer in the Authorization header",
    });

    warned.length = 0;
    const refused = await bearing("concorde_not-a-token");
    assert.equal(refused.headers["www-authenticate"], 'Bearer error="invalid_token", Nostr');
    assert.deepEqual(warned, []);

    for (const answered of [malformed, refused]) {
      assert.ok(
        !JSON.stringify([answered.body, answered.headers]).includes("carried no token"),
        `the detail reached the client: ${answered.body}`,
      );
    }
  });
});

describe("refusing a request", () => {
  it("answers every kind of refusal identically", async () => {
    const user = await admit();
    const issued = await logIn(user.id);
    const withoutAPassword = await db.tx((tx) => users.create(tx));

    const briefly = serverComponent(Fastify(), nowhere, { logger });
    built.push(briefly);
    createPasswordAuth({ db, users, publicServer: briefly, tokenTtl: 1, scrypt: cheap });
    const expired = (await logIn(user.id, () => briefly.fastify)).token;

    const refusals = [
      await ask(),
      await ask(`Basic ${Buffer.from(`${user.id}:${password}`).toString("base64")}`),
      await ask("Bearer"),
      await ask("Bearer "),
      await ask("Bearer not-a-token"),
      await bearing(`concorde_${"A".repeat(43)}`),
      await bearing(expired),
      await bearing(`${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`),
      await login({ user: user.id, password: "not the password" }),
      await login({ user: "00000000-0000-4000-8000-000000000000", password }),
      await login({ user: withoutAPassword.id, password }),
      await publicServer.fastify.inject({
        method: "PUT",
        url: "/auth/password",
        headers: { authorization: `Bearer ${issued.token}` },
        payload: { currentPassword: "not the password", newPassword: "rotated" },
      }),
    ];

    for (const refused of refusals) {
      assert.equal(refused.statusCode, 401, refused.body);
      assert.deepEqual(refused.json(), {
        statusCode: 401,
        error: "Unauthorized",
        message: "authentication failed",
      });
    }

    const [first, ...rest] = refusals;
    assert.ok(first !== undefined);
    for (const refused of rest) assert.equal(refused.body, first.body);

    for (const composed of refusals.slice(0, 8)) {
      assert.match(String(composed.headers["www-authenticate"]), /^Bearer.*Nostr$/);
    }
    for (const ownRefusal of refusals.slice(8)) {
      assert.equal(ownRefusal.headers["www-authenticate"], undefined);
    }
    assert.deepEqual(refusals[9]?.headers, refusals[8]?.headers);
    assert.deepEqual(refusals[10]?.headers, refusals[8]?.headers);

    assert.equal((await bearing(issued.token)).statusCode, 200);
  });

  it("refuses an expired Token where it was issued too", async () => {
    const server = serverComponent(Fastify(), nowhere, { logger });
    built.push(server);
    createPasswordAuth({ db, users, publicServer: server, tokenTtl: 1, scrypt: cheap });
    await server.fastify.register(
      async (fastify) => {
        fastify.get("/whoami", { preHandler: server.requireUser }, async (request) => ({
          asked: request.concordeUser.id,
        }));
      },
      { prefix: ops },
    );

    const user = await admit();
    const issued = await logIn(user.id, () => server.fastify);
    assert.ok(Date.parse(issued.expiresAt) <= Date.now() + 1000, issued.expiresAt);

    const refused = await server.fastify.inject({
      method: "GET",
      url: `${ops}/whoami`,
      headers: { authorization: `Bearer ${issued.token}` },
    });
    assert.equal(refused.statusCode, 401, refused.body);

    assert.equal((await bearing((await logIn(user.id)).token)).statusCode, 200);
  });
});

function unguarded(path: string, authorization?: string) {
  return publicServer.fastify.inject(
    authorization === undefined
      ? { method: "GET", url: `${ops}${path}` }
      : { method: "GET", url: `${ops}${path}`, headers: { authorization } },
  );
}

function login(payload: Record<string, unknown>) {
  return publicServer.fastify.inject({ method: "POST", url: "/auth/tokens", payload });
}
