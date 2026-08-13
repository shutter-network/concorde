/**
 * A password traded for a Token, at this component's own route.
 *
 * The subject is what a client sees: `POST /auth/tokens`, the record it answers with, and the
 * refusals it does not explain. Everything is observed over HTTP against a real Fastify instance
 * and real PostgreSQL. No hash, no column and no internal call is asserted on anywhere.
 *
 * Two tests carry more than they look:
 *
 *  - `answers the shape trusted code mints, field for field` is the round trip. A response schema
 *    is a serializer, so a field added to `IssuedToken` and forgotten in the schema is dropped
 *    from the wire with no warning anywhere. The in-process half is `issueToken`, which builds
 *    the same record without a schema in front of it, so the two disagree the moment one drifts.
 *  - `costs a miss what it costs a hit` is the enumeration defence in its weakest observable
 *    form: nothing here measures time, but a login against an id nobody holds must still derive
 *    a digest, and the only thing a test can see is that it is refused rather than answered
 *    faster with a 404.
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

/** A cost nobody should deploy, legitimate because each digest carries its own. */
const cheap = { logN: 12, blockSize: 8, parallelism: 1 } as const;

const password = "correct horse battery staple";

/** Where a server that is never started would have listened, had it been. */
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
  // No Public server on Users: this component registers the route group at `/auth`, and Fastify
  // refuses the second registration of one path.
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
        asked: request.safUser.id,
      }));
    },
    { prefix: "/ops" },
  );
});

after(async () => {
  await publicServer.stop();
  await database.drop();
});

/**
 * A User who can log in, admitted the way an Operator admits one: two writes in one transaction,
 * so a User nobody can log in as never reaches the table.
 */
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

/** One login that is expected to succeed. */
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

    // 201 and not 200: the Token is a resource this request created.
    assert.deepEqual(issued.user, user);
    assert.ok(issued.token.startsWith("saf_"), issued.token);
    // ISO 8601 exactly, because JSON has no date and a client has to compare it.
    assert.equal(new Date(issued.expiresAt).toISOString(), issued.expiresAt);
    // The lifetime is the component's, and it is in the future.
    assert.ok(Date.parse(issued.expiresAt) > Date.now(), issued.expiresAt);
  });

  it("answers the shape trusted code mints, field for field", async () => {
    // The round trip. `issueToken` builds the record in process with no schema in front of it,
    // and the route builds the same record through one. A field added to `IssuedToken` and
    // forgotten in the response schema is a key on one side and not on the other.
    const user = await admit();
    const minted = await db.tx((tx) => passwordAuth.issueToken(tx, user.id));
    const issued = await logIn(user.id);

    assert.deepEqual(Object.keys(issued).sort(), Object.keys(minted).sort());
    assert.deepEqual(issued, {
      // Minted per issue, so the two differ, and the length is what a truncating schema fails.
      token: issued.token,
      expiresAt: issued.expiresAt,
      // The whole User, embedded, and byte for byte the record the Users component answers with.
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

    // Both work, which is a browser and a script coexisting.
    for (const issued of [first, second]) {
      assert.equal((await whoami(issued.token)).statusCode, 200);
    }
  });

  it("costs a miss what it costs a hit", async () => {
    // A well-formed id nobody holds is a 401 and not a 404, and a User with no password row is
    // the same 401. Neither answers whether the id is real.
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
    // A 400 says the request was wrong, and a 401 says the credential was. An id that is not a
    // uuid is the first, because PostgreSQL refuses to cast one and nobody holds it either way.
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
    assert.match(refused.json<{ message: string }>().message, /not a parameter of this route/);
    assert.match(refused.json<{ message: string }>().message, /never in a URL/);
  });
});

describe("issuing a Token from trusted code", () => {
  it("hands a Token to a User created in the same transaction", async () => {
    // The read is on the caller's handle, so the User the transaction has not committed yet is
    // found and the record answered with is the record that transaction will commit.
    const issued = await db.tx(async (tx) => {
      const user = await users.create(tx);
      return passwordAuth.issueToken(tx, user.id);
    });

    assert.equal((await whoami(issued.token)).statusCode, 200);
    // And that User never had a password: issuance is the extension point, not the login.
    const refused = await postTokens({ user: issued.user.id, password });
    assert.equal(refused.statusCode, 401, refused.body);
  });

  it("throws when no User has that id, and writes nothing", async () => {
    const nobody = "00000000-0000-4000-8000-000000000001";
    await assert.rejects(
      () => db.tx((tx) => passwordAuth.issueToken(tx, nobody)),
      /no User 00000000-0000-4000-8000-000000000001 exists/,
    );
    await assert.rejects(
      () => db.tx((tx) => passwordAuth.setPassword(tx, nobody, password)),
      /no User 00000000-0000-4000-8000-000000000001 exists/,
    );
  });

  it("replaces a password without revoking anything", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    await db.tx((tx) => passwordAuth.setPassword(tx, user.id, "a new one, chosen by the Operator"));

    // The old password stops working and the new one starts. The Token in hand is untouched,
    // which is why locking somebody out takes a `revoke` as well.
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

    // Neither the User nor the password survived, so a crash cannot leave a credential without
    // the identity it names.
    assert.equal(await users.get(admitted.id), undefined);
    assert.equal((await postTokens({ user: admitted.id, password })).statusCode, 401);
  });
});

/**
 * A route of the Operator's own behind the server's composed hook, which is the only thing in
 * this file that reads a Token. It is here so that "the Token works" is observed where an
 * Operator observes it, and so that nothing in this file has to revoke a Token to prove one.
 */
function whoami(token: string) {
  return publicServer.fastify.inject({
    method: "GET",
    url: "/ops/whoami",
    headers: { authorization: `Bearer ${token}` },
  });
}
