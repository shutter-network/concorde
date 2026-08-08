/**
 * The Public server as the thing that composes authentication: several Auths, one
 * hook, one refusal.
 *
 * The subject is the seam an Operator sees. Every assertion is made over HTTP against
 * a real Fastify instance, through `publicServer.requireUser` on a route in a plugin
 * of the Operator's own, and the Users the fake Auths answer with are rows in a real
 * PostgreSQL. No internal call is asserted on anywhere, and the walk is observed
 * through what each Auth was asked rather than through what the aggregate did.
 *
 * Four tests carry more than they look:
 *
 *  - `reads the User from a sibling encapsulated plugin` is the assertion
 *    `users/authentication.test.ts` calls **the test the whole design exists for**,
 *    re-made against the new assignment site. The User is assigned by a plain
 *    property write, and the Operator's plugin is exactly the sibling a
 *    `decorateRequest` would not have reached.
 *  - `answers the 401 Password Auth already answered, byte for byte` is why this
 *    aggregate may write its own refusal instead of importing one. Two producers of
 *    one body only stay one body if something compares them.
 *  - `authenticates a route that was registered before it` is the late binding. The
 *    route, the server's readiness and the Auth arrive in the order a deployment
 *    puts them in, which is the wrong one.
 *  - `throws rather than refusing when no Auth is registered` is the Agent server's
 *    case as much as a mistake's: nothing registers with that server, so a protected
 *    route on it fails every request.
 *
 * A database of this file's own, because no two test files may share one, and a
 * deliberately cheap scrypt cost, because the one login attempt in it is expected to
 * fail and only exists to produce the refusal this file compares against.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import type { Db } from "../db/index.ts";
import type { LogFields, Logger } from "../logging/logging.ts";
import { createPasswordAuth } from "../password-auth/password-auth.ts";
import * as passwordAuthSchema from "../password-auth/schema.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { type FakeAuth, fakeAuth } from "../test-support/fake-auth.ts";
import type { UserRecord } from "../users/routes.ts";
import * as usersSchema from "../users/schema.ts";
import { createUsers } from "../users/users.ts";
import { NoAuthRegisteredError } from "./auth.ts";
import { type ServerComponent, serverComponent } from "./components.ts";

const hour = 60 * 60 * 1000;

/** A cost nobody should deploy, legitimate because each digest carries its own. */
const cheap = { logN: 12, blockSize: 8, parallelism: 1 } as const;

/** Where the Operator put routes of their own: a sibling of everything else on the server. */
const ops = "/ops";

/** Where a server that is never started would have listened, had it been. */
const nowhere = { port: 0, host: "127.0.0.1" } as const;

/** What the composed 401 answers with, which is what Password Auth answers with. */
const refusalBody = { statusCode: 401, error: "Unauthorized", message: "authentication failed" };

let database: TestDatabase;
let db: Db;
/** Two Users, so a test can tell which Auth's answer was taken. */
let admitted: UserRecord;
let other: UserRecord;
/**
 * The other producer of this body: Password Auth's login route, refusing a password
 * nobody holds. That route runs before any hook and writes its own 401, so it is the
 * one refusal in the framework this aggregate does not compose.
 */
let existingRefusal: string;

/** Every server this file built, closed at the end. Nothing here listens. */
const built: ServerComponent<FastifyInstance>[] = [];

/** One line somebody wrote to a Logger. */
type LogLine = { readonly fields: LogFields; readonly message: string };

/**
 * A Public server as an Operator holds one: their own Fastify instance, their own
 * routes in a plugin of their own under a prefix of their own, and the framework's
 * hook as one route option.
 */
async function guarded(): Promise<{
  readonly server: ServerComponent<FastifyInstance>;
  readonly warned: readonly LogLine[];
  /** Whatever the hook threw, which Fastify would otherwise turn into a 500 and swallow. */
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
  // Before the routes, because a Fastify instance that has booted takes no more of
  // these. It answers what the default handler would, so what the assertions read is
  // the ordinary 500 an Operator would see.
  // `TError` defaults to `unknown` on this hook, so the annotation is what lets the
  // message be read. Fastify hands the thrown value through untouched either way.
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

/**
 * The shape the quickstart documents: an ordinary encapsulated plugin, registered
 * under a prefix of its own, reading `request.safUser` with **no cast**. The
 * augmentation the package ships is what makes those lines compile.
 */
function operatorRoutes(server: ServerComponent<FastifyInstance>): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/whoami", { preHandler: server.requireUser }, async (request) => ({
      asked: request.safUser.id,
    }));

    // The same thing one level deeper, because encapsulation nests: a plugin inside
    // the Operator's plugin is further still from the plugin instance a
    // `decorateRequest` would have been scoped to.
    await fastify.register(
      async (inner) => {
        inner.post<{ Body: { text: string } }>(
          "/ask",
          { preHandler: server.requireUser },
          async (request) => ({ by: request.safUser.id, said: request.body.text }),
        );
      },
      { prefix: "/deep" },
    );
  };
}

/** A GET at the Operator's own protected route, carrying whatever the caller sends. */
function ask(server: ServerComponent<FastifyInstance>, authorization = "Bearer whatever") {
  return server.fastify.inject({
    method: "GET",
    url: `${ops}/whoami`,
    headers: { authorization },
  });
}

/** An Auth that names one User, spelled once. */
function admits(scheme: string, user: UserRecord): FakeAuth {
  return fakeAuth(scheme, { kind: "authenticated", user });
}

before(async () => {
  database = await createTestDatabase("gateway_auths");
  db = database.db;
  await applySchema(db, usersSchema, passwordAuthSchema);

  // Users, so that the Users the fake Auths answer with are real rows, and Password
  // Auth beside it on a server of its own, so that the refusal this file compares
  // against is written by the other producer of that body rather than by this one.
  const reference = serverComponent(Fastify(), nowhere);
  built.push(reference);
  const users = createUsers({ db });
  createPasswordAuth({ db, users, publicServer: reference, tokenTtl: hour, scrypt: cheap });
  admitted = await db.tx((tx) => users.create(tx));
  other = await db.tx((tx) => users.create(tx));

  // A well-formed id nobody holds, at the login route, which refuses before any hook
  // has run: the 401 comes from that component's own `unauthorized` and from nothing
  // this file is testing.
  const refused = await reference.fastify.inject({
    method: "POST",
    url: "/auth/tokens",
    payload: { user: "00000000-0000-4000-8000-000000000000", password: "not anybody's" },
  });
  assert.equal(refused.statusCode, 401, refused.body);
  existingRefusal = refused.body;
  // The refusal this framework has always sent carries no challenge, which is the
  // conformance gap the aggregate closes. Pinned here so the comparison below is
  // read for what it is: the body is the same and the headers are not.
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

    // It was handed the whole request, which is why a scheme carried anywhere else is
    // expressible: the header is read off the object the Auth was given.
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

    // Both were asked, and the one that recognised nothing said so rather than
    // refusing on behalf of a scheme it does not own.
    assert.equal(bearer.asked.length, 1);
    assert.equal(nostr.asked.length, 1);
  });

  it("asks them in registration order and stops at the first that authenticates", async () => {
    const { server } = await guarded();
    const first = admits("Bearer", admitted);
    const second = admits("Nostr", other);
    server.registerAuth(first);
    server.registerAuth(second);

    // Both would have authenticated this request, and the order the Operator wrote is
    // what decides whose User it is.
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

    // The second Auth would have authenticated this request. A refusal is a scheme
    // saying its own credential failed, and the walk ends there.
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

    // Every way this aggregate can refuse: nothing recognised, a malformed
    // credential, and one that did not verify. The claim is one refusal across the
    // whole surface rather than one per outcome, so a stray field or a different
    // order in any of them would be as good an oracle as a different message.
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

    // One scheme, one challenge. RFC 7235 says a 401 carries one, and until there was
    // something that knew every accepted scheme there was nothing able to write it.
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

    // And from the second scheme, which is the case a client has to parse past a bare
    // challenge to read.
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

    // An Operator can tell a rewritten URL from a bad signature.
    assert.equal(warned.length, 1);
    assert.deepEqual(warned[0]?.fields, {
      scheme: "Nostr",
      code: "invalid_token",
      detail,
    });

    // And a client cannot. The body is the same one every other refusal gets, and no
    // header carries the sentence either.
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
    // The code is already on the wire, so a line repeating it teaches an Operator
    // nothing their access log does not hold.
    assert.deepEqual(warned, []);
  });
});

describe("a server no Auth registered with", () => {
  it("throws rather than refusing, so a wiring mistake is not a credential problem", async () => {
    // This is the Agent server's own case. Nothing registers an Auth with it, so a
    // route there that took `requireUser` would fail every request, however good the
    // credential presented.
    const { server, thrown } = await guarded();

    const answered = await ask(server, "Bearer a-perfectly-good-token");
    assert.equal(answered.statusCode, 500, answered.body);
    assert.notEqual(answered.statusCode, 401);

    assert.equal(thrown.length, 1);
    const error = thrown[0];
    assert.ok(error instanceof NoAuthRegisteredError, `not the wiring error: ${String(error)}`);
    // It names the route, the way the Messenger's own refusal names the User nothing
    // could reach.
    assert.match(error.message, /GET \/ops\/whoami/);
    assert.equal(error.name, "NoAuthRegisteredError");

    // And the request that failed is not a request anybody's credential could have
    // saved: registering an Auth is what fixes it.
    server.registerAuth(admits("Bearer", admitted));
    assert.equal((await ask(server)).statusCode, 200);
  });
});

describe("the Operator's own routes", () => {
  it("reads the User from a sibling encapsulated plugin", async () => {
    // The test the whole design exists for, re-made against the new assignment site.
    // The property is written by the server's hook, in one place, and read in a
    // plugin registered beside everything else and encapsulated from it.
    const { server } = await guarded();
    server.registerAuth(admits("Bearer", admitted));

    const answered = await ask(server);
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { asked: admitted.id });
  });

  it("reads it from a plugin inside that plugin, on a route with a body", async () => {
    const { server } = await guarded();
    // Told to read the request rather than to answer regardless, so the refusal below
    // is this Auth declining a scheme that is not its own.
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

    // The route is the Operator's, and the refusal is the server's.
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
    // The order a deployment actually has: the servers are built first, the routes go
    // on at construction, and the Auth is one more component built after both. The
    // hook reads the registered Auths per request, so nothing about that order is a
    // trap.
    const { server } = await guarded();
    await server.fastify.ready();

    server.registerAuth(admits("Bearer", admitted));
    assert.deepEqual((await ask(server)).json(), { asked: admitted.id });

    // A second Auth, later still, and the first is still asked first.
    const nostr = admits("Nostr", other);
    server.registerAuth(nostr);
    assert.deepEqual((await ask(server)).json(), { asked: admitted.id });
    assert.equal(nostr.asked.length, 0);
  });
});
