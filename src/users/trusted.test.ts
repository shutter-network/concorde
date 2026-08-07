/**
 * The asymmetry the whole part is arranged around: what trusted code may do, and what
 * the agent may not.
 *
 * Signal Handlers and an Operator's entry point are trusted code (ADR-0009, ADR-0020)
 * and hold the constructed object. The Agent server is the one surface an injected
 * prompt reaches (ADR-0003) and it authenticates nobody at all (ADR-0010). So three
 * capabilities — setting Attributes, replacing a password, issuing a Token — are
 * methods and not routes, and this file is where that stops being a description and
 * becomes a property.
 *
 * The subject is what a client can observe, as everywhere else in this part: every
 * assertion is made over HTTP against real Fastify instances and real PostgreSQL, and
 * **nothing reads a hash, a column, or a row**. Attributes set from trusted code are
 * confirmed by reading them back over both servers; a password replaced from trusted
 * code is confirmed by logging in with it; a Token issued from trusted code is
 * confirmed by presenting it.
 *
 * Two tests are the reason the file exists, and neither is about a convenience:
 *
 *  - `issues a Token to a User who cannot log in at all` is the **OIDC path**, end to
 *    end. A User with a null password hash is refused every password, including the
 *    empty one, and yet a Token minted for them by trusted code authenticates a
 *    request as well as any password ever bought. That is the entire substitute for a
 *    pluggable Authenticator (ADR-0030); if it does not work, the seam does not exist.
 *  - `carries no route that could set Attributes, replace a password, issue a Token or
 *    remove a User` asserts the Agent plugin's **complete** route table rather than
 *    probing a list of URLs. A route added later shows up there and fails, which is
 *    what makes it an assertion of absence rather than a habit of not adding things.
 *
 * The Signal Worker is present here and nowhere else in this part, for one criterion: a
 * transaction that creates a User and emits a Signal must commit or roll back as one.
 * The Users component is not a Producer and emits nothing itself (ADR-0029), so that
 * pattern is the deployment's, and this is where it is proved to work.
 *
 * A database of this file's own, because no two test files may share one, and a
 * deliberately cheap scrypt cost, because a password is replaced here several times.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { type Component, serverComponent } from "../components.ts";
import type { Db } from "../db/index.ts";
import type { Logger } from "../logging.ts";
import { createSignalWorker, type SignalWorker } from "../signals/index.ts";
import * as signalsSchema from "../signals/schema.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import type { IssuedToken, UserRecord } from "./routes.ts";
import * as usersSchema from "./schema.ts";
import type { ScryptParameters } from "./secrets.ts";
import { createUsers, type Users } from "./users.ts";

const hour = 60 * 60 * 1000;

/** A cost nobody should deploy, legitimate because each digest carries its own. */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

/** The password a User is admitted with, where a test needs one at all. */
const password = "correct horse battery staple";

/** A well-formed id that names nobody, for the calls that must refuse one. */
const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

const auth = "/auth";
const users = "/users";
/** Where the Operator put a route of their own, behind the shipped preHandler. */
const ops = "/ops";

let database: TestDatabase;
let db: Db;
let directory: Users;
let worker: SignalWorker;
/**
 * The two servers, exactly as an Operator holds them: two bare Fastify instances of
 * their own, each given a place in a start order, and handed to the component so that
 * it registers its two route groups itself. Nothing here starts either — `inject`
 * needs no socket — so the listen options go unused.
 */
let agentServer: Component & { readonly fastify: FastifyInstance };
let publicServer: Component & { readonly fastify: FastifyInstance };

/** Nothing here starts the worker, so nothing should be printed by one. */
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * A route of the Operator's own, behind `users.requireUser` and nothing else.
 *
 * It is here because "a Token issued by trusted code authenticates a request" is a
 * claim about *any* route, not about ours: an OIDC deployment does not register our
 * Public plugin at all, and what it needs to work is this. The handler is a property
 * read, which is the whole integration surface (ADR-0030).
 */
const operatorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/whoami", { preHandler: directory.requireUser }, async (request) => ({
    by: request.safUser.id,
    attributes: request.safUser.attributes,
  }));
};

before(async () => {
  database = await createTestDatabase("users_trusted");
  db = database.db;
  // Both schemas pushed in one call, because one test here spans both parts. The
  // component needs no other part's tables to work, which `users.test.ts` is what
  // proves.
  await applySchema(db, signalsSchema, usersSchema);

  agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  publicServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });

  // Handed both servers, so `/users` and `/auth` are where the constructor put the two
  // plugins: nothing here registers either, and nothing here could forget to
  // (ADR-0032).
  directory = createUsers({ db, tokenTtl: hour, scrypt: cheap, agentServer, publicServer });
  // Constructed and never started: this file emits Signals and reads them back, and a
  // running worker would take them off the queue and try to handle them — so the
  // Handler map it is constructed with is empty and nothing dispatches.
  worker = createSignalWorker({
    db,
    runtime: { run: async () => ({ ok: true }) },
    handlers: {},
    logger: silent,
  });

  // The Signal Worker's own routes by hand, which is the door the exported plugin is,
  // and the Operator's own beside ours on the same instance — which is what
  // `serverComponent` carrying the Fastify instance is for.
  await agentServer.fastify.register(worker.agentRoutes);
  await publicServer.fastify.register(operatorRoutes, { prefix: ops });
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await worker.stop();
  await database.drop();
});

/** Creates a User over the Agent server, with a password or deliberately without one. */
async function admit(initial?: string): Promise<UserRecord> {
  const response = await agentServer.fastify.inject({
    method: "POST",
    url: users,
    ...(initial === undefined ? {} : { payload: { password: initial } }),
  });
  assert.equal(response.statusCode, 201, `POST ${users} should have answered: ${response.body}`);
  return response.json<UserRecord>();
}

/** One User as the Agent server reports them. */
async function readBack(id: string): Promise<UserRecord> {
  const response = await agentServer.fastify.inject({ method: "GET", url: `${users}/${id}` });
  assert.equal(
    response.statusCode,
    200,
    `GET ${users}/${id} should have answered: ${response.body}`,
  );
  return response.json<UserRecord>();
}

/** One login attempt, whatever it answers. */
function attempt(user: string, secret: string) {
  return publicServer.fastify.inject({
    method: "POST",
    url: `${auth}/tokens`,
    payload: { user, password: secret },
  });
}

/** One login that is expected to succeed. */
async function logIn(user: string, secret = password): Promise<IssuedToken> {
  const response = await attempt(user, secret);
  assert.equal(
    response.statusCode,
    201,
    `POST ${auth}/tokens should have answered: ${response.body}`,
  );
  return response.json<IssuedToken>();
}

/** `GET /auth/me` with a Token, which is what "the Token works" means from outside. */
function present(token: string, url = `${auth}/me`) {
  return publicServer.fastify.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Asserts that a Token names the User it should, over the shipped route. */
async function works(token: string, user: UserRecord, what: string): Promise<void> {
  const response = await present(token);
  assert.equal(response.statusCode, 200, `${what} should have worked: ${response.body}`);
  assert.deepEqual(response.json(), user, `${what} should have named its User`);
}

/** Asserts that a Token is refused, with the one refusal this surface has. */
async function refused(token: string, what: string): Promise<void> {
  const response = await present(token);
  assert.equal(response.statusCode, 401, `${what} should have been refused: ${response.body}`);
}

/**
 * Every route a plugin contributes, as `METHOD path` and sorted.
 *
 * Registered under **no prefix**, so what comes back is the plugin's own paths — which
 * is the thing being asserted, since the prefix is the Operator's (ADR-0021). Fastify's
 * `onRoute` hook is the mechanism, so this is the router's own account of what exists
 * rather than a list somebody kept up to date, and the `HEAD` entries are Fastify's own
 * siblings for each `GET`.
 */
async function routeTable(plugin: FastifyPluginAsync): Promise<string[]> {
  const probe = Fastify();
  const seen = new Set<string>();
  probe.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) seen.add(`${method} ${route.url}`);
  });
  await probe.register(plugin);
  await probe.ready();
  await probe.close();
  return [...seen].sort();
}

describe("setting Attributes from trusted code", () => {
  it("is where authorization lives, and it is visible everywhere a User is", async () => {
    const user = await admit(password);
    assert.deepEqual(user.attributes, {}, "a created User should have none");

    const granted = { role: "operator", groups: ["support", "billing"] };
    await db.tx((tx) => directory.setAttributes(tx, user.id, granted));

    // Over the Agent server, so the agent can resolve an id it met in a Signal payload
    // and see the grouping that governs it.
    assert.deepEqual((await readBack(user.id)).attributes, granted);
    // Through the reads, which are what a Signal Handler making an authorization
    // decision actually calls.
    assert.deepEqual((await directory.get(user.id))?.attributes, granted);
    assert.deepEqual(
      (await directory.list({ limit: 100 })).find((each) => each.id === user.id)?.attributes,
      granted,
    );

    // And to the User themselves, both in the login response and at `GET /me`, because
    // the grouping that governs somebody's authorization is not hidden from them
    // (User story 25).
    const issued = await logIn(user.id);
    assert.deepEqual(issued.user.attributes, granted);
    await works(
      issued.token,
      { ...user, attributes: granted },
      "a Token of a User with Attributes",
    );

    // The Operator's own route reads exactly the same object off the request, which is
    // the only reason any of this is useful: a Handler or a route branches on it.
    const own = await present(issued.token, `${ops}/whoami`);
    assert.equal(own.statusCode, 200, own.body);
    assert.deepEqual(own.json(), { by: user.id, attributes: granted });
  });

  it("replaces them wholesale rather than merging", async () => {
    // The documented choice, and it is documented because an undocumented one becomes
    // a deployment's bug: a merge cannot express removal without a sentinel this
    // framework has no business interpreting, Attributes need not be an object for
    // there to be a merge of, and `jsonb ||` merges only the top level.
    const user = await admit();
    await db.tx((tx) =>
      directory.setAttributes(tx, user.id, { role: "operator", tier: { plan: "gold", seats: 5 } }),
    );

    await db.tx((tx) => directory.setAttributes(tx, user.id, { tier: { plan: "silver" } }));
    assert.deepEqual(
      (await readBack(user.id)).attributes,
      { tier: { plan: "silver" } },
      "the second call should have replaced the first, keys and nested keys alike",
    );

    // Which is what makes removal expressible at all: taking everything away is
    // setting the empty object, and there is no sentinel to reach for.
    await db.tx((tx) => directory.setAttributes(tx, user.id, {}));
    assert.deepEqual((await readBack(user.id)).attributes, {});

    // And arbitrary JSON really is arbitrary: the Gateway stores Attributes and
    // interprets none of them, so a shape with no merge defined for it is fine here.
    await db.tx((tx) => directory.setAttributes(tx, user.id, ["support", "billing"]));
    assert.deepEqual((await readBack(user.id)).attributes, ["support", "billing"]);
  });

  it("takes the caller's transaction, so a rollback grants nothing", async () => {
    // What "takes the transaction first" buys, made observable (ADR-0023): granting a
    // group and recording in the Operator's own tables who granted it commit together
    // or not at all.
    const user = await admit();
    await db.tx((tx) => directory.setAttributes(tx, user.id, { role: "reader" }));

    await assert.rejects(
      db.tx(async (tx) => {
        await directory.setAttributes(tx, user.id, { role: "admin" });
        throw new Error("the Operator's own write failed");
      }),
      /the Operator's own write failed/,
    );
    assert.deepEqual((await readBack(user.id)).attributes, { role: "reader" });
  });

  it("refuses an id that names nobody, rather than granting nothing quietly", async () => {
    // The deliberate difference from `revoke`, which says nothing about a User it did
    // not find: a revocation's postcondition holds either way, and an authorization
    // grant's does not, so a mistyped id here would otherwise be a permission that
    // silently never happened.
    await assert.rejects(
      db.tx((tx) => directory.setAttributes(tx, nobody, { role: "admin" })),
      new RegExp(`no User ${nobody} exists`),
    );
  });
});

describe("replacing a password from trusted code", () => {
  it("is the whole of account recovery, and there is no route for it", async () => {
    const user = await admit(password);
    const before = await logIn(user.id);

    await db.tx((tx) => directory.setPassword(tx, user.id, "a password the Operator chose"));

    // The new one works and the old one does not, which is what "replaced" means from
    // outside — nothing here reads a digest.
    await logIn(user.id, "a password the Operator chose");
    assert.equal((await attempt(user.id, password)).statusCode, 401);

    // And it revokes nothing, deliberately and the same way `PUT /password` does not
    // (ADR-0030): an Operator locking somebody out replaces the password *and* calls
    // `revoke`, in that order, and a method that bundled the two would take that
    // choice away from a routine reset.
    await works(before.token, user, "a Token issued before the password was replaced");
    await db.tx((tx) => directory.revoke(tx, user.id));
    await refused(before.token, "a Token after the Operator revoked as well");
  });

  it("gives a password to a User who had none", async () => {
    // The OIDC path run backwards: somebody admitted through a deployment's own login
    // route can be handed a password later without being created again.
    const user = await admit();
    assert.equal((await attempt(user.id, password)).statusCode, 401);

    await db.tx((tx) => directory.setPassword(tx, user.id, password));
    assert.deepEqual((await logIn(user.id)).user, user);
  });

  it("takes the caller's transaction, so a rollback replaces nothing", async () => {
    const user = await admit(password);

    await assert.rejects(
      db.tx(async (tx) => {
        await directory.setPassword(tx, user.id, "the Operator changed their mind");
        throw new Error("and their own write failed");
      }),
      /their own write failed/,
    );

    await logIn(user.id);
    assert.equal((await attempt(user.id, "the Operator changed their mind")).statusCode, 401);
  });

  it("refuses an id that names nobody", async () => {
    await assert.rejects(
      db.tx((tx) => directory.setPassword(tx, nobody, password)),
      new RegExp(`no User ${nobody} exists`),
    );
  });
});

describe("issuing a Token from trusted code", () => {
  it("issues a Token to a User who cannot log in at all", async () => {
    // **The OIDC path, end to end.** This is the whole substitute for a pluggable
    // Authenticator (ADR-0030): a deployment establishes identity however it likes and
    // mints an ordinary Token, and this User has no password for anything to fall back
    // on.
    const user = await admit();
    await db.tx((tx) => directory.setAttributes(tx, user.id, { via: "oidc" }));
    const withAttributes = { ...user, attributes: { via: "oidc" } };

    // First, that they really cannot log in: not with a plausible password, not with
    // their own id, not with the empty one. The empty string is refused by the route's
    // schema and the rest by the credential check, and both are "cannot log in" — the
    // distinction is a 400 about a body rather than anything about this User.
    for (const guess of [password, user.id, "", " ", "null", "undefined"]) {
      const response = await attempt(user.id, guess);
      assert.ok(
        response.statusCode === 401 || response.statusCode === 400,
        `a password hash of null should refuse ${JSON.stringify(guess)}: ${response.statusCode}`,
      );
      assert.notEqual(response.statusCode, 201, JSON.stringify(guess));
    }

    // And now the seam: trusted code, having established identity by means the Gateway
    // has never heard of, mints a Token.
    const issued = await db.tx((tx) => directory.issueToken(tx, user.id));

    // It answers exactly what a login answers, which is what lets a deployment's own
    // OIDC route reply with this object unchanged.
    assert.deepEqual(Object.keys(issued).sort(), ["expiresAt", "token", "user"]);
    assert.deepEqual(issued.user, withAttributes);
    assert.ok(issued.token.startsWith("saf_"), issued.token);
    assert.ok(Date.parse(issued.expiresAt) > Date.now());

    // And it authenticates a request — on our route and on the Operator's own, which
    // is the one that matters, because an OIDC deployment does not register our Public
    // plugin at all.
    await works(issued.token, withAttributes, "a Token issued by trusted code");
    const own = await present(issued.token, `${ops}/whoami`);
    assert.equal(own.statusCode, 200, own.body);
    assert.deepEqual(own.json(), { by: user.id, attributes: { via: "oidc" } });
  });

  it("is indistinguishable from one a password bought", async () => {
    // Nothing downstream can tell how a Token was obtained, which is the property the
    // whole extension point rests on: the same row, written by the same statement.
    const oidc = await admit();
    const withPassword = await admit(password);

    const minted = await db.tx((tx) => directory.issueToken(tx, oidc.id));
    const bought = await logIn(withPassword.id);
    assert.deepEqual(Object.keys(minted).sort(), Object.keys(bought).sort());

    // Revoked by the same route a login's Token is, and by the same method.
    const loggedOut = await publicServer.fastify.inject({
      method: "DELETE",
      url: `${auth}/tokens/current`,
      headers: { authorization: `Bearer ${minted.token}` },
    });
    assert.equal(loggedOut.statusCode, 204, loggedOut.body);
    await refused(minted.token, "a minted Token logged out through the shipped route");

    const second = await db.tx((tx) => directory.issueToken(tx, oidc.id));
    await works(second.token, oidc, "a second minted Token");
    await db.tx((tx) => directory.revoke(tx, oidc.id));
    await refused(second.token, "a minted Token revoked from trusted code");
    await works(bought.token, withPassword, "another User's Token");

    // And it expires, because it is written from the same construction-time lifetime
    // and nothing about it says otherwise. A component of its own, with a lifetime
    // short enough that no clock has to be moved.
    const brief = createUsers({ db, tokenTtl: 1, scrypt: cheap });
    const fleeting = await db.tx((tx) => brief.issueToken(tx, oidc.id));
    await refused(fleeting.token, "a minted Token past its expiry");
  });

  it("mints for a User the same transaction just created", async () => {
    // What an OIDC callback meeting somebody for the first time does: admit them and
    // hand them a Token in one transaction. It works because the read is on the
    // caller's own connection, which is the one place a read in this part sees an
    // uncommitted write.
    const issued = await db.tx(async (tx) => {
      const created = await directory.create(tx);
      await directory.setAttributes(tx, created.id, { via: "oidc", firstSeen: true });
      return directory.issueToken(tx, created.id);
    });

    assert.deepEqual(issued.user.attributes, { via: "oidc", firstSeen: true });
    await works(issued.token, issued.user, "a Token minted in the transaction that admitted");
  });

  it("takes the caller's transaction, so a rollback issues nothing", async () => {
    const user = await admit();
    let attempted: IssuedToken | undefined;

    await assert.rejects(
      db.tx(async (tx) => {
        attempted = await directory.issueToken(tx, user.id);
        throw new Error("the deployment's own login route failed");
      }),
      /own login route failed/,
    );

    assert.ok(attempted !== undefined, "the Token should have been minted before the rollback");
    await refused(attempted.token, "a Token whose transaction rolled back");
  });

  it("refuses an id that names nobody", async () => {
    // There is no Token it could answer with, so this one could not have been silent
    // even if silence were wanted.
    await assert.rejects(
      db.tx((tx) => directory.issueToken(tx, nobody)),
      new RegExp(`no User ${nobody} exists`),
    );
  });
});

describe("the Agent server", () => {
  it("carries no route that could set Attributes, replace a password, issue a Token or remove a User", async () => {
    // The assertion of **absence**, and the reason it is the router's own account of
    // what exists rather than a list of URLs to probe: a route added later appears
    // here and fails this, which is what makes the property maintained rather than
    // merely true today.
    assert.deepEqual(
      await routeTable(directory.agentRoutes),
      ["GET /", "GET /:id", "HEAD /", "HEAD /:id", "POST /"],
      "the Agent plugin should contribute a create and two reads, and nothing else",
    );

    // The Public plugin, for completeness, and note what is on it: a Token issuance
    // that costs a password, a password replacement that costs the current password,
    // and two revocations that cost a Token. Every one of them is paid for by the
    // credential it is about, which is what the Agent server has none of (ADR-0010).
    assert.deepEqual(await routeTable(directory.publicRoutes), [
      "DELETE /tokens",
      "DELETE /tokens/current",
      "GET /me",
      "HEAD /me",
      "POST /tokens",
      "PUT /password",
    ]);
  });

  it("answers nothing at all where those routes would have been", async () => {
    const user = await admit(password);
    const issued = await logIn(user.id);

    // Spelled the ways an injected prompt would try them, on the surface it can
    // actually reach. Each carries a body that would be an escalation if anything read
    // it, and each is 404 because there is no route, not because a handler refused.
    const tried: Array<["PATCH" | "PUT" | "POST" | "DELETE", string, Record<string, unknown>]> = [
      ["PATCH", `${users}/${user.id}`, { attributes: { role: "admin" } }],
      ["PUT", `${users}/${user.id}`, { attributes: { role: "admin" } }],
      ["POST", `${users}/${user.id}/attributes`, { role: "admin" }],
      ["PUT", `${users}/${user.id}/attributes`, { role: "admin" }],
      ["PUT", `${users}/${user.id}/password`, { newPassword: "chosen by the agent" }],
      ["POST", `${users}/${user.id}/password`, { newPassword: "chosen by the agent" }],
      ["PUT", `${users}/password`, { newPassword: "chosen by the agent" }],
      ["POST", `${users}/${user.id}/tokens`, {}],
      ["POST", `${users}/tokens`, { user: user.id }],
      ["POST", "/tokens", { user: user.id }],
      ["DELETE", `${users}/${user.id}`, {}],
      ["DELETE", users, {}],
    ];
    for (const [method, url, payload] of tried) {
      const response = await agentServer.fastify.inject({ method, url, payload });
      assert.equal(response.statusCode, 404, `${method} ${url} answered ${response.body}`);
    }

    // And afterwards nothing about the User has moved: the Attributes are still the
    // column's default, the password the agent tried to choose does not work, the one
    // it was created with still does, no Token was minted, and the User is still there
    // to be read (ADR-0029 — nothing removes one).
    const after = await readBack(user.id);
    assert.deepEqual(after.attributes, {});
    assert.equal((await attempt(user.id, "chosen by the agent")).statusCode, 401);
    await works(issued.token, user, "the User's own Token, after every attempt above");
    assert.deepEqual(after, user);
  });

  it("keeps the created User's Attributes at the column's default, whatever is posted", async () => {
    // The escalation the whole boundary exists to close, restated where the methods
    // that *can* set Attributes are: the route has no such parameter, so what a
    // talked-into agent posts reaches nothing (ADR-0029).
    const escalated = await agentServer.fastify.inject({
      method: "POST",
      url: users,
      payload: {
        password,
        attributes: { role: "admin" },
        safUser: { attributes: { role: "admin" } },
      },
    });
    assert.equal(escalated.statusCode, 201, escalated.body);
    const created = escalated.json<UserRecord>();
    assert.deepEqual(created.attributes, {});

    // Including through the credential they were given: logging in as the User the
    // agent made shows the same empty Attributes to the component and to whoever
    // branches on them.
    assert.deepEqual((await logIn(created.id)).user.attributes, {});
  });
});

describe("a User and a Signal in one transaction", () => {
  /** The Signals the Signal Worker's own read route reports, newest first. */
  async function signals(kind: string): Promise<Array<{ payload: { user?: string } }>> {
    const response = await agentServer.fastify.inject({
      method: "GET",
      url: `/signals?kind=${kind}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ signals: Array<{ payload: { user?: string } }> }>().signals;
  }

  it("commits as one, which is how a deployment gets a `user.created` Signal", async () => {
    // The Users component is **not** a Producer: it takes no reference to the Signal
    // Worker and emits nothing, because the worker is globally serial and a Signal per
    // User event would put a Run behind one (ADR-0029). A deployment that wants it emits
    // it itself, and this is the pattern — both writes take the caller's transaction
    // (ADR-0023), so there is one.
    const created = await db.tx(async (tx) => {
      const user = await directory.create(tx);
      await directory.setAttributes(tx, user.id, { invitedBy: "the Operator" });
      await worker.emit(tx, { kind: "user.created", payload: { user: user.id } });
      return user;
    });

    // Both sides, observed the way the agent observes them: two parts, two schemas,
    // one commit.
    assert.deepEqual((await readBack(created.id)).attributes, { invitedBy: "the Operator" });
    assert.ok(
      (await signals("user.created")).some((signal) => signal.payload.user === created.id),
      "the Signal should name the User the same transaction created",
    );
  });

  it("rolls back as one, so neither the User nor the Signal survives", async () => {
    // The failure this pattern exists to prevent: a Signal telling a Handler about
    // somebody who was never admitted, or a User nothing was ever told about. Ambient
    // enlistment is not available — a second handle would take its own connection from
    // the pool and its write would survive this rollback with nothing reported — which
    // is why both calls take the transaction rather than finding one.
    let attempted: UserRecord | undefined;
    await assert.rejects(
      db.tx(async (tx) => {
        attempted = await directory.create(tx);
        await worker.emit(tx, { kind: "user.created", payload: { user: attempted.id } });
        throw new Error("the Operator's own write failed");
      }),
      /the Operator's own write failed/,
    );

    assert.ok(attempted !== undefined);
    assert.equal(
      (await agentServer.fastify.inject({ method: "GET", url: `${users}/${attempted.id}` }))
        .statusCode,
      404,
      "the User should not have been admitted",
    );
    assert.ok(
      !(await signals("user.created")).some((signal) => signal.payload.user === attempted?.id),
      "the Signal should not have been emitted",
    );
  });
});
