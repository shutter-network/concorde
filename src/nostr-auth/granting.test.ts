import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { nip98Header, type Signer, signer } from "../test-support/nip98-credentials.ts";
import * as usersModule from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createNostrAuth, type NostrAuth } from "./nostr-auth.ts";
import * as nostrAuthModule from "./schema/index.ts";

const { admitted, grants, nostrAuthTables } = nostrAuthModule;

const externalBaseUrl = "https://agent.example.invalid";
const nowhere = { port: 0, host: "127.0.0.1" } as const;
const ops = "/ops";

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let database: TestDatabase;
let db: Db;
let users: Users;
let nostrAuth: NostrAuth;
let publicServer: ServerComponent<FastifyInstance>;

const operatorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/whoami", { preHandler: publicServer.requireUser }, async (request) => ({
    asked: request.concordeUser.id,
  }));
};

before(async () => {
  database = await createTestDatabase("nostr_auth_granting");
  db = database.db;
  await applySchema(db, usersModule, nostrAuthModule);

  publicServer = serverComponent(Fastify(), nowhere, { logger: quiet });
  users = createUsers({ db });
  nostrAuth = createNostrAuth({ db, users, publicServer, externalBaseUrl });
  await publicServer.fastify.register(operatorRoutes, { prefix: ops });
});

after(async () => {
  await publicServer.stop();
  await database.drop();
});

async function admit(): Promise<{ id: string; client: Signer }> {
  const client = signer();
  const user = await db.tx(async (tx) => {
    const created = await users.create(tx);
    await nostrAuth.recordPublicKey(tx, created.id, client.publicKey);
    return created;
  });
  return { id: user.id, client };
}

function asking(client: Signer) {
  return publicServer.fastify.inject({
    method: "GET",
    url: `${ops}/whoami`,
    headers: {
      authorization: nip98Header({
        signer: client,
        url: `${externalBaseUrl}${ops}/whoami`,
        method: "GET",
      }),
    },
  });
}

async function recorded(): Promise<string[]> {
  const rows = await db.handle(nostrAuthTables).select({ id: admitted.eventId }).from(admitted);
  return rows.map((row) => row.id).sort();
}

describe("recording a public key", () => {
  it("admits a User to this scheme and nothing else does", async () => {
    const { id, client } = await admit();
    const answered = await asking(client);
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { asked: id });
  });

  it("refuses a key that is not 64 lowercase hex characters", async () => {
    const user = await db.tx((tx) => users.create(tx));
    for (const offered of ["npub1qqqq", "AB".repeat(32), `0x${"ab".repeat(32)}`, "ab"]) {
      await assert.rejects(
        db.tx((tx) => nostrAuth.recordPublicKey(tx, user.id, offered)),
        /not a Nostr public key/,
        offered,
      );
    }
  });

  it("refuses a key for a User that is not there", async () => {
    await assert.rejects(
      db.tx((tx) =>
        nostrAuth.recordPublicKey(tx, "00000000-0000-4000-8000-000000000000", signer().publicKey),
      ),
      /no User .* exists/,
    );
  });

  it("refuses a key that is already granted, and moves nothing", async () => {
    const first = await admit();
    const second = await db.tx((tx) => users.create(tx));

    await assert.rejects(
      db.tx((tx) => nostrAuth.recordPublicKey(tx, second.id, first.client.publicKey)),
      /already granted/,
    );

    assert.deepEqual((await asking(first.client)).json(), { asked: first.id });
  });

  it("leaves the caller's transaction usable after a refusal", async () => {
    const held = signer();
    const first = await admit();
    const survived = await db.tx(async (tx) => {
      const created = await users.create(tx);
      await assert.rejects(nostrAuth.recordPublicKey(tx, created.id, first.client.publicKey));
      await nostrAuth.recordPublicKey(tx, created.id, held.publicKey);
      return created;
    });

    assert.deepEqual((await asking(held)).json(), { asked: survived.id });
  });
});

describe("the replay record", () => {
  it("holds one row per admitted request and none for a refused one", async () => {
    const { client } = await admit();
    const stranger = signer();
    const before = await recorded();

    const refusals = [
      publicServer.fastify.inject({ method: "GET", url: `${ops}/whoami` }),
      publicServer.fastify.inject({
        method: "GET",
        url: `${ops}/whoami`,
        headers: { authorization: "Nostr not-base64-at-all" },
      }),
      asking(stranger),
      publicServer.fastify.inject({
        method: "GET",
        url: `${ops}/whoami`,
        headers: {
          authorization: nip98Header({
            signer: client,
            url: `${externalBaseUrl}${ops}/whoami`,
            method: "GET",
            createdAt: Math.floor(Date.now() / 1000) - 3600,
          }),
        },
      }),
    ];
    for (const refused of await Promise.all(refusals)) assert.equal(refused.statusCode, 401);
    assert.deepEqual(await recorded(), before);

    assert.equal((await asking(client)).statusCode, 200);
    assert.equal((await recorded()).length, before.length + 1);
  });

  it("deletes the rows past the window on the request that writes one", async () => {
    const { client } = await admit();
    const stale = `${"1".repeat(63)}a`;
    const recent = `${"2".repeat(63)}b`;
    await db
      .handle(nostrAuthTables)
      .insert(admitted)
      .values([
        { eventId: stale, admittedAt: new Date(Date.now() - 60 * 60 * 1000) },
        { eventId: recent, admittedAt: new Date() },
      ]);

    assert.equal((await asking(client)).statusCode, 200);

    const held = await recorded();
    assert.ok(!held.includes(stale), "a row past the window survived a request");
    assert.ok(held.includes(recent), "the prune took a row that is still needed");
  });

  it("keeps refusing a captured credential for as long as it could work", async () => {
    const { client } = await admit();
    const header = nip98Header({
      signer: client,
      url: `${externalBaseUrl}${ops}/whoami`,
      method: "GET",
    });
    const send = () =>
      publicServer.fastify.inject({
        method: "GET",
        url: `${ops}/whoami`,
        headers: { authorization: header },
      });

    assert.equal((await send()).statusCode, 200);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await asking(client)).statusCode, 200);
      assert.equal((await send()).statusCode, 401);
    }
  });
});

describe("the surface this component has", () => {
  it("records no route on either server", async () => {
    const queued: string[] = [];
    const bare = Fastify();
    bare.addHook("onRoute", (route) => void queued.push(`${String(route.method)} ${route.url}`));
    const server = serverComponent(bare, nowhere);

    createNostrAuth({ db, users, publicServer: server, externalBaseUrl });
    await bare.ready();
    assert.deepEqual(queued, []);
    await server.stop();

    assert.ok(!Object.hasOwn(nostrAuth, "agentRoutes"));
  });

  it("refuses a base URL that is not absolute, at construction", () => {
    for (const offered of ["agent.example.com", "/agent", ""]) {
      assert.throws(
        () => createNostrAuth({ db, users, publicServer, externalBaseUrl: offered }),
        /externalBaseUrl must be an absolute URL/,
        offered,
      );
    }
  });

  it("refuses a window that is not a positive number of milliseconds", () => {
    for (const windowMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createNostrAuth({ db, users, publicServer, externalBaseUrl, windowMs }),
        /windowMs must be a positive number of milliseconds/,
        String(windowMs),
      );
    }
  });

  it("takes a trailing slash off the base URL rather than doubling one", async () => {
    const slashed = serverComponent(Fastify(), nowhere);
    const auth = createNostrAuth({
      db,
      users,
      publicServer: slashed,
      externalBaseUrl: `${externalBaseUrl}/`,
    });
    slashed.fastify.get("/whoami", { preHandler: slashed.requireUser }, async (request) => ({
      asked: request.concordeUser.id,
    }));

    const client = signer();
    const user = await db.tx(async (tx) => {
      const created = await users.create(tx);
      await auth.recordPublicKey(tx, created.id, client.publicKey);
      return created;
    });

    const answered = await slashed.fastify.inject({
      method: "GET",
      url: "/whoami",
      headers: {
        authorization: nip98Header({
          signer: client,
          url: `${externalBaseUrl}/whoami`,
          method: "GET",
        }),
      },
    });
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { asked: user.id });
    await slashed.stop();
  });

  it("grants many keys to one User and reads each of them back", async () => {
    const { id, client } = await admit();
    const second = signer();
    await db.tx((tx) => nostrAuth.recordPublicKey(tx, id, second.publicKey));

    const held = await db
      .handle(nostrAuthTables)
      .select({ pubkey: grants.pubkey })
      .from(grants)
      .where(eq(grants.userId, id));
    assert.deepEqual(
      held.map((row) => row.pubkey).sort(),
      [client.publicKey, second.publicKey].sort(),
    );
  });
});
