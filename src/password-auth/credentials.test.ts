/**
 * What a User may do to their own credential: change the password, drop the Token in hand, and
 * drop every Token they hold.
 *
 * The subject is the three routes below the login, observed over HTTP against a real Fastify
 * instance and real PostgreSQL. Every Token in this file was obtained by logging in, and no hash,
 * no column and no internal call is asserted on anywhere.
 *
 * Two tests carry more than they look:
 *
 *  - `changes the password of the authenticated User and of nobody else` is the reason the route
 *    has no `user` field. There is no check to get wrong because there is no parameter to check:
 *    a `user` written into the body is stripped before the handler and reaches nothing.
 *  - `logs a device out without ending the session doing it` is the whole difference between the
 *    two revocations, and it is a difference a client would otherwise have to discover.
 *
 * A database of this file's own, because no two test files may share one, and a deliberately
 * cheap scrypt cost, because every Token here starts with a login.
 */

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
  database = await createTestDatabase("password_auth_credentials");
  db = database.db;
  await applySchema(db, usersSchema, passwordAuthSchema);

  publicServer = serverComponent(Fastify(), nowhere);
  users = createUsers({ db });
  passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl: hour, scrypt: cheap });

  // One route of the Operator's own behind the server's composed hook, so that "this Token still
  // works" is asked where an Operator asks it.
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

async function logIn(user: string, secret = password): Promise<IssuedToken> {
  const response = await publicServer.fastify.inject({
    method: "POST",
    url: "/auth/tokens",
    payload: { user, password: secret },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<IssuedToken>();
}

/** Whether a Token still authenticates, asked at the Operator's own route. */
async function works(token: string): Promise<boolean> {
  const answered = await publicServer.fastify.inject({
    method: "GET",
    url: "/ops/whoami",
    headers: { authorization: `Bearer ${token}` },
  });
  return answered.statusCode === 200;
}

function bearing(method: "PUT" | "DELETE", url: string, token: string, payload?: object) {
  return publicServer.fastify.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe("PUT /auth/password", () => {
  it("changes the password of the authenticated User and of nobody else", async () => {
    const mine = await admit();
    const theirs = await admit();
    const issued = await logIn(mine.id);

    // A `user` field in the body is stripped before the handler, so writing somebody else's id
    // changes nothing about whose password this is.
    const changed = await bearing("PUT", "/auth/password", issued.token, {
      user: theirs.id,
      currentPassword: password,
      newPassword: "a chosen phrase",
    });
    assert.equal(changed.statusCode, 204, changed.body);
    assert.equal(changed.body, "");

    await logIn(mine.id, "a chosen phrase");
    // And theirs is untouched, which is what a `user` field would have broken.
    await logIn(theirs.id, password);
  });

  it("revokes nothing, so every Token issued before it still works", async () => {
    const user = await admit();
    const first = await logIn(user.id);
    const second = await logIn(user.id);

    assert.equal(
      (
        await bearing("PUT", "/auth/password", first.token, {
          currentPassword: password,
          newPassword: "rotated",
        })
      ).statusCode,
      204,
    );

    // Both Tokens, the presented one included. A User who changed their password out of fear is
    // served by the other route.
    assert.ok(await works(first.token));
    assert.ok(await works(second.token));
  });

  it("refuses a wrong current password with the same 401 a wrong login gets", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    const refused = await bearing("PUT", "/auth/password", issued.token, {
      currentPassword: "not the password",
      newPassword: "rotated",
    });
    assert.equal(refused.statusCode, 401, refused.body);
    // The old password still works, so the refusal changed nothing.
    await logIn(user.id, password);
  });

  it("refuses a User with no password, having nothing for them to prove", async () => {
    // Their Token is an ordinary Token, minted by trusted code, so the route authenticates them
    // and then finds nothing to verify the current password against.
    const issued = await db.tx(async (tx) => {
      const user = await users.create(tx);
      return passwordAuth.issueToken(tx, user.id);
    });

    const refused = await bearing("PUT", "/auth/password", issued.token, {
      currentPassword: password,
      newPassword: "rotated",
    });
    assert.equal(refused.statusCode, 401, refused.body);
    // And they still have none: this route is not how a first password arrives.
    assert.equal(
      (
        await publicServer.fastify.inject({
          method: "POST",
          url: "/auth/tokens",
          payload: { user: issued.user.id, password: "rotated" },
        })
      ).statusCode,
      401,
    );
  });

  it("refuses a body that is missing or out of bounds with a 400", async () => {
    const issued = await logIn((await admit()).id);
    for (const payload of [
      { currentPassword: password },
      { currentPassword: password, newPassword: "" },
      { currentPassword: password, newPassword: "x".repeat(1025) },
    ]) {
      const refused = await bearing("PUT", "/auth/password", issued.token, payload);
      assert.equal(refused.statusCode, 400, refused.body);
    }
  });
});

describe("DELETE /auth/tokens/current", () => {
  it("logs a device out without ending the session doing it", async () => {
    const user = await admit();
    const phone = await logIn(user.id);
    const laptop = await logIn(user.id);

    const dropped = await bearing("DELETE", "/auth/tokens/current", phone.token);
    assert.equal(dropped.statusCode, 204, dropped.body);
    assert.equal(dropped.body, "");

    assert.equal(await works(phone.token), false);
    // The whole point: the Token that did the revoking is not the Token revoked.
    assert.ok(await works(laptop.token));
  });

  it("is idempotent, and a revoked Token cannot revoke again", async () => {
    const issued = await logIn((await admit()).id);
    assert.equal((await bearing("DELETE", "/auth/tokens/current", issued.token)).statusCode, 204);
    // The second call has no credential the server accepts, so it is the ordinary 401 rather
    // than a 404 about a row.
    assert.equal((await bearing("DELETE", "/auth/tokens/current", issued.token)).statusCode, 401);
  });
});

describe("DELETE /auth/tokens", () => {
  it("drops every Token of the authenticated User, the presented one included", async () => {
    const user = await admit();
    const phone = await logIn(user.id);
    const laptop = await logIn(user.id);
    const somebodyElse = await logIn((await admit()).id);

    const dropped = await bearing("DELETE", "/auth/tokens", phone.token);
    assert.equal(dropped.statusCode, 204, dropped.body);
    assert.equal(dropped.body, "");

    assert.equal(await works(phone.token), false);
    assert.equal(await works(laptop.token), false);
    // One User's revocation is one User's, which is what the route having no parameter buys.
    assert.ok(await works(somebodyElse.token));
  });

  it("leaves the password working, so a new Token is one login away", async () => {
    const user = await admit();
    assert.equal(
      (await bearing("DELETE", "/auth/tokens", (await logIn(user.id)).token)).statusCode,
      204,
    );

    // Revoking is not locking out. An Operator who means to lock somebody out replaces the
    // password first and revokes second.
    assert.ok(await works((await logIn(user.id)).token));
  });
});

describe("revoking from trusted code", () => {
  it("drops every Token of one User and answers nothing", async () => {
    const user = await admit();
    const first = await logIn(user.id);
    const second = await logIn(user.id);

    assert.equal(await db.tx((tx) => passwordAuth.revoke(tx, user.id)), undefined);
    assert.equal(await works(first.token), false);
    assert.equal(await works(second.token), false);

    // Idempotent, and a User nobody holds is not an error: there is nothing there to remove.
    await db.tx((tx) => passwordAuth.revoke(tx, user.id));
    await db.tx((tx) => passwordAuth.revoke(tx, "00000000-0000-4000-8000-000000000000"));
  });

  it("keeps working Tokens working when the caller's transaction rolls back", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    await assert.rejects(
      db.tx(async (tx) => {
        await passwordAuth.revoke(tx, user.id);
        throw new Error("the Operator changed their mind");
      }),
    );
    assert.ok(await works(issued.token));
  });
});
