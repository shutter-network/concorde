/**
 * The User Manager, as the agent and an Operator can observe it.
 *
 * The subject is not that Fastify routes a request, and it is never how a User is
 * stored: every assertion here is made over HTTP against a real Fastify instance and
 * real PostgreSQL, and **nothing inserts a row directly**. The one surface that has
 * no route of its own — creating a User from trusted code inside a transaction — is
 * reached the way an Operator reaches it and then confirmed over HTTP, which keeps
 * it tested without a second seam.
 *
 * The load-bearing test is `takes no Attributes, whatever is posted`. It is the
 * security boundary of the whole part (ADR-0029): Attributes are where authorization
 * lives, so an agent that could choose them could mint itself an administrator, and
 * an injected prompt reaches this surface with nothing in its way.
 *
 * The Signal Worker is deliberately absent from this file. The User Manager takes no
 * reference to it, emits no Signals, and its schema is the only one pushed here — so a
 * deployment with identity and no Signals at all is what these tests actually run.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { type Component, serverComponent } from "../components.ts";
import type { Db } from "../db/index.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import type { UserRecord } from "./routes.ts";
import * as usersSchema from "./schema.ts";
import { createUsers, type Users } from "./users.ts";

let database: TestDatabase;
let db: Db;
let directory: Users;
/**
 * The Agent server: a bare Fastify instance an Operator constructed, given a place in
 * a start order — and the thing the User Manager is handed to wire itself to.
 */
let agentServer: Component & { readonly fastify: FastifyInstance };

/**
 * Where the constructor put the plugin, and where the Operator put it a second time.
 *
 * The first is the prefix `createUsers` registers under when it is handed a server, so
 * the URLs asserted here are the ones a reader will type: the plugin's own paths are
 * `/`, `/` and `/:id`, and it is the prefix that makes them `/users`, `/users` and
 * `/users/:id`. The second is nothing like it, because the claim is that the default
 * is a default and not a policy: the exported plugin carries no prefix of its own, so
 * the same routes answer under both, the same Users are visible through both, and
 * neither URL is baked into the routes.
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

  // The framework constructs no server: this is a bare Fastify instance, the same call
  // an Operator's entry point makes. `serverComponent` adds only where it listens, and
  // nothing here starts it — `inject` needs no socket — so those options go unused.
  agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });

  // A Token lifetime is required of every construction, and nothing in this file
  // issues one: logging in is observable on the Public server, which is
  // `login.test.ts`. No Public server is passed, which is a deployment with no
  // password login at all, and it changes nothing about what is asserted below.
  //
  // Handed the Agent server, so the User surface is registered on it under `/users` by
  // the constructor: nothing here registers that plugin, and nothing here could forget
  // to (ADR-0032).
  directory = createUsers({ db, tokenTtl: 60 * 60 * 1000, agentServer });

  // The second registration is the Operator's own, by hand, which is the door the
  // exported plugin is.
  await agentServer.fastify.register(directory.agentRoutes, { prefix: alsoAt });

  // Sequential and awaited, because `created_at` is what the list is ordered by.
  fixture.push(await created());
  fixture.push(await created());
  fixture.push(await db.tx((tx) => directory.create(tx)));
});

after(async () => {
  await agentServer.stop();
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

/** One `POST /users`, with whatever body the caller wants sent — or none at all. */
function post(payload?: Record<string, unknown>, at = prefix) {
  return payload === undefined
    ? agentServer.fastify.inject({ method: "POST", url: at })
    : agentServer.fastify.inject({ method: "POST", url: at, payload });
}

/** Creates a User over HTTP and asserts only that it was created. */
async function created(payload?: Record<string, unknown>, at = prefix): Promise<UserRecord> {
  const response = await post(payload, at);
  assert.equal(response.statusCode, 201, `POST ${at} should have answered: ${response.body}`);
  return response.json<UserRecord>();
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

describe("creating a User over the Agent server", () => {
  it("creates one with an opaque id, empty Attributes, and a creation time", async () => {
    const user = fixture[0];
    assert.ok(user !== undefined);
    // An opaque Gateway-issued id and nothing resembling a name or an email
    // (ADR-0014): the agent supplied nothing and could not have.
    assert.match(user.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(user.attributes, {});
    assert.equal(new Date(user.createdAt).toISOString(), user.createdAt);

    // The created record is the stored one, which is what makes `create` returning
    // the User a substitute for a read-back rather than a convenience.
    assert.deepEqual(await readBack(user.id), user);
  });

  it("takes no Attributes, whatever is posted", async () => {
    // The escalation this closes: an injected prompt talks the agent into creating a
    // User with `role: "admin"`, and the route has no parameter for it to arrive
    // through — no validator, no allow-list, nothing to configure or bypass
    // (ADR-0029). What the row gets is the column's default.
    const escalated = await created({
      attributes: { role: "admin", groups: ["operators"] },
      // The same claim spelled the other ways someone might try it.
      attribute: { role: "admin" },
      metadata: { role: "admin" },
    });
    assert.deepEqual(escalated.attributes, {});
    assert.deepEqual((await readBack(escalated.id)).attributes, {});
  });

  it("takes no id, so a User cannot be created at a chosen one", async () => {
    // Seeding is the Operator's, out of band and once: a User has no natural key, so
    // "create this one if absent" is not expressible and an explicit id would only
    // invite a hardcoded uuid into a deployment's source (ADR-0029).
    const chosen = "11111111-2222-3333-4444-555555555555";
    const user = await created({ id: chosen });
    assert.notEqual(user.id, chosen);
    assert.equal((await read(`/${chosen}`)).statusCode, 404);
  });

  it("needs no body at all, and refuses a query parameter", async () => {
    const user = await created();
    assert.deepEqual(await readBack(user.id), user);

    // There is nothing to pass here either, so asking is an error rather than a
    // request silently answered as though it had been honoured.
    const scoped = await agentServer.fastify.inject({
      method: "POST",
      url: `${prefix}?attributes=admin`,
    });
    assert.equal(scoped.statusCode, 400);
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
});

describe("creating a User from the Operator's own code", () => {
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
      const created = await directory.create(tx);
      assert.equal(
        (await read(`/${created.id}`)).statusCode,
        404,
        "an uncommitted User should not be visible",
      );
      assert.equal(await directory.get(created.id), undefined);
      return created;
    });

    assert.deepEqual(await readBack(user.id), user);
  });

  it("reads through the same methods the routes answer with", async () => {
    const one = fixture[2];
    assert.ok(one !== undefined);
    assert.deepEqual(await directory.get(one.id), one);
    assert.deepEqual(await directory.list({ limit: 1 }), await readUsers("?limit=1"));
    assert.equal(await directory.get("2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21"), undefined);
  });
});

describe("the Agent server plugin", () => {
  it("honours whatever prefix the Operator registers it under", async () => {
    // The prefix is Fastify's own mechanism and nothing of ours: the plugin carries
    // none, and `/users` is where the constructor put it rather than where the routes
    // think they live, so the layout stays the Operator's through this plugin
    // (ADR-0032).
    const user = await created(undefined, alsoAt);
    assert.deepEqual((await read(`/${user.id}`, alsoAt)).json(), user);
    // And the same User through the registration the constructor made, because both
    // are the same Manager over the same Db.
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
