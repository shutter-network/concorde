import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { validateToken } from "nostr-tools/nip98";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import type { LogFields, Logger } from "../logging/logging.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { type FakeAuth, fakeAuth } from "../test-support/fake-auth.ts";
import { nip98Header, nip98Token, type Signer, signer } from "../test-support/nip98-credentials.ts";
import type { UserRecord } from "../users/routes.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createNostrAuth, type NostrAuth } from "./nostr-auth.ts";
import * as nostrAuthSchema from "./schema/index.ts";

const externalBaseUrl = "https://agent.example.invalid";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const ops = "/ops";

type LogLine = { readonly fields: LogFields; readonly message: string };

let database: TestDatabase;
let db: Db;
let users: Users;
let nostrAuth: NostrAuth;
let publicServer: ServerComponent<FastifyInstance>;
let secondScheme: FakeAuth;
const warned: LogLine[] = [];

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (fields, message) => void warned.push({ fields, message }),
  error: () => {},
};

const operatorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/whoami", { preHandler: publicServer.requireUser }, async (request) => ({
    asked: request.concordeUser.id,
  }));

  fastify.post<{ Body: { text: string } }>(
    "/ask",
    { preHandler: publicServer.requireUser },
    async (request) => ({ by: request.concordeUser.id, said: request.body.text }),
  );
};

before(async () => {
  database = await createTestDatabase("nostr_auth_authenticating");
  db = database.db;
  await applySchema(db, usersSchema, nostrAuthSchema);

  publicServer = serverComponent(Fastify(), nowhere, { logger });
  users = createUsers({ db });
  nostrAuth = createNostrAuth({ db, users, publicServer, externalBaseUrl });

  secondScheme = fakeAuth("Bearer");
  publicServer.registerAuth(secondScheme);

  await publicServer.fastify.register(operatorRoutes, { prefix: ops });
});

after(async () => {
  await publicServer.stop();
  await database.drop();
});

async function admit(): Promise<{ user: UserRecord; client: Signer }> {
  const client = signer();
  const user = await db.tx(async (tx) => {
    const created = await users.create(tx);
    await nostrAuth.recordPublicKey(tx, created.id, client.publicKey);
    return created;
  });
  return { user, client };
}

function signed(path: string): string {
  return `${externalBaseUrl}${path}`;
}

function ask(authorization?: string, path = `${ops}/whoami`) {
  return publicServer.fastify.inject(
    authorization === undefined
      ? { method: "GET", url: path }
      : { method: "GET", url: path, headers: { authorization } },
  );
}

function asking(client: Signer, path = `${ops}/whoami`) {
  return ask(nip98Header({ signer: client, url: signed(path), method: "GET" }), path);
}

describe("authenticating a request", () => {
  it("names the User the signing key was granted to", async () => {
    const { user, client } = await admit();

    const alreadyAsked = secondScheme.asked.length;
    const answered = await asking(client);
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { asked: user.id });
    assert.equal(secondScheme.asked.length, alreadyAsked);
  });

  it("takes the scheme however the client capitalised it", async () => {
    const { user, client } = await admit();
    const url = signed(`${ops}/whoami`);

    for (const spelling of ["Nostr", "nostr", "NOSTR"]) {
      const answered = await ask(
        `${spelling} ${nip98Token({ signer: client, url, method: "GET" })}`,
      );
      assert.equal(answered.statusCode, 200, `${spelling}: ${answered.body}`);
      assert.deepEqual(answered.json(), { asked: user.id });
    }
  });

  it("gives one User as many keys as they have signers", async () => {
    const { user, client } = await admit();
    const laptop = signer();
    await db.tx((tx) => nostrAuth.recordPublicKey(tx, user.id, laptop.publicKey));

    for (const held of [client, laptop]) {
      assert.deepEqual((await asking(held)).json(), { asked: user.id });
    }
  });

  it("does not let one User's key act as another User", async () => {
    const first = await admit();
    const second = await admit();

    assert.deepEqual((await asking(first.client)).json(), { asked: first.user.id });
    assert.deepEqual((await asking(second.client)).json(), { asked: second.user.id });
    assert.notEqual(first.user.id, second.user.id);
  });

  it("binds the signature to the request body", async () => {
    const { user, client } = await admit();
    const body = { text: "what happened?" };
    const url = signed(`${ops}/ask`);

    const answered = await publicServer.fastify.inject({
      method: "POST",
      url: `${ops}/ask`,
      headers: { authorization: nip98Header({ signer: client, url, method: "POST", body }) },
      payload: body,
    });
    assert.equal(answered.statusCode, 200, answered.body);
    assert.deepEqual(answered.json(), { by: user.id, said: "what happened?" });

    const tampered = await publicServer.fastify.inject({
      method: "POST",
      url: `${ops}/ask`,
      headers: { authorization: nip98Header({ signer: client, url, method: "POST", body }) },
      payload: { text: "delete everything" },
    });
    assert.equal(tampered.statusCode, 401, tampered.body);

    const untagged = await publicServer.fastify.inject({
      method: "POST",
      url: `${ops}/ask`,
      headers: { authorization: nip98Header({ signer: client, url, method: "POST" }) },
      payload: body,
    });
    assert.equal(untagged.statusCode, 401, untagged.body);
  });
});

describe("the checks the library does not make", () => {
  it("refuses an event dated in the future, which nip98.validateToken accepts forever", async () => {
    const { client } = await admit();
    const path = `${ops}/whoami`;
    const url = signed(path);
    const createdAt = Math.floor(Date.now() / 1000) + 86_400;
    const token = nip98Token({ signer: client, url, method: "GET", createdAt });

    assert.equal(
      await validateToken(token, url, "GET"),
      true,
      "nostr-tools accepted a future-dated credential; the hole this component is written around has moved",
    );

    warned.length = 0;
    const refused = await ask(`Nostr ${token}`, path);
    assert.equal(refused.statusCode, 401, refused.body);
    assert.match(String(warned[0]?.fields.detail), /far in the future/);
  });

  it("refuses an event that has aged out of the window", async () => {
    const { client } = await admit();
    const path = `${ops}/whoami`;
    const createdAt = Math.floor(Date.now() / 1000) - 3600;
    const stale = nip98Header({ signer: client, url: signed(path), method: "GET", createdAt });

    warned.length = 0;
    assert.equal((await ask(stale, path)).statusCode, 401);
    assert.match(String(warned[0]?.fields.detail), /seconds old/);
  });

  it("refuses a signature captured from a different call", async () => {
    const { client } = await admit();

    const elsewhere = nip98Header({
      signer: client,
      url: signed(`${ops}/ask`),
      method: "GET",
    });
    assert.equal((await ask(elsewhere)).statusCode, 401);

    const bare = nip98Header({ signer: client, url: signed(`${ops}/whoami`), method: "GET" });
    assert.equal((await ask(bare, `${ops}/whoami?as=somebody`)).statusCode, 401);

    const asARead = nip98Header({ signer: client, url: signed(`${ops}/ask`), method: "GET" });
    const written = await publicServer.fastify.inject({
      method: "POST",
      url: `${ops}/ask`,
      headers: { authorization: asARead },
      payload: { text: "hello" },
    });
    assert.equal(written.statusCode, 401, written.body);
  });

  it("refuses an event of another kind, however well signed", async () => {
    const { client } = await admit();
    const wrongKind = nip98Header({
      signer: client,
      url: signed(`${ops}/whoami`),
      method: "GET",
      kind: 1,
    });

    warned.length = 0;
    assert.equal((await ask(wrongKind)).statusCode, 401);
    assert.match(String(warned[0]?.fields.detail), /kind: 1/);
  });

  it("refuses an event whose signature does not verify", async () => {
    const { client } = await admit();
    const token = nip98Token({ signer: client, url: signed(`${ops}/whoami`), method: "GET" });
    const event = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...event, content: "tampered" }), "utf8").toString(
      "base64",
    );

    warned.length = 0;
    assert.equal((await ask(`Nostr ${forged}`)).statusCode, 401);
    assert.match(String(warned[0]?.fields.detail), /signature is invalid/);
  });

  it("refuses a credential that was presented before", async () => {
    const { user, client } = await admit();
    const header = nip98Header({ signer: client, url: signed(`${ops}/whoami`), method: "GET" });

    const first = await ask(header);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { asked: user.id });

    warned.length = 0;
    const second = await ask(header);
    assert.equal(second.statusCode, 401, second.body);
    assert.match(String(warned[0]?.fields.detail), /already used/);
  });
});

describe("what a refusal says", () => {
  it("refuses a key nobody granted, and says nothing about it", async () => {
    const stranger = signer();

    warned.length = 0;
    const refused = await asking(stranger);
    assert.equal(refused.statusCode, 401, refused.body);
    assert.equal(refused.headers["www-authenticate"], 'Nostr error="invalid_token", Bearer');
    assert.deepEqual(warned, []);
    assert.ok(!refused.body.includes(stranger.publicKey), refused.body);
  });

  it("answers every kind of refusal with one body", async () => {
    const { client } = await admit();
    const path = `${ops}/whoami`;
    const url = signed(path);
    const stranger = signer();

    const refusals = [
      await ask(),
      await ask("Basic aGk6dGhlcmU="),
      await ask("Nostr"),
      await ask("Nostr not-base64-at-all"),
      await ask(`Nostr ${Buffer.from("[]", "utf8").toString("base64")}`),
      await ask(`Nostr ${nip98Token({ signer: client, url, method: "GET", kind: 1 })}`, path),
      await ask(nip98Header({ signer: client, url, method: "POST" }), path),
      await ask(nip98Header({ signer: client, url: signed("/elsewhere"), method: "GET" }), path),
      await ask(
        nip98Header({
          signer: client,
          url,
          method: "GET",
          createdAt: Math.floor(Date.now() / 1000) + 86_400,
        }),
        path,
      ),
      await ask(nip98Header({ signer: client, url, method: "GET", tags: [] }), path),
      await asking(stranger),
    ];

    for (const refused of refusals) {
      assert.equal(refused.statusCode, 401, refused.body);
      assert.deepEqual(refused.json(), {
        statusCode: 401,
        error: "Unauthorized",
        message: "authentication failed",
      });
    }

    const [first, ...rest] = refusals;
    assert.ok(first !== undefined);
    for (const refused of rest) assert.equal(refused.body, first.body);
  });

  it("tells a malformed credential apart from one that did not verify", async () => {
    const { client } = await admit();

    warned.length = 0;
    const empty = await ask("Nostr");
    assert.equal(empty.headers["www-authenticate"], 'Nostr error="invalid_request", Bearer');
    assert.deepEqual(warned[0]?.fields, {
      scheme: "Nostr",
      code: "invalid_request",
      detail: "Missing event after Nostr in the Authorization header",
    });

    warned.length = 0;
    const notAnEvent = await ask(`Nostr ${Buffer.from("[]", "utf8").toString("base64")}`);
    assert.equal(notAnEvent.headers["www-authenticate"], 'Nostr error="invalid_request", Bearer');
    assert.equal(warned[0]?.fields.detail, "Credential is not a base64-encoded event");

    warned.length = 0;
    const stale = await ask(
      nip98Header({
        signer: client,
        url: signed(`${ops}/whoami`),
        method: "GET",
        createdAt: Math.floor(Date.now() / 1000) - 3600,
      }),
    );
    assert.equal(stale.headers["www-authenticate"], 'Nostr error="invalid_token", Bearer');

    for (const answered of [empty, notAnEvent, stale]) {
      assert.ok(
        !JSON.stringify([answered.body, answered.headers]).includes("carried no event"),
        `the detail reached the client: ${answered.body}`,
      );
      assert.ok(!answered.body.includes("seconds old"), answered.body);
    }
  });
});

describe("the three outcomes", () => {
  it("falls through to the next scheme rather than refusing on its behalf", async () => {
    const { user } = await admit();
    const alreadyAsked = secondScheme.asked.length;
    secondScheme.answers({ kind: "authenticated", user });
    try {
      for (const header of [undefined, "Bearer a-token", "Basic aGk6dGhlcmU="]) {
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
    const { user } = await admit();
    const alreadyAsked = secondScheme.asked.length;
    secondScheme.answers({ kind: "authenticated", user });
    try {
      const refused = await ask("Nostr not-base64-at-all");
      assert.equal(refused.statusCode, 401, refused.body);
      assert.equal(secondScheme.asked.length, alreadyAsked);
    } finally {
      secondScheme.answers({ kind: "absent" });
    }
  });
});
