/**
 * A NIP-98 signature authenticating a request, through the Public server that composes the schemes.
 *
 * The subject is `authenticate`: what this component answers about a request, and what the server
 * does with that answer. Everything is observed over HTTP against a real Fastify instance and real
 * PostgreSQL, on routes of the Operator's own taking `publicServer.requireUser`. Every credential
 * in this file is a real kind 27235 event with a real Schnorr signature over it, built by
 * `src/test-support/nip98-credentials.ts`, so a forgery is refused by the primitive rather than by
 * a stub agreeing to fail.
 *
 * **The external base URL is deliberately not what Fastify sees.** `inject` serves these requests
 * on localhost and every `u` tag in this file names `https://agent.example.invalid`, which is the
 * whole point of the option: what a client signs is what the client typed, and a reverse proxy
 * rewrites the difference. A component reading the request's own host would fail every test here.
 *
 * Three tests carry more than they look:
 *
 *  - `refuses an event dated in the future` is the reason the validation is written by hand, and it
 *    asserts the hole rather than describing it: the same credential is handed to
 *    `nostr-tools`' own `nip98.validateToken`, **which accepts it**, and then to the server, which
 *    does not. A rewrite of `nip98.ts` through that function turns this test red and nothing else
 *    in the repository would notice.
 *  - `refuses a key nobody granted, and says nothing about it` is the counterpart of
 *    `../nostr-channel/receiving.test.ts`'s forged envelope. The signature is perfect; the answer
 *    is the generic code with no detail anywhere, because a sentence telling an ungranted key from
 *    an unknown User is a directory of who is enrolled.
 *  - `refuses a credential that was presented before` is the replay defence, and the table it rests
 *    on is read directly in `granting.test.ts` for the one claim HTTP cannot show.
 *
 * A database of this file's own, because no two test files may share one.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
// The library's own validator, imported **only** to prove it is not good enough. Nothing in
// `src/nostr-auth` calls it, and the assertion below is what keeps that true.
import { validateToken } from "nostr-tools/nip98";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import type { LogFields, Logger } from "../logging/logging.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { type FakeAuth, fakeAuth } from "../test-support/fake-auth.ts";
import { nip98Header, nip98Token, type Signer, signer } from "../test-support/nip98-credentials.ts";
import type { UserRecord } from "../users/routes.ts";
import * as usersSchema from "../users/schema.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createNostrAuth, type NostrAuth } from "./nostr-auth.ts";
import * as nostrAuthSchema from "./schema.ts";

/** What the client thinks it is talking to, which is not what Fastify received. */
const externalBaseUrl = "https://agent.example.invalid";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

/** Where the Operator put routes of their own: a sibling of ours, on the same server. */
const ops = "/ops";

/** One line somebody wrote to a Logger. */
type LogLine = { readonly fields: LogFields; readonly message: string };

let database: TestDatabase;
let db: Db;
let users: Users;
let nostrAuth: NostrAuth;
let publicServer: ServerComponent<FastifyInstance>;
/**
 * A second scheme, registered behind this one, so that "not my request" and "my request and it
 * failed" are told apart by what it was asked rather than by reading the outcome.
 */
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
    asked: request.safUser.id,
  }));

  fastify.post<{ Body: { text: string } }>(
    "/ask",
    { preHandler: publicServer.requireUser },
    async (request) => ({ by: request.safUser.id, said: request.body.text }),
  );
};

before(async () => {
  database = await createTestDatabase("nostr_auth_authenticating");
  db = database.db;
  await applySchema(db, usersSchema, nostrAuthSchema);

  publicServer = serverComponent(Fastify(), nowhere, { logger });
  users = createUsers({ db });
  // Registers itself with the server and nothing else. Nothing below wires it, and nothing
  // anywhere registers a route for it.
  nostrAuth = createNostrAuth({ db, users, publicServer, externalBaseUrl });

  secondScheme = fakeAuth("Bearer");
  publicServer.registerAuth(secondScheme);

  await publicServer.fastify.register(operatorRoutes, { prefix: ops });
});

after(async () => {
  await publicServer.stop();
  await database.drop();
});

/** A User admitted from trusted code, holding one signer the Operator granted. */
async function admit(): Promise<{ user: UserRecord; client: Signer }> {
  const client = signer();
  const user = await db.tx(async (tx) => {
    const created = await users.create(tx);
    await nostrAuth.recordPublicKey(tx, created.id, client.publicKey);
    return created;
  });
  return { user, client };
}

/** The absolute URL a client signs for a path on this deployment. */
function signed(path: string): string {
  return `${externalBaseUrl}${path}`;
}

/** A GET at the Operator's own protected route, carrying whatever the caller sends, or nothing. */
function ask(authorization?: string, path = `${ops}/whoami`) {
  return publicServer.fastify.inject(
    authorization === undefined
      ? { method: "GET", url: path }
      : { method: "GET", url: path, headers: { authorization } },
  );
}

/** The honest client: a signature over exactly the call it is about to make. */
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
    // The scheme in front answered, so nothing behind it was asked.
    assert.equal(secondScheme.asked.length, alreadyAsked);
  });

  it("takes the scheme however the client capitalised it", async () => {
    const { user, client } = await admit();
    const url = signed(`${ops}/whoami`);

    // RFC 7235 makes the scheme case-insensitive, and a client is not refused over spelling. A
    // credential of its own per spelling, because the same one twice is a replay and that is a
    // different test.
    for (const spelling of ["Nostr", "nostr", "NOSTR"]) {
      const answered = await ask(
        `${spelling} ${nip98Token({ signer: client, url, method: "GET" })}`,
      );
      assert.equal(answered.statusCode, 200, `${spelling}: ${answered.body}`);
      assert.deepEqual(answered.json(), { asked: user.id });
    }
  });

  it("gives one User as many keys as they have signers", async () => {
    // The whole reason this table is keyed by the public key: a phone and a laptop are two
    // signers and one person, where the Nostr Channel's table admits one key per User.
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

    // Nothing in the request names a User: the grant does, so a key answers with its own User
    // and there is no parameter to change.
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

    // The same credential, over a body somebody changed on the way. The payload tag is what
    // notices, and without it a captured header would authorise any body at that URL.
    const tampered = await publicServer.fastify.inject({
      method: "POST",
      url: `${ops}/ask`,
      headers: { authorization: nip98Header({ signer: client, url, method: "POST", body }) },
      payload: { text: "delete everything" },
    });
    assert.equal(tampered.statusCode, 401, tampered.body);

    // And a body sent with no payload tag at all, which is the same attack with the tag simply
    // left off.
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
    // A day ahead. The library's window is `now - created_at < 60`, so a negative difference
    // passes and keeps passing: this credential would work for the next twenty-four hours.
    const createdAt = Math.floor(Date.now() / 1000) + 86_400;
    const token = nip98Token({ signer: client, url, method: "GET", createdAt });

    // The library, asked the same question about the same bytes. This assertion is the reason
    // `nip98.ts` exists, and it is written as an assertion so that a rewrite through
    // `validateToken` fails here rather than passing quietly.
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

    // The right key, the right window, and a `u` tag naming another route. A signature is a
    // credential for one call and not for the deployment.
    const elsewhere = nip98Header({
      signer: client,
      url: signed(`${ops}/ask`),
      method: "GET",
    });
    assert.equal((await ask(elsewhere)).statusCode, 401);

    // The query string is part of the call, so a parameter added after signing is a different
    // URL and not a detail.
    const bare = nip98Header({ signer: client, url: signed(`${ops}/whoami`), method: "GET" });
    assert.equal((await ask(bare, `${ops}/whoami?as=somebody`)).statusCode, 401);

    // And the method, which is what stops a signature over a read authorising a write.
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
    assert.match(String(warned[0]?.fields.detail), /kind 1/);
  });

  it("refuses an event whose signature does not verify", async () => {
    const { client } = await admit();
    const token = nip98Token({ signer: client, url: signed(`${ops}/whoami`), method: "GET" });
    // The same event with one character of the content changed after it was signed. The id no
    // longer hashes to the event, which is what `verifyEvent` recomputes.
    const event = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...event, content: "tampered" }), "utf8").toString(
      "base64",
    );

    warned.length = 0;
    assert.equal((await ask(`Nostr ${forged}`)).statusCode, 401);
    assert.match(String(warned[0]?.fields.detail), /signature did not verify/);
  });

  it("refuses a credential that was presented before", async () => {
    const { user, client } = await admit();
    const header = nip98Header({ signer: client, url: signed(`${ops}/whoami`), method: "GET" });

    const first = await ask(header);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { asked: user.id });

    // Nothing about the credential has expired: it is inside its window and would verify again.
    // The recorded event id is the whole of what refuses it.
    warned.length = 0;
    const second = await ask(header);
    assert.equal(second.statusCode, 401, second.body);
    assert.match(String(warned[0]?.fields.detail), /presented before/);
  });
});

describe("what a refusal says", () => {
  it("refuses a key nobody granted, and says nothing about it", async () => {
    // A perfect credential from a stranger: real key, real signature, right URL, right method,
    // dated now. The only thing wrong with it is that no Operator recorded the key.
    const stranger = signer();

    warned.length = 0;
    const refused = await asking(stranger);
    assert.equal(refused.statusCode, 401, refused.body);
    assert.equal(refused.headers["www-authenticate"], 'Nostr error="invalid_token", Bearer');
    // Nothing reached the log, because the aggregate writes a line only for a detail and this
    // refusal carries none. A sentence here would be a sentence somebody eventually puts on the
    // wire, and it would answer "is this key enrolled?".
    assert.deepEqual(warned, []);
    assert.ok(!refused.body.includes(stranger.publicKey), refused.body);
  });

  it("answers every kind of refusal with one body", async () => {
    const { client } = await admit();
    const path = `${ops}/whoami`;
    const url = signed(path);
    const stranger = signer();

    const refusals = [
      // No header at all, and a scheme nothing here accepts.
      await ask(),
      await ask("Basic aGk6dGhlcmU="),
      // The scheme with nothing after it, and with something that is not an event.
      await ask("Nostr"),
      await ask("Nostr not-base64-at-all"),
      await ask(`Nostr ${Buffer.from("[]", "utf8").toString("base64")}`),
      // Every mechanical refusal, one per check.
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
      // A credential carrying no `u` tag and no `method` tag at all.
      await ask(nip98Header({ signer: client, url, method: "GET", tags: [] }), path),
      // And the one that says nothing: a stranger's perfect credential.
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

    // Byte for byte, not merely equivalent: a stray field or a different order in any of them
    // would be as good an oracle as a different message.
    const [first, ...rest] = refusals;
    assert.ok(first !== undefined);
    for (const refused of rest) assert.equal(refused.body, first.body);
  });

  it("tells a malformed credential apart from one that did not verify", async () => {
    const { client } = await admit();

    // The scheme is named and nothing follows it: the credential arrived malformed, which is
    // mechanics rather than identity, so RFC 6750's other word is used.
    warned.length = 0;
    const empty = await ask("Nostr");
    assert.equal(empty.headers["www-authenticate"], 'Nostr error="invalid_request", Bearer');
    assert.deepEqual(warned[0]?.fields, {
      scheme: "Nostr",
      code: "invalid_request",
      detail: "the Authorization header named Nostr and carried no event after it",
    });

    // Base64 that is not an event is the same kind of failure.
    warned.length = 0;
    const notAnEvent = await ask(`Nostr ${Buffer.from("[]", "utf8").toString("base64")}`);
    assert.equal(notAnEvent.headers["www-authenticate"], 'Nostr error="invalid_request", Bearer');
    assert.equal(warned[0]?.fields.detail, "the credential is not a base64 event");

    // A well-formed event that did not survive a check is the other word.
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

    // And no detail reached the client, on any of the three.
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
      // Nothing of this scheme in any of these, so all three reach the Auth behind it. A
      // deployment running a password login beside this one is the case that needs it.
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
      // The second scheme would have authenticated this request. A credential that named this
      // scheme and failed ends the walk, so a broken signature cannot be retried as a password.
      const refused = await ask("Nostr not-base64-at-all");
      assert.equal(refused.statusCode, 401, refused.body);
      assert.equal(secondScheme.asked.length, alreadyAsked);
    } finally {
      secondScheme.answers({ kind: "absent" });
    }
  });
});
