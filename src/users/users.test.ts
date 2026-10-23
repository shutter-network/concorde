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
let agentServer: ServerComponent<FastifyInstance>;
let publicServer: ServerComponent<FastifyInstance>;
let scheme: FakeAuth;

const prefix = "/users";
const alsoAt = "/admin/people";

const fixture: UserRecord[] = [];

before(async () => {
  database = await createTestDatabase("users");
  db = database.db;
  await applySchema(db, usersSchema);

  agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  publicServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });
  scheme = fakeAuth("Bearer");
  publicServer.registerAuth(scheme);

  directory = createUsers({ db, agentServer, publicServer });

  await agentServer.fastify.register(directory.agentRoutes, { prefix: alsoAt });

  fixture.push(await created());
  fixture.push(await created());
  fixture.push(await created());
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

function read(path: string, at = prefix) {
  return agentServer.fastify.inject({ method: "GET", url: `${at}${path}` });
}

function created(): Promise<UserRecord> {
  return db.tx((tx) => directory.create(tx));
}

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
    assert.match(user.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(user.attributes, {});
    assert.equal(new Date(user.createdAt).toISOString(), user.createdAt);

    assert.deepEqual(await readBack(user.id), user);
  });

  it("takes no id, so a User cannot be created at a chosen one", async () => {
    const chosen = "11111111-2222-3333-4444-555555555555";
    assert.notEqual((await created()).id, chosen);
    assert.equal((await read(`/${chosen}`)).statusCode, 404);
  });

  it("admits nobody when the caller's transaction rolls back", async () => {
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

    const absent = await read("/2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21");
    assert.equal(absent.statusCode, 404);
    assert.deepEqual(absent.json(), {
      statusCode: 404,
      error: "Not Found",
      message: "No user 2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21 exists",
    });

    assert.equal((await read("/not-an-id")).statusCode, 400);

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
    for (const query of ["role=admin", "attributes=admin", "limt=2"]) {
      const refused = await read(`?${query}`);
      assert.equal(refused.statusCode, 400, query);
      assert.match(refused.json<{ message: string }>().message, /Unknown query parameter/);
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
    assert.deepEqual(
      await routeTable(directory.agentRoutes),
      ["GET /", "GET /:id", "HEAD /", "HEAD /:id"],
      "the Agent plugin should contribute two reads and nothing else",
    );
  });

  it("answers nothing at all where those routes would have been", async () => {
    const user = await created();

    const tried: Array<["PATCH" | "PUT" | "POST" | "DELETE", string, Record<string, unknown>]> = [
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

    assert.deepEqual(await readBack(user.id), user);
  });

  it("carries no `/me`, having no request it could answer one for", async () => {
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
      assert.deepEqual(me.json(), await readBack(user.id));
    } finally {
      scheme.answers({ kind: "absent" });
    }
  });

  it("refuses when no scheme named anybody, and reads no credential of its own", async () => {
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
      assert.match(refused.json<{ message: string }>().message, /Unknown query parameter/);
    } finally {
      scheme.answers({ kind: "absent" });
    }
  });
});

describe("the Agent server plugin", () => {
  it("honours whatever prefix the Operator registers it under", async () => {
    const user = await created();
    assert.deepEqual((await read(`/${user.id}`, alsoAt)).json(), user);
    assert.deepEqual(await readBack(user.id), user);

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
