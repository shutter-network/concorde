import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type Component, serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import { createSignalWorker, type SignalWorker } from "../signals/index.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import type { UserRecord } from "./routes.ts";
import * as usersSchema from "./schema/index.ts";
import { createUsers, type Users } from "./users.ts";

const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

const users = "/users";

let database: TestDatabase;
let db: Db;
let directory: Users;
let worker: SignalWorker;
let agentServer: Component & { readonly fastify: FastifyInstance };

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

before(async () => {
  database = await createTestDatabase("users_trusted");
  db = database.db;
  await applySchema(db, signalsSchema, usersSchema);

  agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });

  directory = createUsers({ db, agentServer });
  worker = createSignalWorker({
    db,
    runtime: { run: async () => ({ ok: true, usage: [] }) },
    handlers: {},
    logger: silent,
  });

  await agentServer.fastify.register(worker.agentRoutes);
});

after(async () => {
  await agentServer.stop();
  await worker.stop();
  await database.drop();
});

function admit(): Promise<UserRecord> {
  return db.tx((tx) => directory.create(tx));
}

async function readBack(id: string): Promise<UserRecord> {
  const response = await agentServer.fastify.inject({ method: "GET", url: `${users}/${id}` });
  assert.equal(
    response.statusCode,
    200,
    `GET ${users}/${id} should have answered: ${response.body}`,
  );
  return response.json<UserRecord>();
}

describe("setting Attributes from trusted code", () => {
  it("is where authorization lives, and it is visible everywhere a User is", async () => {
    const user = await admit();
    assert.deepEqual(user.attributes, {}, "a created User should have none");

    const granted = { role: "operator", groups: ["support", "billing"] };
    await db.tx((tx) => directory.setAttributes(tx, user.id, granted));

    assert.deepEqual((await readBack(user.id)).attributes, granted);
    assert.deepEqual((await directory.get(user.id))?.attributes, granted);
    assert.deepEqual(
      (await directory.list({ limit: 100 })).find((each) => each.id === user.id)?.attributes,
      granted,
    );
  });

  it("replaces them wholesale rather than merging", async () => {
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

    await db.tx((tx) => directory.setAttributes(tx, user.id, {}));
    assert.deepEqual((await readBack(user.id)).attributes, {});

    await db.tx((tx) => directory.setAttributes(tx, user.id, ["support", "billing"]));
    assert.deepEqual((await readBack(user.id)).attributes, ["support", "billing"]);
  });

  it("takes the caller's transaction, so a rollback grants nothing", async () => {
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
    await assert.rejects(
      db.tx((tx) => directory.setAttributes(tx, nobody, { role: "admin" })),
      new RegExp(`No user ${nobody} exists`),
    );
  });
});

describe("admitting a User and giving them a credential", () => {
  it("is one transaction, because `create` takes the caller's", async () => {
    let attempted: UserRecord | undefined;
    await assert.rejects(
      db.tx(async (tx) => {
        attempted = await directory.create(tx);
        throw new Error("the Operator's own write failed");
      }),
      /the Operator's own write failed/,
    );

    assert.ok(attempted !== undefined, "the User should have been created before the rollback");
    assert.equal(await directory.get(attempted.id), undefined);
  });
});

describe("a User and a Signal in one transaction", () => {
  async function signals(kind: string): Promise<Array<{ payload: { user?: string } }>> {
    const response = await agentServer.fastify.inject({
      method: "GET",
      url: `/signals?kind=${kind}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ signals: Array<{ payload: { user?: string } }> }>().signals;
  }

  it("commits as one, which is how a deployment gets a `user.created` Signal", async () => {
    const created = await db.tx(async (tx) => {
      const user = await directory.create(tx);
      await directory.setAttributes(tx, user.id, { invitedBy: "the Operator" });
      await worker.emit(tx, { kind: "user.created", payload: { user: user.id } });
      return user;
    });

    assert.deepEqual((await readBack(created.id)).attributes, { invitedBy: "the Operator" });
    assert.ok(
      (await signals("user.created")).some((signal) => signal.payload.user === created.id),
      "the Signal should name the User the same transaction created",
    );
  });

  it("rolls back as one, so neither the User nor the Signal survives", async () => {
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
