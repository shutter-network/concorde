/**
 * A Token authenticating a request, through the Public server that composes the schemes.
 *
 * The subject is `authenticate`: what this component answers about a request, and what the server
 * does with that answer. Everything is observed over HTTP against a real Fastify instance and real
 * PostgreSQL, on a route of the Operator's own taking `publicServer.requireUser`. No hash, no
 * column and no internal call is asserted on anywhere, and every Token in this file was obtained
 * by logging in.
 *
 * Three tests carry more than they look:
 *
 *  - `answers every kind of refusal identically` is the enumeration defence, and it is compared
 *    byte for byte across a **wrong password** as well as an unknown Token, an expired one and an
 *    id nobody holds. Those four answer the one question "is this identity here?", so they are
 *    one answer. The header differs between the login route and a protected one, and that
 *    difference is asserted rather than glossed: it tracks which route was called and never which
 *    User exists.
 *  - `reads the User from a sibling encapsulated plugin` is the assertion the whole assignment
 *    design exists for, re-made against this component. The property is written by the server's
 *    hook and read in a plugin a `decorateRequest` would not have reached.
 *  - `falls through to the next scheme rather than refusing on its behalf` is why the outcome has
 *    three arms. A request carrying nothing of this scheme must reach whatever is registered
 *    behind it, and a request carrying a broken one of this scheme must not.
 *  - `serves nothing to a route that forgot the preHandler` records what actually happens rather
 *    than what would be nice. Nothing is protected by default, and the type cannot say "set only
 * after `requireUser` ran", so the failure mode is pinned here.
 *
 * A database of this file's own, because no two test files may share one, and a deliberately
 * cheap scrypt cost, because every Token here starts with a login.
 */

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

/** Where the Operator put routes of their own: a sibling of ours, on the same server. */
const ops = "/ops";

/** One line somebody wrote to a Logger. */
type LogLine = { readonly fields: LogFields; readonly message: string };

let database: TestDatabase;
let db: Db;
let users: Users;
let passwordAuth: PasswordAuth;
let publicServer: ServerComponent<FastifyInstance>;
/**
 * A second scheme, registered behind this one, so that "not my request" and "my request and it
 * failed" are told apart by what it was asked rather than by reading the outcome.
 */
let secondScheme: FakeAuth;
const warned: LogLine[] = [];

/** Every server this file built, closed at the end. Nothing here listens. */
const built: ServerComponent<FastifyInstance>[] = [];

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (fields, message) => void warned.push({ fields, message }),
  error: () => {},
};

/**
 * The shape an Operator writes their own routes in: an ordinary encapsulated plugin, registered
 * under a prefix of its own, reading `request.concordeUser` with **no cast**. The augmentation the
 * package ships is what makes those lines compile.
 */
const operatorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/whoami", { preHandler: publicServer.requireUser }, async (request) => ({
    asked: request.concordeUser.id,
  }));

  // The same thing one level deeper, because encapsulation nests.
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

  // And two routes that forgot it, which is the failure mode this file records. One answers the
  // property, the other reaches through it.
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
  // Registers its routes at `/auth` and registers itself with the server, both in its own
  // constructor. Nothing below wires either.
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

/** One login that is expected to succeed, on whichever server the caller names. */
async function logIn(user: string, server = () => publicServer.fastify): Promise<IssuedToken> {
  const response = await server().inject({
    method: "POST",
    url: "/auth/tokens",
    payload: { user, password },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<IssuedToken>();
}

/** A GET at the Operator's own protected route, carrying whatever the caller sends, or nothing. */
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
    // The scheme in front answered, so nothing behind it was asked.
    assert.equal(secondScheme.asked.length, alreadyAsked);
  });

  it("takes the scheme however the client capitalised it, and nothing else", async () => {
    const issued = await logIn((await admit()).id);

    // RFC 7235 makes the scheme case-insensitive, and a client is not refused over spelling.
    // Extra spaces between the two are allowed for the same reason.
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
    // The assertion the assignment design exists for. `operatorRoutes` is a plugin of the
    // Operator's, registered beside this component's and encapsulated from it, and the property
    // the server's hook wrote is visible in its handler with no cast.
    const user = await admit();
    const issued = await logIn(user.id);
    assert.deepEqual((await bearing(issued.token)).json(), { asked: user.id });

    // And one level deeper, on a route with a body.
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
    // Nothing is protected by default, and the augmentation cannot express "set only after
    // `requireUser` ran", so a route that omits it type-checks and runs. What it does
    // then is measured here rather than assumed, because a guess about this is exactly the guess
    // an Operator would make:
    //
    // - answering `request.concordeUser` is a **200 with an empty body**. It is not a refusal, and
    // it is not an authenticated-looking response either: there is no User in it, because there was
    //    none on the request.
    //  - reaching *through* it is a **500**, because `undefined.id` throws where the type said it
    //    could not.
    //
    // So the route is unprotected either way, and the second shape is the one that fails loudly
    // on first use. Neither ever answers with a User, which is the part that matters: the
    // property is written by the server's hook and by nothing else.
    const user = await admit();
    const issued = await logIn(user.id);

    // With a perfectly good Token, which is the case that matters: forgetting the preHandler does
    // not accidentally work for an authenticated client either.
    const answered = await unguarded("/unguarded", `Bearer ${issued.token}`);
    assert.equal(answered.statusCode, 200, answered.body);
    assert.equal(answered.body, "", "a route without the preHandler has no User to answer with");

    const threw = await unguarded("/unguarded-id", `Bearer ${issued.token}`);
    assert.equal(threw.statusCode, 500, threw.body);

    // And the same two without a header at all, so what decides the outcome is the missing hook
    // rather than the missing credential.
    assert.equal((await unguarded("/unguarded")).body, "");
    assert.equal((await unguarded("/unguarded-id")).statusCode, 500);

    // Neither shape leaks the User, on a request that carried a Token naming them.
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
      // Nothing of this scheme in either request, so both reach the Auth behind it.
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
      // The second scheme would have authenticated this request. A refusal is this scheme
      // saying its own credential failed, and the walk ends there.
      const refused = await bearing("concorde_not-a-token");
      assert.equal(refused.statusCode, 401, refused.body);
      assert.equal(secondScheme.asked.length, alreadyAsked);
    } finally {
      secondScheme.answers({ kind: "absent" });
    }
  });

  it("tells a broken header apart from a bad Token, in the log and in the challenge", async () => {
    warned.length = 0;

    // The scheme is named and nothing follows it. That is mechanics rather than identity, so it
    // may be told apart: the code says the request was malformed and the detail says how.
    const malformed = await ask("Bearer");
    assert.equal(malformed.statusCode, 401, malformed.body);
    assert.equal(malformed.headers["www-authenticate"], 'Bearer error="invalid_request", Nostr');
    assert.equal(warned.length, 1);
    assert.deepEqual(warned[0]?.fields, {
      scheme: "Bearer",
      code: "invalid_request",
      detail: "the Authorization header named Bearer and carried no token after it",
    });

    // A Token that did not verify says only that. Nothing is written to the log, because a
    // sentence telling an unknown Token from an expired one is a sentence somebody eventually
    // puts on the wire.
    warned.length = 0;
    const refused = await bearing("concorde_not-a-token");
    assert.equal(refused.headers["www-authenticate"], 'Bearer error="invalid_token", Nostr');
    assert.deepEqual(warned, []);

    // And neither sentence reached the client.
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

    // A Token from a component whose Tokens last a millisecond: expired by the time the response
    // is read, over the same Db, so the row is there and only its `expires_at` is in the past.
    // This is how the refusal of an expired Token is reachable without a test waiting.
    const briefly = serverComponent(Fastify(), nowhere, { logger });
    built.push(briefly);
    createPasswordAuth({ db, users, publicServer: briefly, tokenTtl: 1, scrypt: cheap });
    const expired = (await logIn(user.id, () => briefly.fastify)).token;

    // Every refusal a protected route can give, and every refusal the routes of this component
    // can give, including the two that answer the question "is this identity here?".
    const refusals = [
      // No header at all, and a header in another scheme that nothing accepted.
      await ask(),
      await ask(`Basic ${Buffer.from(`${user.id}:${password}`).toString("base64")}`),
      // The scheme with nothing after it, and with something that is not a Token.
      await ask("Bearer"),
      await ask("Bearer "),
      await ask("Bearer not-a-token"),
      // A well-formed Token that was never issued: the prefix is recognisable and the shape is
      // right, and it names nothing.
      await bearing(`concorde_${"A".repeat(43)}`),
      // A Token that was issued, to somebody, and has expired.
      await bearing(expired),
      // The same Token that works, with a character changed.
      await bearing(`${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`),
      // A wrong password, an id nobody holds and a User with no password, all at the login
      // route. These are the three the enumeration defence is about, and the claim is one
      // answer across the surface rather than one per route.
      await login({ user: user.id, password: "not the password" }),
      await login({ user: "00000000-0000-4000-8000-000000000000", password }),
      await login({ user: withoutAPassword.id, password }),
      // And a wrong current password at the change route, which is the same failure again.
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

    // Byte for byte, not merely equivalent: a stray field or a different order in any of them
    // would be as good an oracle as a different message. Three producers write this body: this
    // component, the Users component and the server's own aggregate. This is what keeps
    // them one body.
    const [first, ...rest] = refusals;
    assert.ok(first !== undefined);
    for (const refused of rest) assert.equal(refused.body, first.body);

    // The challenge is the one thing that differs, and it tracks the route rather than the
    // identity. Every refusal the server composed names both registered schemes; the routes of
    // this component write their own 401 and challenge for nothing, because a client that
    // reached the login route already knows what it is presenting.
    for (const composed of refusals.slice(0, 8)) {
      assert.match(String(composed.headers["www-authenticate"]), /^Bearer.*Nostr$/);
    }
    for (const ownRefusal of refusals.slice(8)) {
      assert.equal(ownRefusal.headers["www-authenticate"], undefined);
    }
    // And within the login route, the three refusals are identical headers and all: whether the
    // User exists changes nothing about the response.
    assert.deepEqual(refusals[9]?.headers, refusals[8]?.headers);
    assert.deepEqual(refusals[10]?.headers, refusals[8]?.headers);

    // And the Token that was not tampered with still works, so the refusals above are about the
    // credentials presented and not about the routes being broken.
    assert.equal((await bearing(issued.token)).statusCode, 200);
  });

  it("refuses an expired Token where it was issued too", async () => {
    // The other half of the claim: it is not that one component refuses another's Tokens, it is
    // that an expired Token is refused. `expires_at` is written from the database's clock and
    // compared against the database's clock, so this is the row saying no rather than this
    // process deciding.
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

    // A Token of the same User with a lifetime an Operator would choose is not refused, so what
    // expired is the Token and not the User.
    assert.equal((await bearing((await logIn(user.id)).token)).statusCode, 200);
  });
});

/** A GET at one of the Operator's routes that forgot the preHandler. */
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
