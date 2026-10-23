import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
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

let database: TestDatabase;
let db: Db;
let users: Users;
let passwordAuth: PasswordAuth;
let publicServer: ServerComponent<FastifyInstance>;

before(async () => {
  database = await createTestDatabase("password_auth_login");
  db = database.db;
  await applySchema(db, usersSchema, passwordAuthSchema);

  publicServer = serverComponent(Fastify(), nowhere);
  users = createUsers({ db });
  passwordAuth = createPasswordAuth({
    db,
    users,
    publicServer,
    tokenTtl: hour,
    scrypt: cheap,
  });

  await publicServer.fastify.register(
    async (fastify) => {
      fastify.get("/whoami", { preHandler: publicServer.requireUser }, async (request) => ({
        asked: request.concordeUser.id,
      }));
    },
    { prefix: "/ops" },
  );
});

after(async () => {
  await publicServer.stop();
  await database.drop();
});

async function admit(secret = password): Promise<UserRecord> {
  return db.tx(async (tx) => {
    const user = await users.create(tx);
    await passwordAuth.setPassword(tx, user.id, secret);
    return user;
  });
}

function postTokens(payload: Record<string, unknown>) {
  return publicServer.fastify.inject({ method: "POST", url: "/auth/tokens", payload });
}

async function logIn(user: string, secret = password): Promise<IssuedToken> {
  const response = await postTokens({ user, password: secret });
  assert.equal(
    response.statusCode,
    201,
    `POST /auth/tokens should have answered: ${response.body}`,
  );
  return response.json<IssuedToken>();
}

describe("POST /auth/tokens", () => {
  it("answers 201 with a Token, its expiry and the whole User", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    assert.deepEqual(issued.user, user);
    assert.ok(issued.token.startsWith("concorde_"), issued.token);
    assert.equal(new Date(issued.expiresAt).toISOString(), issued.expiresAt);
    assert.ok(Date.parse(issued.expiresAt) > Date.now(), issued.expiresAt);
  });

  it("answers the shape trusted code mints, field for field", async () => {
    const user = await admit();
    const minted = await db.tx((tx) => passwordAuth.issueToken(tx, user.id));
    const issued = await logIn(user.id);

    assert.deepEqual(Object.keys(issued).sort(), Object.keys(minted).sort());
    assert.deepEqual(issued, {
      token: issued.token,
      expiresAt: issued.expiresAt,
      user,
    } satisfies IssuedToken);
    assert.equal(issued.token.length, minted.token.length);
    assert.notEqual(issued.token, minted.token);
    assert.deepEqual(minted.user, user);
  });

  it("mints a new Token every time and displaces none", async () => {
    const user = await admit();
    const first = await logIn(user.id);
    const second = await logIn(user.id);
    assert.notEqual(first.token, second.token);

    for (const issued of [first, second]) {
      assert.equal((await whoami(issued.token)).statusCode, 200);
    }
  });

  it("costs a miss what it costs a hit", async () => {
    const nobody = "00000000-0000-4000-8000-000000000000";
    const withoutOne = await db.tx((tx) => users.create(tx));

    for (const attempt of [
      await postTokens({ user: nobody, password }),
      await postTokens({ user: withoutOne.id, password }),
      await postTokens({ user: (await admit()).id, password: "not the password" }),
    ]) {
      assert.equal(attempt.statusCode, 401, attempt.body);
    }
  });

  it("refuses a malformed body with a 400 rather than a 401", async () => {
    for (const payload of [
      { user: "not-a-uuid", password },
      { user: (await admit()).id },
      { user: (await admit()).id, password: "" },
      { user: (await admit()).id, password: "x".repeat(1025) },
    ]) {
      const refused = await postTokens(payload);
      assert.equal(refused.statusCode, 400, refused.body);
    }
  });

  it("refuses a query parameter rather than answering it", async () => {
    const user = await admit();
    const refused = await publicServer.fastify.inject({
      method: "POST",
      url: `/auth/tokens?user=${user.id}`,
      payload: { user: user.id, password },
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.match(refused.json<{ message: string }>().message, /Unknown query parameter/);
    assert.match(refused.json<{ message: string }>().message, /not in query parameters/);
  });
});

describe("issuing a Token from trusted code", () => {
  it("hands a Token to a User created in the same transaction", async () => {
    const issued = await db.tx(async (tx) => {
      const user = await users.create(tx);
      return passwordAuth.issueToken(tx, user.id);
    });

    assert.equal((await whoami(issued.token)).statusCode, 200);
    const refused = await postTokens({ user: issued.user.id, password });
    assert.equal(refused.statusCode, 401, refused.body);
  });

  it("throws when No user has that id, and writes nothing", async () => {
    const nobody = "00000000-0000-4000-8000-000000000001";
    await assert.rejects(
      () => db.tx((tx) => passwordAuth.issueToken(tx, nobody)),
      /No user 00000000-0000-4000-8000-000000000001 exists/,
    );
    await assert.rejects(
      () => db.tx((tx) => passwordAuth.setPassword(tx, nobody, password)),
      /No user 00000000-0000-4000-8000-000000000001 exists/,
    );
  });

  it("replaces a password without revoking anything", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    await db.tx((tx) => passwordAuth.setPassword(tx, user.id, "a new one, chosen by the Operator"));

    assert.equal((await postTokens({ user: user.id, password })).statusCode, 401);
    await logIn(user.id, "a new one, chosen by the Operator");
    assert.equal((await whoami(issued.token)).statusCode, 200);
  });

  it("gives a password to a User who had none", async () => {
    const user = await db.tx((tx) => users.create(tx));
    assert.equal((await postTokens({ user: user.id, password })).statusCode, 401);

    await db.tx((tx) => passwordAuth.setPassword(tx, user.id, password));
    assert.deepEqual((await logIn(user.id)).user, user);
  });

  it("admits nobody when the caller's transaction rolls back", async () => {
    let admitted: UserRecord | undefined;
    await assert.rejects(
      db.tx(async (tx) => {
        admitted = await users.create(tx);
        await passwordAuth.setPassword(tx, admitted.id, password);
        throw new Error("the Operator changed their mind");
      }),
    );
    assert.ok(admitted !== undefined);

    assert.equal(await users.get(admitted.id), undefined);
    assert.equal((await postTokens({ user: admitted.id, password })).statusCode, 401);
  });
});

function whoami(token: string) {
  return publicServer.fastify.inject({
    method: "GET",
    url: "/ops/whoami",
    headers: { authorization: `Bearer ${token}` },
  });
}
