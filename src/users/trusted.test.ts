/**
 * The asymmetry the whole part is arranged around: what trusted code may do, and what the agent
 * may not.
 *
 * Signal Handlers and an Operator's entry point are trusted code and hold the
 * constructed object. The Agent server is the one surface an injected prompt reaches
 * and it authenticates nobody at all. So both of this component's writes, admitting a
 * User and setting their Attributes, are methods and not routes, and this file is where that
 * stops being a description and becomes a property.
 *
 * **Nothing here is about a credential.** The password digest and the Token left for Password Auth,
 * so what a Token is worth, who may mint one and what a wrong password answers are all
 * `src/password-auth/`'s, and the Public server has no part in this file.
 *
 * The subject is what a client can observe, as everywhere else in this part: every assertion is
 * made over HTTP against a real Fastify instance and real PostgreSQL, and **nothing reads a
 * column**. Attributes set from trusted code are confirmed by reading them back over the Agent
 * server and through the component's own reads.
 *
 * The Signal Worker is present here and nowhere else in this part, for one criterion: a
 * transaction that creates a User and emits a Signal must commit or roll back as one. The Users
 * component is not a Producer and emits nothing itself, so that pattern is the
 * deployment's, and this is where it is proved to work.
 *
 * A database of this file's own, because no two test files may share one.
 */

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

/** A well-formed id that names nobody, for the calls that must refuse one. */
const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

const users = "/users";

let database: TestDatabase;
let db: Db;
let directory: Users;
let worker: SignalWorker;
/**
 * The Agent server, exactly as an Operator holds it: a bare Fastify instance of their own, given a
 * place in a start order, and handed to the component so that it registers its route group itself.
 * Nothing here starts it, `inject` needing no socket, so the listen options go unused.
 */
let agentServer: Component & { readonly fastify: FastifyInstance };

/** Nothing here starts the worker, so nothing should be printed by one. */
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

before(async () => {
  database = await createTestDatabase("users_trusted");
  db = database.db;
  // Both schemas pushed in one call, because one test here spans both parts. The component needs
  // no other part's tables to work, which `users.test.ts` is what proves.
  await applySchema(db, signalsSchema, usersSchema);

  agentServer = serverComponent(Fastify(), { port: 0, host: "127.0.0.1" });

  // Handed the Agent server, so `/users` is where the constructor put the read plugin: nothing
  // here registers it, and nothing here could forget to. No Public server, because
  // `GET /users/me` needs a scheme registered and no scheme is this file's subject.
  directory = createUsers({ db, agentServer });
  // Constructed and never started: this file emits Signals and reads them back, and a running
  // worker would take them off the queue and try to handle them, so the Handler map it is
  // constructed with is empty and nothing dispatches.
  worker = createSignalWorker({
    db,
    runtime: { run: async () => ({ ok: true }) },
    handlers: {},
    logger: silent,
  });

  // The Signal Worker's own routes by hand, which is the door the exported plugin is, beside ours
  // on the same instance, which is what `serverComponent` carrying the Fastify instance is for.
  await agentServer.fastify.register(worker.agentRoutes);
});

after(async () => {
  await agentServer.stop();
  await worker.stop();
  await database.drop();
});

/** A User, admitted from trusted code, which is the only way one is admitted. */
function admit(): Promise<UserRecord> {
  return db.tx((tx) => directory.create(tx));
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

describe("setting Attributes from trusted code", () => {
  it("is where authorization lives, and it is visible everywhere a User is", async () => {
    const user = await admit();
    assert.deepEqual(user.attributes, {}, "a created User should have none");

    const granted = { role: "operator", groups: ["support", "billing"] };
    await db.tx((tx) => directory.setAttributes(tx, user.id, granted));

    // Over the Agent server, so the agent can resolve an id it met in a Signal payload
    // and see the grouping that governs it.
    assert.deepEqual((await readBack(user.id)).attributes, granted);
    // Through the reads, which are what a Signal Handler making an authorization
    // decision actually calls, and what an Auth calls to answer with a record.
    assert.deepEqual((await directory.get(user.id))?.attributes, granted);
    assert.deepEqual(
      (await directory.list({ limit: 100 })).find((each) => each.id === user.id)?.attributes,
      granted,
    );
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
    // What "takes the transaction first" buys, made observable: granting a
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
    // A mistyped id would otherwise be a permission that silently never happened, which is why
    // this write `returning`s and throws where a revocation elsewhere says nothing.
    await assert.rejects(
      db.tx((tx) => directory.setAttributes(tx, nobody, { role: "admin" })),
      new RegExp(`no User ${nobody} exists`),
    );
  });
});

describe("admitting a User and giving them a credential", () => {
  it("is one transaction, because `create` takes the caller's", async () => {
    // The claim the removal of `POST /users` rests on: a Signal Handler admitting
    // somebody and an Auth writing their secret are one commit, so a crash cannot leave a User
    // nobody can log in as. This file holds no Auth, so what is proved here is the half that is
    // this component's, the write joining a transaction of the caller's and rolling back with
    // it, and `src/password-auth/login.test.ts` is where the pair is run together.
    let attempted: UserRecord | undefined;
    await assert.rejects(
      db.tx(async (tx) => {
        attempted = await directory.create(tx);
        // Whatever else that transaction was for, failing.
        throw new Error("the Operator's own write failed");
      }),
      /the Operator's own write failed/,
    );

    assert.ok(attempted !== undefined, "the User should have been created before the rollback");
    assert.equal(await directory.get(attempted.id), undefined);
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
    // User event would put a Run behind one. A deployment that wants it emits
    // it itself, and this is the pattern — both writes take the caller's transaction,
    // so there is one.
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
