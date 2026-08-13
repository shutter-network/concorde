/**
 * The Users component, as the agent, a person and an Operator can observe it.
 *
 * The subject is not that Fastify routes a request, and it is never how a User is stored: every
 * assertion here is made over HTTP against real Fastify instances and real PostgreSQL, and
 * **nothing inserts a row directly**. Admitting a User has no route of its own, so it is reached
 * the way an Operator reaches it and then confirmed over HTTP, which keeps it tested without a
 * second seam.
 *
 * The load-bearing test is `carries no route that creates a User, sets Attributes or removes
 * one`. It is the security boundary of the whole part (ADR-0029,
 * [ADR-0052](../../docs/adr/0052-authentication-is-a-component-again-and-the-public-server-aggregates.md)):
 * Attributes are where authorization lives and an Auth's secret is what a person presents, so an
 * agent that could mint a User **and** give it a credential could log in as an administrator. It
 * asserts the Agent plugin's **complete** route table rather than probing a list of URLs, so a
 * route added later shows up there and fails, which is what makes it an assertion of absence
 * rather than a habit of not adding things.
 *
 * `GET /users/me` is the one Public route, and the scheme behind it is a fake: this component
 * authenticates nobody, so what is worth proving here is that the route echoes whatever the
 * server's hook assigned and refuses when the hook does. What a real scheme does is
 * `src/password-auth/`'s.
 *
 * The Signal Worker is deliberately absent from this file. This component takes no reference to
 * it, emits no Signals, and its schema is the only one pushed here, so a deployment with identity
 * and no Signals at all is what these tests actually run.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { type FakeAuth, fakeAuth } from "../test-support/fake-auth.ts";
import type { UserRecord } from "./routes.ts";
import * as usersSchema from "./schema/index.ts";
import { createUsers, type Users } from "./users.ts";

let database: TestDatabase;
let db: Db;
let directory: Users;
/**
 * The two servers: bare Fastify instances an Operator constructed, each given a place in a start
 * order, and the things this component is handed so that it wires itself to them.
 */
let agentServer: ServerComponent<FastifyInstance>;
let publicServer: ServerComponent<FastifyInstance>;
/** The only scheme this deployment accepts, told per test what to answer. */
let scheme: FakeAuth;

/**
 * Where the constructor put the plugin, and where the Operator put it a second time.
 *
 * The first is the prefix `createUsers` registers under when it is handed a server, so the URLs
 * asserted here are the ones a reader will type: the plugin's own paths are `/` and `/:id`, and it
 * is the prefix that makes them `/users` and `/users/:id`. The second is nothing like it, because
 * the claim is that the default is a default and not a policy: the exported plugin carries no
 * prefix of its own, so the same routes answer under both, the same Users are visible through
 * both, and neither URL is baked into the routes.
 */
const prefix = "/users";
const alsoAt = "/admin/people";

/** The Users the fixture created, oldest first. */
const fixture: UserRecord[] = [];

before(async () => {
  database = await createTestDatabase("users");
  db = database.db;
  // The part's own schema, alone: it owns a PostgreSQL schema of its own and references
  // no other part's tables, so nothing else has to be pushed for it to work.
  await applySchema(db, usersSchema);

  // The framework constructs no server: these are bare Fastify instances, the same call an
  // Operator's entry point makes. `serverComponent` adds where each listens and the schemes it
  // accepts, and nothing here starts either, `inject` needing no socket, so those options go
  // unused.
  agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  publicServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  // Registered before the component, though the order does not matter: the hook reads the
  // registered Auths per request rather than closing over them (ADR-0052).
  scheme = fakeAuth("Bearer");
  publicServer.registerAuth(scheme);

  // Handed both servers, so the reads are on the Agent server under `/users` and `GET /users/me`
  // is on the Public one: nothing here registers either plugin, and nothing here could forget to
  // (ADR-0032).
  directory = createUsers({ db, agentServer, publicServer });

  // The second registration is the Operator's own, by hand, which is the door the
  // exported plugin is.
  await agentServer.fastify.register(directory.agentRoutes, { prefix: alsoAt });

  // Sequential and awaited, because `created_at` is what the list is ordered by.
  fixture.push(await created());
  fixture.push(await created());
  fixture.push(await created());
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

/**
 * One read over the Agent server, under the prefix the Operator chose.
 *
 * `path` is relative to that prefix, exactly as the plugin's own paths are, so `""`
 * is the list and `/${id}` is one User.
 */
function read(path: string, at = prefix) {
  return agentServer.fastify.inject({ method: "GET", url: `${at}${path}` });
}

/** A User admitted from trusted code, which is the only way one is admitted (ADR-0052). */
function created(): Promise<UserRecord> {
  return db.tx((tx) => directory.create(tx));
}

/** Reads one User back, so an assertion is about the row and not about a response. */
async function readBack(id: string): Promise<UserRecord> {
  const response = await read(`/${id}`);
  assert.equal(
    response.statusCode,
    200,
    `GET ${prefix}/${id} should have answered: ${response.body}`,
  );
  return response.json<UserRecord>();
}

async function readUsers(query = ""): Promise<UserRecord[]> {
  const response = await read(query);
  assert.equal(
    response.statusCode,
    200,
    `GET ${prefix}${query} should have answered: ${response.body}`,
  );
  return response.json<{ users: UserRecord[] }>().users;
}

/**
 * Every route a plugin contributes, as `METHOD path` and sorted.
 *
 * Registered under **no prefix**, so what comes back is the plugin's own paths, which is the
 * thing being asserted, since the prefix is the Operator's (ADR-0021). Fastify's `onRoute` hook is
 * the mechanism, so this is the router's own account of what exists rather than a list somebody
 * kept up to date, and the `HEAD` entries are Fastify's own siblings for each `GET`.
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

describe("admitting a User from the Operator's own code", () => {
  it("creates one with an opaque id, empty Attributes, and a creation time", async () => {
    const user = fixture[0];
    assert.ok(user !== undefined);
    // An opaque Gateway-issued id and nothing resembling a name or an email
    // (ADR-0014): the caller supplied nothing and could not have.
    assert.match(user.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(user.attributes, {});
    assert.equal(new Date(user.createdAt).toISOString(), user.createdAt);

    // The created record is the stored one, which is what makes `create` returning
    // the User a substitute for a read-back rather than a convenience.
    assert.deepEqual(await readBack(user.id), user);
  });

  it("takes no id, so a User cannot be created at a chosen one", async () => {
    // Seeding is the Operator's, out of band and once: a User has no natural key, so
    // "create this one if absent" is not expressible and an explicit id would only
    // invite a hardcoded uuid into a deployment's source (ADR-0029). There is no
    // parameter for one on the method and no route through which one could arrive.
    const chosen = "11111111-2222-3333-4444-555555555555";
    assert.notEqual((await created()).id, chosen);
    assert.equal((await read(`/${chosen}`)).statusCode, 404);
  });

  it("admits nobody when the caller's transaction rolls back", async () => {
    // `create` takes the transaction rather than finding one (ADR-0023), so
    // admitting a User and whatever the Operator records about them cannot come
    // apart. Proved from the outside: the User is not there afterwards.
    let attempted: UserRecord | undefined;
    await assert.rejects(
      db.tx(async (tx) => {
        attempted = await directory.create(tx);
        throw new Error("the Operator's own write failed");
      }),
      /the Operator's own write failed/,
    );
    assert.ok(attempted !== undefined, "the User should have been created before the rollback");
    assert.equal((await read(`/${attempted.id}`)).statusCode, 404);
  });

  it("cannot be read back before the caller commits", async () => {
    // The consequence of writes taking a transaction and reads not: the read is on
    // another connection, so it cannot see the caller's own uncommitted write.
    // `create` returns the User, which is why the read-back has no reason to exist.
    const user = await db.tx(async (tx) => {
      const inserted = await directory.create(tx);
      assert.equal(
        (await read(`/${inserted.id}`)).statusCode,
        404,
        "an uncommitted User should not be visible",
      );
      assert.equal(await directory.get(inserted.id), undefined);
      return inserted;
    });

    assert.deepEqual(await readBack(user.id), user);
  });
});

describe("reading Users over the Agent server", () => {
  it("reports one User by id, and says so when there is none", async () => {
    const one = fixture[1];
    assert.ok(one !== undefined);
    assert.deepEqual(await readBack(one.id), one);

    // Fastify's own error shape, so the surface answers one error shape rather than
    // two.
    const absent = await read("/2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21");
    assert.equal(absent.statusCode, 404);
    assert.deepEqual(absent.json(), {
      statusCode: 404,
      error: "Not Found",
      message: "no User 2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21 exists",
    });

    // A malformed id is a bad request rather than a 500 from PostgreSQL refusing to
    // cast it, which is what an unvalidated parameter would produce.
    assert.equal((await read("/not-an-id")).statusCode, 400);

    // A single record takes no parameters, so a filter on one is refused rather than
    // answered as though it had been applied.
    assert.equal((await read(`/${one.id}?attributes=admin`)).statusCode, 400);
  });

  it("lists Users newest first, in an envelope, under a capped limit", async () => {
    const list = await readUsers();
    const ours = new Set(fixture.map((user) => user.id));
    assert.deepEqual(
      list.filter((user) => ours.has(user.id)),
      [...fixture].reverse(),
      "the fixture's Users should come back newest first",
    );

    assert.equal((await readUsers("?limit=2")).length, 2);

    for (const query of ["limit=0", "limit=201", "limit=nine"]) {
      assert.equal((await read(`?${query}`)).statusCode, 400, query);
    }
  });

  it("refuses an unknown query parameter rather than answering with everything", async () => {
    // Attributes are arbitrary JSON with nothing to index and a User has no natural
    // key, so there is no filter to pass — and a `?role=admin` answered 200 reads as
    // though one had been.
    for (const query of ["role=admin", "attributes=admin", "limt=2"]) {
      const refused = await read(`?${query}`);
      assert.equal(refused.statusCode, 400, query);
      assert.match(refused.json<{ message: string }>().message, /not a parameter of this route/);
    }
  });

  it("reads through the same methods the routes answer with", async () => {
    const one = fixture[2];
    assert.ok(one !== undefined);
    assert.deepEqual(await directory.get(one.id), one);
    assert.deepEqual(await directory.list({ limit: 1 }), await readUsers("?limit=1"));
    assert.equal(await directory.get("2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21"), undefined);
  });
});

describe("the Agent server", () => {
  it("carries no route that creates a User, sets Attributes or removes one", async () => {
    // The assertion of **absence**, and the reason it is the router's own account of what exists
    // rather than a list of URLs to probe: a route added later appears here and fails this, which
    // is what makes the property maintained rather than merely true today. `POST /` is what is
    // gone: it was removed rather than stripped of its password parameter, so the agent's surface
    // on identity is two reads (ADR-0052).
    assert.deepEqual(
      await routeTable(directory.agentRoutes),
      ["GET /", "GET /:id", "HEAD /", "HEAD /:id"],
      "the Agent plugin should contribute two reads and nothing else",
    );
  });

  it("answers nothing at all where those routes would have been", async () => {
    const user = await created();

    // Spelled the ways an injected prompt would try them, on the surface it can actually reach.
    // Each carries a body that would be an escalation if anything read it, and each is 404
    // because there is no route, not because a handler refused.
    const tried: Array<["PATCH" | "PUT" | "POST" | "DELETE", string, Record<string, unknown>]> = [
      // The create, which is the one that was removed, in every spelling of it.
      ["POST", prefix, { password: "chosen by the agent" }],
      ["POST", prefix, {}],
      ["POST", `${prefix}/`, { attributes: { role: "admin" } }],
      ["PATCH", `${prefix}/${user.id}`, { attributes: { role: "admin" } }],
      ["PUT", `${prefix}/${user.id}`, { attributes: { role: "admin" } }],
      ["POST", `${prefix}/${user.id}/attributes`, { role: "admin" }],
      ["PUT", `${prefix}/${user.id}/attributes`, { role: "admin" }],
      ["PUT", `${prefix}/${user.id}/password`, { newPassword: "chosen by the agent" }],
      ["POST", `${prefix}/${user.id}/password`, { newPassword: "chosen by the agent" }],
      ["PUT", `${prefix}/password`, { newPassword: "chosen by the agent" }],
      ["POST", `${prefix}/${user.id}/tokens`, {}],
      ["POST", `${prefix}/tokens`, { user: user.id }],
      ["POST", "/tokens", { user: user.id }],
      ["DELETE", `${prefix}/${user.id}`, {}],
      ["DELETE", prefix, {}],
    ];
    for (const [method, url, payload] of tried) {
      const response = await agentServer.fastify.inject({ method, url, payload });
      assert.equal(response.statusCode, 404, `${method} ${url} answered ${response.body}`);
    }

    // And afterwards nothing about the User has moved: the Attributes are still the column's
    // default and the User is still there to be read: nothing removes one (ADR-0029).
    assert.deepEqual(await readBack(user.id), user);
  });

  it("carries no `/me`, having no request it could answer one for", async () => {
    // The Agent server authenticates nobody at all (ADR-0010), so `request.safUser` is never
    // assigned there and there is nothing for such a route to echo. It is on the Public server
    // and only there.
    //
    // Two different refusals, and the second is worth pinning rather than glossing: `/me` at the
    // root matches no route at all, while `/users/me` matches `GET /users/:id` and is refused as
    // an id that is not a uuid. Neither is an answer, and neither is a 200.
    assert.equal((await agentServer.fastify.inject({ method: "GET", url: "/me" })).statusCode, 404);
    assert.equal((await read("/me")).statusCode, 400);
  });
});

describe("GET /users/me on the Public server", () => {
  it("echoes the User the server authenticated, whichever scheme named them", async () => {
    const user = await created();
    scheme.answers({ kind: "authenticated", user });
    try {
      const me = await publicServer.fastify.inject({ method: "GET", url: `${prefix}/me` });
      assert.equal(me.statusCode, 200, me.body);
      // The same record the Agent server's read answers with, byte for byte: one shape, two
      // response schemas, and a field declared in one and forgotten in the other differs here.
      assert.deepEqual(me.json(), await readBack(user.id));
    } finally {
      scheme.answers({ kind: "absent" });
    }
  });

  it("refuses when no scheme named anybody, and reads no credential of its own", async () => {
    // The whole of this component's part in authentication: it takes the hook and never looks
    // at the request. So a Token is not something this route can be given, and the refusal is
    // the server's (ADR-0052).
    const refused = await publicServer.fastify.inject({
      method: "GET",
      url: `${prefix}/me`,
      headers: { authorization: "Bearer whatever" },
    });
    assert.equal(refused.statusCode, 401, refused.body);
    assert.deepEqual(refused.json(), {
      statusCode: 401,
      error: "Unauthorized",
      message: "authentication failed",
    });
    // And the scheme was asked, which is what says the hook ran at all.
    assert.equal(scheme.asked.at(-1)?.url, `${prefix}/me`);
  });

  it("refuses a query parameter rather than answering it", async () => {
    const user = await created();
    scheme.answers({ kind: "authenticated", user });
    try {
      const refused = await publicServer.fastify.inject({
        method: "GET",
        url: `${prefix}/me?user=someone-else`,
      });
      assert.equal(refused.statusCode, 400, refused.body);
      assert.match(refused.json<{ message: string }>().message, /not a parameter of this route/);
    } finally {
      scheme.answers({ kind: "absent" });
    }
  });
});

describe("the Agent server plugin", () => {
  it("honours whatever prefix the Operator registers it under", async () => {
    // The prefix is Fastify's own mechanism and nothing of ours: the plugin carries
    // none, and `/users` is where the constructor put it rather than where the routes
    // think they live, so the layout stays the Operator's through this plugin
    // (ADR-0032).
    const user = await created();
    assert.deepEqual((await read(`/${user.id}`, alsoAt)).json(), user);
    // And the same User through the registration the constructor made, because both
    // are the same component over the same Db.
    assert.deepEqual(await readBack(user.id), user);

    // Nothing answers where the plugin was not put, including at the root, which is
    // where a plugin that named its own resource would have put the routes.
    for (const url of ["/", "/directory"]) {
      assert.equal((await agentServer.fastify.inject({ method: "GET", url })).statusCode, 404, url);
      assert.equal(
        (await agentServer.fastify.inject({ method: "POST", url })).statusCode,
        404,
        url,
      );
    }
  });
});
