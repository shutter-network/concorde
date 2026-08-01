/**
 * A User managing their own credential: logging out, revoking everything, and
 * changing a password.
 *
 * The subject is what a client can observe, never how anything is stored: every
 * assertion here is made over HTTP against real Fastify instances and real
 * PostgreSQL, and **nothing reads a hash, a column, or a row**. "Revoked" means a
 * Token that answered 200 a moment ago answers 401 now, and "changed" means the old
 * password stops minting Tokens and the new one starts.
 *
 * Three tests carry more than they look:
 *
 *  - `revokes every Token of the presented User and no other User's` is the failure
 *    that matters. A `delete from tokens` with the wrong `where` — or with none —
 *    logs out every User in the deployment, and every other assertion in this file
 *    would still pass. The second User is how that is caught, and it is caught over
 *    HTTP by presenting their Token afterwards.
 *  - `answers a revoked Token exactly as it answers one that was never issued`
 *    compares byte for byte. Revocation is a delete rather than a flag, so there is
 *    no second refusal for the two cases to drift apart into — this pins that.
 *  - `leaves every existing Token working` pins a **deliberate** non-behaviour
 *    (ADR-0030). Changing a password revokes nothing, because a User who changed
 *    theirs out of fear is served by `DELETE /tokens`, which is one request away; a
 *    future reader who thinks a rotation should log everyone out is looking at a
 *    decision, not an oversight.
 *
 * Because nothing removes a User (ADR-0029), the routes in this file are the only
 * mechanism anywhere in the system by which a credential stops working before it
 * expires. That is why they get a file rather than a paragraph.
 *
 * A database of this file's own, because no two test files may share one, and a
 * deliberately cheap scrypt cost, because every Token here starts with a login.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { usersMigrations } from "./migrations.ts";
import type { UserRecord } from "./routes.ts";
import type { ScryptParameters } from "./secrets.ts";
import { createUsers, type Users } from "./users.ts";

/** What a login answers with, as a client parses it. */
type IssuedToken = {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: UserRecord;
};

const hour = 60 * 60 * 1000;

/** A cost nobody should deploy, legitimate because each digest carries its own. */
const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

/** The password a User is admitted with, unless a test is about changing it. */
const password = "correct horse battery staple";

/** The prefixes the Operator chose, and the second one that proves they are theirs. */
const auth = "/auth";
const alsoAt = "/sign-in";

let database: TestDatabase;
let db: Db;
let directory: Users;
let agentServer: FastifyInstance;
let publicServer: FastifyInstance;

before(async () => {
  database = await createTestDatabase("users_credentials");
  db = database.db;
  db.registerMigrations(usersMigrations);
  await db.migrate();

  directory = createUsers({ db, tokenTtl: hour, scrypt: cheap });

  agentServer = Fastify();
  await agentServer.register(directory.agentRoutes, { prefix: "/users" });

  publicServer = Fastify();
  await publicServer.register(directory.publicRoutes, { prefix: auth });
  await publicServer.register(directory.publicRoutes, { prefix: alsoAt });
});

after(async () => {
  await agentServer.close();
  await publicServer.close();
  await database.drop();
});

/** Creates a User over the Agent server, with a password to log in with. */
async function admit(initial = password): Promise<UserRecord> {
  const response = await agentServer.inject({
    method: "POST",
    url: "/users",
    payload: { password: initial },
  });
  assert.equal(response.statusCode, 201, `POST /users should have answered: ${response.body}`);
  return response.json<UserRecord>();
}

/** One login that is expected to succeed. */
async function logIn(user: string, secret = password, at = auth): Promise<IssuedToken> {
  const response = await publicServer.inject({
    method: "POST",
    url: `${at}/tokens`,
    payload: { user, password: secret },
  });
  assert.equal(
    response.statusCode,
    201,
    `POST ${at}/tokens should have answered: ${response.body}`,
  );
  return response.json<IssuedToken>();
}

/** One login attempt, whatever it answers. */
function attempt(user: string, secret: string) {
  return publicServer.inject({
    method: "POST",
    url: `${auth}/tokens`,
    payload: { user, password: secret },
  });
}

/**
 * `GET /me` with a Token, which is the whole of what "the Token works" means from
 * outside: there is no other way to ask, and no row is read to answer it.
 */
function present(token: string, at = auth) {
  return publicServer.inject({
    method: "GET",
    url: `${at}/me`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** A request carrying a Token, to whichever of this ticket's routes the caller names. */
function carrying(
  method: "DELETE" | "PUT",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
) {
  const headers = { authorization: `Bearer ${token}` };
  return payload === undefined
    ? publicServer.inject({ method, url, headers })
    : publicServer.inject({ method, url, headers, payload });
}

/** Asserts a Token works, and answers with the User it belongs to. */
async function works(token: string, user: UserRecord, what: string): Promise<void> {
  const me = await present(token);
  assert.equal(me.statusCode, 200, `${what} should still work: ${me.body}`);
  assert.deepEqual(me.json(), user, what);
}

/** Asserts a Token does not work, with the one refusal the whole surface answers. */
async function refused(token: string, what: string): Promise<void> {
  const me = await present(token);
  assert.equal(me.statusCode, 401, `${what} should have been refused: ${me.body}`);
  assert.deepEqual(me.json(), {
    statusCode: 401,
    error: "Unauthorized",
    message: "authentication failed",
  });
}

describe("logging out", () => {
  it("revokes the presented Token and leaves that User's others working", async () => {
    // Three logins, as a browser and two scripts would make: the point of revoking
    // one is that it is one, so a User dropping a device they no longer trust does
    // not end the session they are sitting in (User story 19).
    const user = await admit();
    const [dropped, kept, alsoKept] = await Promise.all([
      logIn(user.id),
      logIn(user.id),
      logIn(user.id),
    ]);

    const out = await carrying("DELETE", `${auth}/tokens/current`, dropped.token);
    assert.equal(out.statusCode, 204, out.body);
    // Nothing in the body, because there is nothing to answer with: the Token's
    // plaintext existed once, in the response that issued it.
    assert.equal(out.body, "");

    await refused(dropped.token, "a Token that was logged out");
    await works(kept.token, user, "another Token of the same User");
    await works(alsoKept.token, user, "a third Token of the same User");

    // And the password is untouched: logging out drops a credential, not the means of
    // getting another one. Nothing removes a User (ADR-0029), so this is the whole of
    // what "logging out" can mean here.
    await works((await logIn(user.id)).token, user, "a Token minted after logging out");
  });

  it("takes nobody else's Token down with it", async () => {
    const [one, other] = [await admit(), await admit()];
    const forOne = await logIn(one.id);
    const forOther = await logIn(other.id);

    assert.equal(
      (await carrying("DELETE", `${auth}/tokens/current`, forOne.token)).statusCode,
      204,
    );

    await refused(forOne.token, "the Token that logged out");
    await works(forOther.token, other, "another User's Token");
  });

  it("answers a revoked Token exactly as it answers one that was never issued", async () => {
    // Revocation is a delete and not a flag, so a revoked Token is refused by the same
    // lookup that refuses an unknown one — there is no second refusal for the two to
    // drift apart into, and this is what says so from outside (ADR-0030).
    const user = await admit();
    const revoked = await logIn(user.id);
    assert.equal(
      (await carrying("DELETE", `${auth}/tokens/current`, revoked.token)).statusCode,
      204,
    );

    const refusals = [
      await present(revoked.token),
      // Never issued: the prefix is recognisable and the shape is right, and it names
      // nothing.
      await present(`saf_${"A".repeat(43)}`),
      // Nothing that looks like a Token at all.
      await present("not-a-token"),
    ];
    for (const response of refusals) {
      assert.equal(response.statusCode, 401, response.body);
    }
    // Byte for byte, not merely equivalent: a different message on a revoked Token
    // would tell a holder of a stolen one that it had been revoked rather than mistyped.
    const [first, ...rest] = refusals;
    assert.ok(first !== undefined);
    for (const response of rest) {
      assert.equal(response.body, first.body);
      assert.equal(response.headers["www-authenticate"], undefined);
    }
  });

  it("refuses to log out a request that presented nothing", async () => {
    // The route takes the preHandler, so there is no way to revoke a Token without
    // holding it: the credential is what names the row.
    const anonymous = await publicServer.inject({
      method: "DELETE",
      url: `${auth}/tokens/current`,
    });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.deepEqual(anonymous.json(), {
      statusCode: 401,
      error: "Unauthorized",
      message: "authentication failed",
    });

    // And logging out twice with the same Token is the same refusal, because after the
    // first there is no Token to present.
    const user = await admit();
    const issued = await logIn(user.id);
    assert.equal(
      (await carrying("DELETE", `${auth}/tokens/current`, issued.token)).statusCode,
      204,
    );
    assert.equal(
      (await carrying("DELETE", `${auth}/tokens/current`, issued.token)).statusCode,
      401,
    );
  });
});

describe("revoking everything", () => {
  it("revokes every Token of the presented User and no other User's", async () => {
    // The failure that matters, and the reason there is a second User in this test at
    // all: a `delete from tokens` with the wrong `where` — or with none — logs out the
    // whole deployment, and every other assertion in this file would still pass.
    const mine = await admit();
    const theirs = await admit();
    const ofMine = await Promise.all([logIn(mine.id), logIn(mine.id), logIn(mine.id)]);
    const ofTheirs = await Promise.all([logIn(theirs.id), logIn(theirs.id)]);

    // Every one of them works first, so what follows is about the revocation rather
    // than about a Token that was never any good.
    for (const issued of ofMine) await works(issued.token, mine, "a Token before revoking");
    for (const issued of ofTheirs) await works(issued.token, theirs, "a Token before revoking");

    const [presented] = ofMine;
    assert.ok(presented !== undefined);
    const revoked = await carrying("DELETE", `${auth}/tokens`, presented.token);
    assert.equal(revoked.statusCode, 204, revoked.body);
    assert.equal(revoked.body, "");

    // Every Token of the presented User, including the one that made the request:
    // this is the answer to "I think I have been compromised", so leaving the caller's
    // own Token working would leave the leaked session that made the call working too.
    for (const issued of ofMine) await refused(issued.token, "a Token of the revoking User");

    // And nobody else's, asserted the only way that means anything: by presenting one.
    for (const issued of ofTheirs) await works(issued.token, theirs, "another User's Token");

    // The other User can still revoke their own, which says the first revocation left
    // the route working rather than the table empty.
    const [alsoPresented] = ofTheirs;
    assert.ok(alsoPresented !== undefined);
    assert.equal((await carrying("DELETE", `${auth}/tokens`, alsoPresented.token)).statusCode, 204);
    for (const issued of ofTheirs) await refused(issued.token, "a Token of the second User");
  });

  it("leaves the password alone, so the User can log in again", async () => {
    // Revoking is not removal, and there is no removal: a User whose Tokens are all
    // gone is a User with no sessions, not a User who is shut out (ADR-0029). An
    // Operator locking somebody out revokes *and* replaces their password.
    const user = await admit();
    const issued = await logIn(user.id);
    assert.equal((await carrying("DELETE", `${auth}/tokens`, issued.token)).statusCode, 204);
    await refused(issued.token, "a revoked Token");

    const again = await logIn(user.id);
    await works(again.token, user, "a Token minted after revoking everything");
  });

  it("refuses a request that presented nothing", async () => {
    const anonymous = await publicServer.inject({ method: "DELETE", url: `${auth}/tokens` });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.deepEqual(anonymous.json(), {
      statusCode: 401,
      error: "Unauthorized",
      message: "authentication failed",
    });
  });
});

describe("changing a password", () => {
  const replacement = "a different long and dull passphrase";

  it("takes the current password, and the new one is what works afterwards", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    const changed = await carrying("PUT", `${auth}/password`, issued.token, {
      currentPassword: password,
      newPassword: replacement,
    });
    assert.equal(changed.statusCode, 204, changed.body);
    assert.equal(changed.body, "");

    // The old one stops minting Tokens, with the same 401 a wrong password always got.
    const withOld = await attempt(user.id, password);
    assert.equal(withOld.statusCode, 401, withOld.body);
    assert.deepEqual(withOld.json(), {
      statusCode: 401,
      error: "Unauthorized",
      message: "authentication failed",
    });

    // And the new one starts, which is the whole claim: a User rotated their own
    // credential with no Operator involved (User story 22).
    const withNew = await logIn(user.id, replacement);
    assert.deepEqual(withNew.user, user);
    await works(withNew.token, user, "a Token minted with the new password");

    // Twice, because a change has to leave a digest the *next* change can verify: a
    // second rotation proves the first wrote something readable rather than something
    // that merely stopped the old password working.
    const twice = await carrying("PUT", `${auth}/password`, withNew.token, {
      currentPassword: replacement,
      newPassword: password,
    });
    assert.equal(twice.statusCode, 204, twice.body);
    await logIn(user.id, password);
  });

  it("refuses a wrong current password, and changes nothing", async () => {
    // The requirement that keeps this self-service rather than account recovery:
    // recovery means proving identity *without* the credential, which this framework
    // declined to build (ADR-0014, ADR-0030). A valid Token is not enough.
    const user = await admit();
    const issued = await logIn(user.id);

    const refusedChange = await carrying("PUT", `${auth}/password`, issued.token, {
      currentPassword: "not the password",
      newPassword: replacement,
    });
    assert.equal(refusedChange.statusCode, 401, refusedChange.body);
    assert.deepEqual(refusedChange.json(), {
      statusCode: 401,
      error: "Unauthorized",
      message: "authentication failed",
    });

    // Nothing changed: the old password still works, and the one that was proposed
    // does not. A refusal that had written the new digest anyway would be a takeover
    // of any account whose Token leaked.
    await logIn(user.id, password);
    assert.equal((await attempt(user.id, replacement)).statusCode, 401);

    // And the Token that tried is still good, so a failed attempt is not a logout.
    await works(issued.token, user, "the Token that attempted the change");
  });

  it("leaves every existing Token working", async () => {
    // A **deliberate** non-behaviour, pinned so that it is a decision a reader meets
    // rather than an oversight they assume (ADR-0030). A User who changed their
    // password because they feared a leak is served by `DELETE /tokens`, which is one
    // request away and takes that choice with it; bundling the two would log a User
    // out of every device for a routine rotation nobody was worried about.
    const user = await admit();
    const [changing, elsewhere, alsoElsewhere] = await Promise.all([
      logIn(user.id),
      logIn(user.id),
      logIn(user.id),
    ]);

    const changed = await carrying("PUT", `${auth}/password`, changing.token, {
      currentPassword: password,
      newPassword: replacement,
    });
    assert.equal(changed.statusCode, 204, changed.body);

    await works(changing.token, user, "the Token that changed the password");
    await works(elsewhere.token, user, "a Token on another device");
    await works(alsoElsewhere.token, user, "a third Token");

    // And the remedy the User has instead, in the next request, which is the reason
    // the above is acceptable: revoking is theirs to ask for.
    assert.equal((await carrying("DELETE", `${auth}/tokens`, changing.token)).statusCode, 204);
    for (const issued of [changing, elsewhere, alsoElsewhere]) {
      await refused(issued.token, "a Token after the User revoked everything");
    }
  });

  it("changes the presented User's password and cannot be pointed at another's", async () => {
    // The User is read from the Token, and the body has **no `user` field** for one to
    // arrive through — the same absent capability that keeps `attributes` off
    // `POST /users` (ADR-0029). So naming somebody else changes nothing about them:
    // the field reaches nothing, and what changes is the caller's own password.
    const mine = await admit();
    const theirs = await admit();
    const issued = await logIn(mine.id);

    const changed = await carrying("PUT", `${auth}/password`, issued.token, {
      user: theirs.id,
      currentPassword: password,
      newPassword: replacement,
    });
    assert.equal(changed.statusCode, 204, changed.body);

    // The other User is untouched: their old password still works and the proposed one
    // does not.
    await logIn(theirs.id, password);
    assert.equal((await attempt(theirs.id, replacement)).statusCode, 401);

    // And the caller's own password is the one that changed.
    await logIn(mine.id, replacement);
    assert.equal((await attempt(mine.id, password)).statusCode, 401);
  });

  it("refuses a request it cannot read, and one that presented nothing", async () => {
    const user = await admit();
    const issued = await logIn(user.id);

    for (const payload of [
      {},
      { currentPassword: password },
      { newPassword: replacement },
      // A password that scrypt would read all of, on a route nothing rate limits.
      { currentPassword: password, newPassword: "x".repeat(1025) },
      { currentPassword: "", newPassword: replacement },
    ]) {
      const response = await carrying("PUT", `${auth}/password`, issued.token, payload);
      assert.notEqual(response.statusCode, 204, JSON.stringify(payload));
    }
    // The password is still the one it was: none of the above changed anything.
    await logIn(user.id, password);

    const anonymous = await publicServer.inject({
      method: "PUT",
      url: `${auth}/password`,
      payload: { currentPassword: password, newPassword: replacement },
    });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    await logIn(user.id, password);
  });
});

describe("revoking from trusted code", () => {
  it("revokes every Token of one User, and no other User's", async () => {
    // The same thing `DELETE /tokens` does, reachable without HTTP: an Operator who
    // learns from their own systems that a credential leaked revokes it from the code
    // that learned, rather than logging in as the User to do it.
    const mine = await admit();
    const theirs = await admit();
    const ofMine = await Promise.all([logIn(mine.id), logIn(mine.id)]);
    const ofTheirs = await logIn(theirs.id);

    await db.tx((tx) => directory.revoke(tx, mine.id));

    // Asserted over HTTP, like everything else: the claim is that the Tokens stopped
    // working, and the only way to ask that is to present them.
    for (const issued of ofMine) await refused(issued.token, "a Token revoked by trusted code");
    await works(ofTheirs.token, theirs, "another User's Token");
  });

  it("takes the caller's transaction, so a rollback revokes nothing", async () => {
    // What "takes the transaction first" buys, made observable (ADR-0023): revoking
    // and recording why in the Operator's own tables commit together or not at all.
    // If this method found its own connection, the Token below would be gone despite
    // the rollback and the Operator would never be told.
    const user = await admit();
    const issued = await logIn(user.id);

    await assert.rejects(
      db.tx(async (tx) => {
        await directory.revoke(tx, user.id);
        throw new Error("the Operator changed their mind");
      }),
      /changed their mind/,
    );

    await works(issued.token, user, "a Token whose revocation was rolled back");

    // And the same call committed does revoke it, so what the rollback undid was a
    // revocation that would otherwise have happened.
    await db.tx((tx) => directory.revoke(tx, user.id));
    await refused(issued.token, "a Token whose revocation committed");
  });

  it("is idempotent, and a User with no Tokens is not an error", async () => {
    const user = await admit();
    await db.tx((tx) => directory.revoke(tx, user.id));
    await db.tx((tx) => directory.revoke(tx, user.id));

    // Including a User that does not exist: there is no row to find and nothing to
    // report, and a revocation that answered differently would be an oracle for
    // whether an id names somebody (ADR-0030).
    await db.tx((tx) => directory.revoke(tx, "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21"));
  });
});

describe("the routes under the Operator's prefixes", () => {
  it("answer where the plugin was registered, and nowhere else", async () => {
    const user = await admit();
    const [first, second] = await Promise.all([logIn(user.id), logIn(user.id)]);

    // Both registrations carry all three, which is the claim that the plugin has no
    // prefix of its own — re-asserted now that the plugin has three more routes.
    assert.equal(
      (await carrying("DELETE", `${alsoAt}/tokens/current`, first.token)).statusCode,
      204,
    );
    await refused(first.token, "a Token logged out through the other prefix");
    await works(second.token, user, "a Token untouched by the other prefix");

    // Nothing answers where the plugin was not put, including at the root, which is
    // where a plugin that named its own prefix would have put these.
    for (const url of ["/tokens", "/tokens/current", "/password", "/auth/token/current"]) {
      const response = await carrying("DELETE", url, second.token);
      assert.equal(response.statusCode, 404, url);
    }

    // And none of them is on the Agent server, which authenticates nobody at all
    // (ADR-0010) and is not where a credential goes.
    for (const url of [`${auth}/tokens`, "/tokens", "/users/tokens"]) {
      const onTheAgentServer = await agentServer.inject({
        method: "DELETE",
        url,
        headers: { authorization: `Bearer ${second.token}` },
      });
      assert.equal(onTheAgentServer.statusCode, 404, url);
    }
  });

  it("refuses a query parameter rather than answering it", async () => {
    const user = await admit();
    const issued = await logIn(user.id);
    // A credential in a URL is a credential in every access log between here and the
    // client, so these routes take no query parameters at all.
    const response = await carrying("DELETE", `${auth}/tokens?user=${user.id}`, issued.token);
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json<{ message: string }>().message, /not a parameter of this route/);
    await works(issued.token, user, "a Token whose revocation was refused");
  });
});
