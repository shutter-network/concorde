/**
 * A Token authenticating a request, on our route and on anyone else's.
 *
 * The subject is the integration surface: `users.requireUser` as one option on a
 * route, and `request.safUser` in the handler. Everything is observed over HTTP
 * against real Fastify instances and real PostgreSQL — no hash, no column, and no
 * internal call is asserted on anywhere, and every Token in this file was obtained by
 * logging in.
 *
 * Three tests carry more than they look:
 *
 *  - `reads the User from a sibling encapsulated plugin` is **the test the whole
 *    design exists for**. The User is assigned by a plain property write rather than
 *    declared with `decorateRequest`, because a decoration is scoped to the plugin
 *    instance that made it and escaping that scope means `fastify-plugin` and
 *    `skip-override`, which silently ignores the prefix passed to `register`
 *    (ADR-0030). The Operator's plugin here is exactly the sibling that would not see
 *    it, and the Messenger will be another.
 *  - `answers every kind of refusal identically` compares bodies byte for byte, and
 *    includes the 401 a **wrong password** gets, because the claim is one refusal
 *    across the whole surface and not one per route.
 *  - `serves nothing to a route that forgot the preHandler` records what actually
 *    happens rather than what would be nice. Nothing is protected by default, and the
 *    type cannot say "set only after `requireUser` ran" (ADR-0030), so the failure
 *    mode is pinned here.
 *
 * A database of this file's own, because no two test files may share one, and a
 * deliberately cheap scrypt cost, because every Token here starts with a login.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import type { Db } from "../db/index.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { usersMigrations } from "./migrations.ts";
import type { UserRecord } from "./routes.ts";
import type { ScryptParameters } from "./secrets.ts";
import { createUsers, type Users } from "./users.ts";

/** What a login answers with, as a client parses it. */
type IssuedToken = {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: UserRecord;
};

const hour = 60 * 60 * 1000;

/** A cost nobody should deploy, legitimate because each digest carries its own. */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

const password = "correct horse battery staple";

/** The prefixes the Operator chose, and the second one that proves they are theirs. */
const auth = "/auth";
const alsoAt = "/sign-in";
/** Where the Operator put routes of their own: a sibling of ours, on the same server. */
const ops = "/ops";

let database: TestDatabase;
let db: Db;
let directory: Users;
let agentServer: FastifyInstance;
let publicServer: FastifyInstance;

/**
 * Routes of the Operator's own, in a plugin of the Operator's own.
 *
 * This is the shape the quickstart documents and the shape the Messenger will have:
 * an ordinary encapsulated Fastify plugin, registered beside ours under a prefix of
 * its own, taking `users.requireUser` as one route option and reading `request.safUser`
 * with **no cast** — the augmentation the package ships is what makes the line below
 * compile.
 */
const operatorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/whoami", { preHandler: directory.requireUser }, async (request) => ({
    asked: request.safUser.id,
  }));

  // The same thing one level deeper, because encapsulation nests: a plugin inside the
  // Operator's plugin is further still from the plugin instance a `decorateRequest`
  // would have been scoped to.
  await fastify.register(
    async (inner) => {
      inner.post<{ Body: { text: string } }>(
        "/ask",
        { preHandler: directory.requireUser },
        async (request) => ({ by: request.safUser.id, said: request.body.text }),
      );
    },
    { prefix: "/deep" },
  );

  // And two routes that forgot it, which is the failure mode this file records. One
  // answers the property, the other reaches through it.
  fastify.get("/unguarded", async (request) => request.safUser);
  fastify.get("/unguarded-id", async (request) => ({ id: request.safUser.id }));
};

before(async () => {
  database = await createTestDatabase("users_authentication");
  db = database.db;
  db.registerMigrations(usersMigrations);
  await db.migrate();

  directory = createUsers({ db, tokenTtl: hour, scrypt: cheap });

  agentServer = Fastify();
  await agentServer.register(directory.agentRoutes, { prefix: "/users" });

  publicServer = Fastify();
  await publicServer.register(directory.publicRoutes, { prefix: auth });
  await publicServer.register(directory.publicRoutes, { prefix: alsoAt });
  await publicServer.register(operatorRoutes, { prefix: ops });
});

after(async () => {
  await agentServer.close();
  await publicServer.close();
  await database.drop();
});

/** Creates a User over the Agent server, with a password to log in with. */
async function admit(): Promise<UserRecord> {
  const response = await agentServer.inject({
    method: "POST",
    url: "/users",
    payload: { password },
  });
  assert.equal(response.statusCode, 201, `POST /users should have answered: ${response.body}`);
  return response.json<UserRecord>();
}

/** One login that is expected to succeed, on whichever server the caller names. */
async function logIn(user: string, at = auth, server = () => publicServer): Promise<IssuedToken> {
  const response = await server().inject({
    method: "POST",
    url: `${at}/tokens`,
    payload: { user, password },
  });
  assert.equal(
    response.statusCode,
    201,
    `POST ${at}/tokens should have answered: ${response.body}`,
  );
  return response.json<IssuedToken>();
}

/** A GET carrying whatever `Authorization` header the caller wants sent, or none. */
function present(url: string, authorization?: string) {
  return publicServer.inject(
    authorization === undefined
      ? { method: "GET", url }
      : { method: "GET", url, headers: { authorization } },
  );
}

/** A GET carrying a Token as a client carries one. */
function bearing(url: string, token: string) {
  return present(url, `Bearer ${token}`);
}

describe("GET /me", () => {
  it("answers with the presented User's id and Attributes", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    const me = await bearing(`${auth}/me`, issued.token);
    assert.equal(me.statusCode, 200, me.body);
    // The same record the login answered with, so a client that stored a Token and
    // restarted recovers exactly what it was told: its id, and the Attributes that
    // govern its authorization (User story 18, invariant 8 in `data-model.md`).
    assert.deepEqual(me.json(), user);
    assert.deepEqual(me.json(), issued.user);
    assert.deepEqual(me.json<UserRecord>().attributes, {});
  });

  it("takes the scheme however the client capitalised it, and nothing else", async () => {
    const issued = await logIn((await admit()).id);

    // RFC 7235 makes the scheme case-insensitive, and a client is not refused over
    // spelling. Extra spaces between the two are allowed for the same reason.
    for (const header of [
      `Bearer ${issued.token}`,
      `bearer ${issued.token}`,
      `BEARER ${issued.token}`,
      `Bearer  ${issued.token}`,
    ]) {
      assert.equal((await present(`${auth}/me`, header)).statusCode, 200, header);
    }
  });

  it("refuses a query parameter rather than answering it", async () => {
    const issued = await logIn((await admit()).id);
    const refused = await bearing(`${auth}/me?user=someone-else`, issued.token);
    assert.equal(refused.statusCode, 400, refused.body);
    assert.match(refused.json<{ message: string }>().message, /not a parameter of this route/);
  });
});

describe("refusing a request", () => {
  it("answers every kind of refusal identically", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    // A Token from a Directory whose Tokens last a millisecond: expired by the time
    // the response is read, over the same Db, so the row is there and only its
    // `expires_at` is in the past. This is how the refusal of an expired Token is
    // reachable without a test waiting for anything.
    const briefly = createUsers({ db, tokenTtl: 1, scrypt: cheap });
    const brieflyServer = Fastify();
    await brieflyServer.register(briefly.publicRoutes, { prefix: auth });
    let expired: string;
    try {
      expired = (await logIn(user.id, auth, () => brieflyServer)).token;
    } finally {
      await brieflyServer.close();
    }

    const refusals = [
      // No header at all.
      await present(`${auth}/me`),
      // A header in another scheme, and the Token with no scheme at all.
      await present(
        `${auth}/me`,
        `Basic ${Buffer.from(`${user.id}:${password}`).toString("base64")}`,
      ),
      await present(`${auth}/me`, issued.token),
      // The scheme with nothing after it, and with something that is not a Token.
      await present(`${auth}/me`, "Bearer"),
      await present(`${auth}/me`, "Bearer "),
      await present(`${auth}/me`, "Bearer not-a-token"),
      // A well-formed Token that was never issued: the prefix is recognisable and the
      // shape is right, and it names nothing.
      await bearing(`${auth}/me`, `saf_${"A".repeat(43)}`),
      // A Token that was issued, to somebody, and has expired.
      await bearing(`${auth}/me`, expired),
      // The same Token that works, with a character changed.
      await bearing(
        `${auth}/me`,
        `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`,
      ),
      // And on the Operator's own route, which answers with our refusal and not one
      // of its own.
      await present(`${ops}/whoami`),
      await bearing(`${ops}/whoami`, expired),
      // A wrong password, which is the same refusal on a different route: the claim
      // is one 401 across the surface, not one per route (ADR-0030).
      await publicServer.inject({
        method: "POST",
        url: `${auth}/tokens`,
        payload: { user: user.id, password: "not the password" },
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

    // Byte for byte, not merely equivalent: a stray field, a different order or a
    // `WWW-Authenticate` header on one of them would be as good an oracle as a
    // different message.
    const [first, ...rest] = refusals;
    assert.ok(first !== undefined);
    for (const refused of rest) {
      assert.equal(refused.body, first.body);
      assert.equal(refused.headers["www-authenticate"], undefined);
    }

    // And the Token that was not tampered with still works, so the refusals above are
    // about the credentials presented and not about the route being broken.
    assert.equal((await bearing(`${auth}/me`, issued.token)).statusCode, 200);
  });

  it("refuses an expired Token even where it was issued", async () => {
    // The other half of the claim: it is not that one Directory refuses another's
    // Tokens, it is that an expired Token is refused. `expires_at` is written from the
    // database's clock and compared against the database's clock, so this is the row
    // saying no rather than this process deciding.
    const briefly = createUsers({ db, tokenTtl: 1, scrypt: cheap });
    const server = Fastify();
    await server.register(briefly.publicRoutes, { prefix: auth });
    try {
      const user = await admit();
      const issued = await logIn(user.id, auth, () => server);
      assert.ok(Date.parse(issued.expiresAt) <= Date.now() + 1000, issued.expiresAt);

      const refused = await server.inject({
        method: "GET",
        url: `${auth}/me`,
        headers: { authorization: `Bearer ${issued.token}` },
      });
      assert.equal(refused.statusCode, 401, refused.body);

      // A Token of the same User with a lifetime an Operator would choose is not
      // refused, so what expired is the Token and not the User.
      const lasting = await logIn(user.id);
      assert.equal((await bearing(`${auth}/me`, lasting.token)).statusCode, 200);
    } finally {
      await server.close();
    }
  });

  it("tells one User's Token from another's", async () => {
    const first = await admit();
    const second = await admit();
    const forFirst = await logIn(first.id);
    const forSecond = await logIn(second.id);

    assert.deepEqual((await bearing(`${auth}/me`, forFirst.token)).json(), first);
    assert.deepEqual((await bearing(`${auth}/me`, forSecond.token)).json(), second);
  });
});

describe("two Tokens for one User", () => {
  it("leaves both working, so a browser and a script coexist", async () => {
    // The claim `login.test.ts` could only half-make when there was nothing to present
    // a Token to: two logins mint two Tokens, and **both work**. Neither displaced the
    // other, and each answers with the same User (User story 21).
    const user = await admit();
    const first = await logIn(user.id);
    const second = await logIn(user.id);
    assert.notEqual(first.token, second.token);

    for (const issued of [first, second]) {
      const me = await bearing(`${auth}/me`, issued.token);
      assert.equal(me.statusCode, 200, me.body);
      assert.deepEqual(me.json(), user);
    }

    // A third, obtained through the other prefix, works on the first prefix's route:
    // the Tokens belong to the Directory and not to a registration of it.
    const third = await logIn(user.id, alsoAt);
    assert.deepEqual((await bearing(`${auth}/me`, third.token)).json(), user);
    assert.deepEqual((await bearing(`${alsoAt}/me`, first.token)).json(), user);
  });
});

describe("the Operator's own routes", () => {
  it("reads the User from a sibling encapsulated plugin", async () => {
    // The test the whole design exists for. `operatorRoutes` is a plugin of the
    // Operator's, registered beside ours on the same server and encapsulated from it,
    // and the property written by our preHandler is visible in its handler. A
    // `decorateRequest` would have been scoped to the plugin instance that made it,
    // and the escape from that scope costs the prefix (ADR-0030).
    const user = await admit();
    const issued = await logIn(user.id);

    const answered = await bearing(`${ops}/whoami`, issued.token);
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { asked: user.id });
  });

  it("reads it from a plugin inside that plugin, on a route with a body", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    const answered = await publicServer.inject({
      method: "POST",
      url: `${ops}/deep/ask`,
      headers: { authorization: `Bearer ${issued.token}` },
      payload: { text: "what happened?" },
    });
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { by: user.id, said: "what happened?" });

    // The route is the Operator's, and the refusal is ours.
    assert.equal(
      (
        await publicServer.inject({
          method: "POST",
          url: `${ops}/deep/ask`,
          payload: { text: "what happened?" },
        })
      ).statusCode,
      401,
    );
  });

  it("serves nothing to a route that forgot the preHandler", async () => {
    // Nothing is protected by default, and the augmentation cannot express "set only
    // after `requireUser` ran" (ADR-0030), so a route that omits it type-checks and
    // runs. What it does then is measured here rather than assumed, because a guess
    // about this is exactly the guess an Operator would make:
    //
    //  - answering `request.safUser` is a **200 with an empty body**. It is not a
    //    refusal, and it is not an authenticated-looking response either: there is no
    //    User in it, because there was none on the request.
    //  - reaching *through* it is a **500**, because `undefined.id` throws where the
    //    type said it could not.
    //
    // So the route is unprotected either way, and the second shape is the one that
    // fails loudly on first use. Neither ever answers with a User, which is the part
    // that matters: the property is written by the hook and by nothing else.
    const user = await admit();
    const issued = await logIn(user.id);

    // With a perfectly good Token, which is the case that matters: forgetting the
    // preHandler does not accidentally work for an authenticated client either.
    const answered = await bearing(`${ops}/unguarded`, issued.token);
    assert.equal(answered.statusCode, 200, answered.body);
    assert.equal(answered.body, "", "a route without the preHandler has no User to answer with");

    const threw = await bearing(`${ops}/unguarded-id`, issued.token);
    assert.equal(threw.statusCode, 500, threw.body);

    // And the same two without a header at all, so what decides the outcome is the
    // missing hook rather than the missing credential.
    assert.equal((await present(`${ops}/unguarded`)).body, "");
    assert.equal((await present(`${ops}/unguarded-id`)).statusCode, 500);

    // Neither shape leaks the User, on a request that carried a Token naming them.
    for (const response of [answered, threw]) {
      assert.ok(!response.body.includes(user.id), `a User leaked: ${response.body}`);
    }
  });
});

describe("the plugins under the Operator's prefixes", () => {
  it("still answer where they were registered, and nowhere else", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    // Both registrations of the Public plugin carry both routes, which is the claim
    // that the plugin has no prefix of its own — re-asserted after this ticket added a
    // route to it and a hook that writes to the request.
    for (const at of [auth, alsoAt]) {
      assert.deepEqual((await bearing(`${at}/me`, issued.token)).json(), user);
    }

    // Nothing answers where the plugin was not put, including at the root, which is
    // where a plugin that named its own prefix would have put the route.
    for (const url of ["/me", "/tokens", "/auth/whoami", `${ops}/me`]) {
      assert.equal((await bearing(url, issued.token)).statusCode, 404, url);
    }

    // The Agent plugin honours its prefix too, and carries no `/me`: the Agent server
    // authenticates nobody at all (ADR-0010), so there is no presented User there to
    // answer with.
    const read = await agentServer.inject({ method: "GET", url: `/users/${user.id}` });
    assert.deepEqual(read.json(), user);
    for (const url of ["/me", "/users/me", "/tokens"]) {
      const onTheAgentServer = await agentServer.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${issued.token}` },
      });
      assert.notEqual(onTheAgentServer.statusCode, 200, url);
    }
  });
});
