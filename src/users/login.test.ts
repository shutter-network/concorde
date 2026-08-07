/**
 * Trading a password for a Token, as a client can observe it.
 *
 * The subject is what a client sees, never how a secret is stored: every assertion
 * here is made over HTTP against real Fastify instances and real PostgreSQL, and
 * **nothing reads a hash, a column, or a row**. A password is created through the
 * Agent server and confirmed by logging in with it, which is the highest available
 * point and the only one a client has.
 *
 * Two tests carry more than they look:
 *
 *  - `answers a wrong password, an unknown User and a User with no password
 *    identically` compares the responses byte for byte. Attributes govern
 *    authorization, so learning that an id names somebody is learning where to point
 *    guessing that nothing rate limits (ADR-0030).
 *  - `derives a key even when there is nobody to check against` counts derivations
 *    rather than milliseconds. The claim is about the code path, and a claim about
 *    wall-clock time on a shared machine is a flaky test rather than a strong one.
 *
 * The component under test is constructed with a **deliberately cheap** scrypt cost,
 * because every login here would otherwise pay the real one; one test constructs with
 * the default and logs in, so the shipped parameters are exercised too.
 *
 * A database of this file's own, because no two test files may share one: they run in
 * parallel processes and would migrate over each other.
 */

import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type Component, serverComponent } from "../gateway/components.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import type { UserRecord } from "./routes.ts";
import * as usersSchema from "./schema.ts";
import type { ScryptParameters } from "./secrets.ts";
import { createUsers, type Users } from "./users.ts";

/** What a login answers with, as a client parses it. */
type IssuedToken = {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: UserRecord;
};

const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;

/**
 * A cost nobody should deploy, so that a file full of logins runs in a moment.
 *
 * It is legitimate only because each digest carries the parameters it was written
 * under: this is a construction-time number and not a property of the schema, and one
 * test below proves a digest written at this cost still verifies under another.
 */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

let database: TestDatabase;
let db: Db;
let directory: Users;
/**
 * The two servers, exactly as an Operator holds them: two bare Fastify instances of
 * their own, each given a place in a start order, and handed to the component so that
 * it registers its two route groups itself. Nothing here starts either — `inject`
 * needs no socket — so the listen options below go unused.
 */
let agentServer: Component & { readonly fastify: FastifyInstance };
let publicServer: Component & { readonly fastify: FastifyInstance };

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

/**
 * Where the constructor put the Public plugin, and where the Operator put it a second
 * time.
 *
 * The first is the prefix `createUsers` registers under when it is handed a Public
 * server, so `POST /auth/tokens` is the URL a reader will type. The plugin's own path
 * is `/tokens`, and the prefix is Fastify's mechanism rather than anything of ours,
 * which the second registration is here to show.
 */
const auth = "/auth";
const alsoAt = "/sign-in";

before(async () => {
  database = await createTestDatabase("users_login");
  db = database.db;
  await applySchema(db, usersSchema);

  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);

  // Handed both servers, so `POST /users` and `POST /auth/tokens` are registered by
  // the constructor: nothing here registers either plugin, and nothing here could
  // forget to (ADR-0032).
  directory = createUsers({ db, tokenTtl: hour, scrypt: cheap, agentServer, publicServer });

  // The second registration is the Operator's own, by hand, which is the door the
  // exported plugin is.
  await publicServer.fastify.register(directory.publicRoutes, { prefix: alsoAt });
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

/** Creates a User over the Agent server, with whatever body the caller wants sent. */
async function admit(payload?: Record<string, unknown>): Promise<UserRecord> {
  const response =
    payload === undefined
      ? await agentServer.fastify.inject({ method: "POST", url: "/users" })
      : await agentServer.fastify.inject({ method: "POST", url: "/users", payload });
  assert.equal(response.statusCode, 201, `POST /users should have answered: ${response.body}`);
  return response.json<UserRecord>();
}

/** One login attempt, against whichever Public server and prefix the caller names. */
function attempt(
  payload: Record<string, unknown> | undefined,
  at = auth,
  server = () => publicServer.fastify,
) {
  const url = `${at}/tokens`;
  return payload === undefined
    ? server().inject({ method: "POST", url })
    : server().inject({ method: "POST", url, payload });
}

/** One login that is expected to succeed. */
async function logIn(
  user: string,
  password: string,
  at = auth,
  server = () => publicServer.fastify,
): Promise<IssuedToken> {
  const response = await attempt({ user, password }, at, server);
  assert.equal(
    response.statusCode,
    201,
    `POST ${at}/tokens should have answered: ${response.body}`,
  );
  return response.json<IssuedToken>();
}

/**
 * `GET /me` with a Token, which is what "the Token works" means from outside.
 *
 * The route belongs to the same Public plugin, so a file about issuing Tokens can
 * settle its own claims — that two logins yield two *working* Tokens, and that an
 * expired one is refused — without reading a row. What the preHandler does in general
 * is `authentication.test.ts`.
 */
function present(token: string, at = auth, server = () => publicServer.fastify) {
  return server().inject({
    method: "GET",
    url: `${at}/me`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * The password every User in this file is created with, unless a test needs two.
 *
 * Long and dull on purpose: nothing here has an opinion about password strength, and
 * a short one in a test invites a reader to think something checks.
 */
const password = "correct horse battery staple";

/**
 * Counts the scrypt derivations that happen while `during` runs.
 *
 * The mechanism is Node's own: `syncBuiltinESMExports` updates the live bindings of
 * builtin modules, so a named `scrypt` imported by `secrets.ts` picks up the wrapper
 * installed on the CommonJS object here. It is restored afterwards, and the tests in
 * this file run serially, so nothing else is counted.
 *
 * Counting rather than timing is the point. "A miss is as slow as a hit" is a claim
 * about the code path; measured as a duration on a machine running a database and
 * three other test files, it would fail for reasons that have nothing to do with the
 * Gateway.
 */
const nodeCrypto: typeof import("node:crypto") = createRequire(import.meta.url)("node:crypto");

async function derivations(during: () => Promise<unknown>): Promise<number> {
  const real = nodeCrypto.scrypt;
  let counted = 0;
  nodeCrypto.scrypt = ((...args: Parameters<typeof real>) => {
    counted += 1;
    return real(...args);
  }) as typeof real;
  syncBuiltinESMExports();
  try {
    await during();
  } finally {
    nodeCrypto.scrypt = real;
    syncBuiltinESMExports();
  }
  return counted;
}

describe("trading a password for a Token", () => {
  it("answers with the Token, its expiry, and the User", async () => {
    const user = await admit({ password });
    const issued = await logIn(user.id, password);

    // A client needs no second request: it is told who it is, including the
    // Attributes that govern its authorization (invariant 8 in `data-model.md`).
    assert.deepEqual(issued.user, user);
    assert.deepEqual(Object.keys(issued).sort(), ["expiresAt", "token", "user"]);

    // A short fixed prefix, so a leaked string is recognisable as a credential of
    // this framework's, in front of 32 random bytes as base64url.
    assert.match(issued.token, /^saf_[A-Za-z0-9_-]{43}$/);

    // The expiry is the construction-time lifetime, measured on the database's
    // clock. The window is wide because the two clocks are not the same one, and it
    // is narrow enough that a lifetime read from somewhere else would fail it.
    const expiry = Date.parse(issued.expiresAt);
    assert.ok(expiry > Date.now() + hour - minute, `${issued.expiresAt} is too soon`);
    assert.ok(expiry < Date.now() + hour + minute, `${issued.expiresAt} is too late`);
  });

  it("mints a new Token on every login, so a second client displaces nothing", async () => {
    const user = await admit({ password });
    const first = await logIn(user.id, password);
    const second = await logIn(user.id, password);

    // Two credentials, and the second login neither returned the first nor said
    // anything about it.
    assert.notEqual(first.token, second.token);
    assert.match(second.token, /^saf_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(second.user, first.user);

    // And **both work**, which is the half of this claim that had nowhere to be made
    // until a Token could be presented: a browser and a script get one each, and
    // neither displaces the other (User story 21).
    for (const issued of [first, second]) {
      const me = await present(issued.token);
      assert.equal(me.statusCode, 200, me.body);
      assert.deepEqual(me.json(), user);
    }
  });

  it("takes an initial password on the Agent server, and still no Attributes", async () => {
    // The escalation ADR-0029 closes, tried again now that the route has a body it
    // reads: the password arrives, and `attributes` reaches nothing, because there is
    // no such parameter for it to arrive through.
    const escalated = await admit({
      password,
      attributes: { role: "admin", groups: ["operators"] },
      passwordHash: "$scrypt$ln=1,r=1,p=1$AAAA$AAAA",
    });
    assert.deepEqual(escalated.attributes, {});

    // And the password that was posted is the one that works, rather than the digest
    // that was posted beside it.
    const issued = await logIn(escalated.id, password);
    assert.deepEqual(issued.user, escalated);
  });
});

describe("refusing a login", () => {
  it("answers a wrong password, an unknown User and a User with no password identically", async () => {
    const withPassword = await admit({ password });
    const withNone = await admit();
    const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

    const refusals = await Promise.all([
      attempt({ user: withPassword.id, password: "not the password" }),
      attempt({ user: nobody, password }),
      attempt({ user: withNone.id, password }),
    ]);

    for (const refused of refusals) {
      // One status and one message, in Fastify's own error shape so the surface
      // answers one shape rather than two.
      assert.equal(refused.statusCode, 401);
      assert.deepEqual(refused.json(), {
        statusCode: 401,
        error: "Unauthorized",
        message: "authentication failed",
      });
    }

    // Byte for byte, not merely equivalent: a stray field or a different order would
    // be as good an oracle as a different message.
    const [first, ...rest] = refusals;
    assert.ok(first !== undefined);
    for (const refused of rest) {
      assert.equal(refused.body, first.body);
    }

    // And nothing about a User is discoverable through the Public server at all: the
    // one that does exist is not confirmed by a 404 anywhere here.
    assert.equal((await attempt({ user: withPassword.id, password: "wrong" })).statusCode, 401);
  });

  it("derives a key even when there is nobody to check against", async () => {
    const known = await admit({ password });
    const withNone = await admit();
    const nobody = "9a7c6b5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d";

    // One miss first, so the fixed dummy digest this Gateway verifies against is
    // already derived. It is built lazily and at the component's own cost, so that a
    // miss costs what a hit costs however the Operator constructed it.
    await attempt({ user: nobody, password });

    const paths = {
      "an unknown User": () => attempt({ user: nobody, password }),
      "a User with no password": () => attempt({ user: withNone.id, password }),
      "a wrong password": () => attempt({ user: known.id, password: "not the password" }),
      "a correct password": () => attempt({ user: known.id, password }),
    };
    for (const [what, login] of Object.entries(paths)) {
      assert.equal(
        await derivations(login),
        1,
        `a login with ${what} should derive exactly one key`,
      );
    }
  });

  it("refuses a request it cannot read, rather than guessing at it", async () => {
    const user = await admit({ password });

    // A malformed uuid is a 400 and not a 500 out of PostgreSQL refusing to cast it,
    // the same convention an id in a path follows. It tells a caller nothing: a
    // well-formed id nobody holds is the 401 above.
    for (const body of [
      undefined,
      {},
      { user: user.id },
      { password },
      { user: "not-an-id", password },
      { user: user.id, password: "" },
      {
        user: user.id,
        password:
          // Longer than a password may be, because scrypt reads its whole input and
          // nothing rate limits this route.
          "x".repeat(1025),
      },
    ]) {
      const refused = await attempt(body);
      assert.equal(refused.statusCode, 400, JSON.stringify(body));
    }

    // A credential in a URL is a credential in every access log between here and the
    // client, so a query parameter is refused rather than ignored.
    const inTheUrl = await publicServer.fastify.inject({
      method: "POST",
      url: `${auth}/tokens?password=${password}`,
      payload: { user: user.id, password },
    });
    assert.equal(inTheUrl.statusCode, 400);
    assert.match(inTheUrl.json<{ message: string }>().message, /not a parameter of this route/);
  });
});

describe("the Token's lifetime", () => {
  it("comes from the construction-time option and from nothing else", async () => {
    // A second Users component over the same Db, differing only in the number an
    // Operator chose. A lifetime of a millisecond is a Token that is expired by the
    // time the response is read, which is how the refusal of an expired one is
    // reachable without a test waiting for anything.
    const server = serverComponent(Fastify(), nowhere);
    const briefly = createUsers({ db, tokenTtl: 1, scrypt: cheap, publicServer: server });
    try {
      const user = await admit({ password });
      const issued = await logIn(user.id, password, auth, () => server.fastify);
      const expiry = Date.parse(issued.expiresAt);
      assert.ok(
        expiry < Date.now() + second,
        `a Token with a lifetime of a millisecond should not last until ${issued.expiresAt}`,
      );

      // The same Db, the same User, the same password: only the option differs.
      const longer = await logIn(user.id, password);
      assert.ok(Date.parse(longer.expiresAt) > Date.now() + hour - minute);

      // And the lifetime means something, which is what an expiry is for and what
      // could not be asserted until a Token could be presented: the brief one is
      // refused where it was issued, the longer one is not, and the refusal is the
      // single 401 (User story 24). The comparison is the database's clock against
      // the value the database wrote, so no clock anywhere had to be moved.
      const refused = await present(issued.token, auth, () => server.fastify);
      assert.equal(refused.statusCode, 401, refused.body);
      assert.deepEqual(refused.json(), {
        statusCode: 401,
        error: "Unauthorized",
        message: "authentication failed",
      });
      assert.equal((await present(longer.token)).statusCode, 200);
    } finally {
      await server.stop();
    }
  });

  it("must be a positive number of milliseconds", async () => {
    for (const tokenTtl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createUsers({ db, tokenTtl, scrypt: cheap }),
        /tokenTtl must be a positive number of milliseconds/,
        String(tokenTtl),
      );
    }
  });
});

describe("the cost of a password", () => {
  it("verifies a digest at the parameters it was written under", async () => {
    // The test that justifies storing the parameters with each digest. There is no
    // account-recovery flow, so parameters fixed in code could never change at all:
    // raising them would make every stored digest unverifiable and the only remedy
    // would be a reset for every User (ADR-0030).
    const written = await admit({ password });

    // One Fastify instance passed as both servers, which is a deployment that runs one:
    // the two groups land under their own prefixes and nothing collides.
    const server = serverComponent(Fastify(), nowhere);
    createUsers({
      db,
      tokenTtl: hour,
      scrypt: { logN: 13, blockSize: 8, parallelism: 2 },
      agentServer: server,
      publicServer: server,
    });
    try {
      // A digest written under the old parameters still verifies under the new
      // construction, and is not rewritten by having been used.
      const issued = await logIn(written.id, password, auth, () => server.fastify);
      assert.deepEqual(issued.user, written);
      await logIn(written.id, password);

      // And the other direction, which is the same claim: a digest written under the
      // new parameters verifies through the component that knows nothing about them.
      const laterResponse = await server.fastify.inject({
        method: "POST",
        url: "/users",
        payload: { password },
      });
      assert.equal(laterResponse.statusCode, 201, laterResponse.body);
      const later = laterResponse.json<UserRecord>();
      assert.deepEqual((await logIn(later.id, password)).user, later);
    } finally {
      await server.stop();
    }
  });

  it("works at the cost a Gateway that names none gets", async () => {
    // The shipped parameters, run once. Everything else in this file is deliberately
    // cheap, so without this nothing would ever exercise the numbers an Operator
    // actually deploys, and a memory limit set wrongly for them would ship.
    const server = serverComponent(Fastify(), nowhere);
    createUsers({ db, tokenTtl: hour, agentServer: server, publicServer: server });
    try {
      const response = await server.fastify.inject({
        method: "POST",
        url: "/users",
        payload: { password },
      });
      assert.equal(response.statusCode, 201, response.body);
      const user = response.json<UserRecord>();
      assert.deepEqual((await logIn(user.id, password, auth, () => server.fastify)).user, user);
      assert.equal(
        (await attempt({ user: user.id, password: "wrong" }, auth, () => server.fastify))
          .statusCode,
        401,
      );
    } finally {
      await server.stop();
    }
  });
});

describe("the Public server plugin", () => {
  it("honours whatever prefix the Operator registers it under", async () => {
    const user = await admit({ password });
    const issued = await logIn(user.id, password, alsoAt);
    assert.deepEqual(issued.user, user);
    assert.notEqual(issued.token, (await logIn(user.id, password, auth)).token);

    // Nothing answers where the plugin was not put, including at the root, which is
    // where a plugin that named its own prefix would have put the route.
    for (const url of ["/tokens", "/", "/auth/token"]) {
      const response = await publicServer.fastify.inject({
        method: "POST",
        url,
        payload: { user: user.id, password },
      });
      assert.equal(response.statusCode, 404, url);
    }

    // And the login is not on the Agent server, which has no authentication at all
    // and is not where a credential goes (ADR-0010).
    const onTheAgentServer = await agentServer.fastify.inject({
      method: "POST",
      url: "/auth/tokens",
      payload: { user: user.id, password },
    });
    assert.equal(onTheAgentServer.statusCode, 404);
  });
});
