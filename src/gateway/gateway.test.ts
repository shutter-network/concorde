import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, type JsonWebKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { createDecisions, type DecisionRecord, type Decisions } from "../decisions/index.ts";
import * as decisionsSchema from "../decisions/schema/index.ts";
import { createHttpChannel, type HttpChannel } from "../http-channel/index.ts";
import type { Logger } from "../logging/logging.ts";
import {
  createMessenger,
  type MessageRecord,
  type Messenger,
  messageReceivedKind,
} from "../messenger/index.ts";
import * as messengerSchema from "../messenger/schema/index.ts";
import { createPasswordAuth, type IssuedToken, type PasswordAuth } from "../password-auth/index.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import {
  createScheduler,
  type ScheduleFiredRecord,
  type ScheduleRecord,
  type Scheduler,
  scheduleFiredKind,
} from "../scheduler/index.ts";
import * as schedulerSchema from "../scheduler/schema/index.ts";
import type { RunRecord, SignalHandler, SignalRecord } from "../signals/index.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignatures, type Signatures } from "../signatures/index.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";
import { createUsers, type UserRecord, type Users } from "../users/index.ts";
import * as usersSchema from "../users/schema/index.ts";
import type { Component, Gateway } from "./components.ts";
import { createGateway, describedVersion, type InfraComponents } from "./gateway.ts";

const hour = 60 * 60 * 1000;

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const nobody = "2f1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21";

const { privateKey: signingKey } = generateKeyPairSync("ed25519");

const theInfra = ["db", "agentServer", "publicServer", "worker"];

const theRecord = [
  "db",
  "agentServer",
  "publicServer",
  "users",
  "passwordAuth",
  "signatures",
  "decisions",
  "messenger",
  "httpChannel",
  "scheduler",
  "notes",
  "worker",
];

type Notebook = Component & {
  readonly lines: string[];
  readonly running: boolean;
};

function notebook(): Notebook {
  let running = false;
  return {
    lines: [],
    get running() {
      return running;
    },
    start: async () => {
      running = true;
    },
    stop: async () => {
      running = false;
    },
  };
}

type Stack = {
  readonly users: Users;
  readonly passwordAuth: PasswordAuth;
  readonly signatures: Signatures;
  readonly decisions: Decisions;
  readonly messenger: Messenger;
  readonly httpChannel: HttpChannel;
  readonly scheduler: Scheduler;
};

function fullStack({ db, agentServer, publicServer, worker }: InfraComponents): Stack {
  const users = createUsers({ db, agentServer, publicServer });
  const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl: hour });
  const signatures = createSignatures({ signingKey, agentServer, publicServer, logger: silent });
  const decisions = createDecisions({ db, signatures, agentServer, publicServer });
  const messenger = createMessenger({ db, users, worker, agentServer });
  const httpChannel = createHttpChannel({ db, messenger, publicServer });
  const scheduler = createScheduler({ db, worker, agentServer, logger: silent });
  return { users, passwordAuth, signatures, decisions, messenger, httpChannel, scheduler };
}

const callbacks: string[] = [];

const awkwardJson = { list: [1, "two", null, { deep: true }], nothing: null };

const roundTripKind = "the.round.trip";
const roundTripSession = "the round trip";
const roundTripPayload = { text: "say this back to me", nested: awkwardJson };

const theOnePassword = "the only password in this file";
const roundTripAttributes = { groups: ["reviewers"], nested: awkwardJson };

const roundTripSubmission = "and one from me, while everything is still up";

function roundTripContext(user: string): { readonly user: string; readonly nested: unknown } {
  return { user, nested: awkwardJson };
}

const roundTripping: SignalHandler<{ readonly text: string; readonly user: string }> = {
  handle: (signal) => [
    {
      session: roundTripSession,
      text: signal.payload.text,
      context: roundTripContext(signal.payload.user),
    },
  ],
};

const duringTheRoundTrip: string[] = [];

const roundTripReply = "said back, by the Run whose context named you";

const scheduleFiring: SignalHandler<ScheduleFiredRecord> = {
  handle: (signal) => [{ session: `schedule_${signal.payload.scheduleName}`, text: "fired" }],
};

const inFlightAtShutdown = "are you still there?";

const decidedOnTheWayOut = "the March rollout is off, decided while the Gateway was stopping";

type Full = InfraComponents & Stack & { notes: Notebook };

let database: TestDatabase;
let gateway: Gateway<Full>;
let components: Full;

let client: { readonly id: string; readonly token: string };

let agentUrl: string;
let publicUrl: string;

const shuttingDown = Promise.withResolvers<void>();

const duringTheDrain: string[] = [];

const runtime = fakeRuntime(async (prompt) => {
  if (prompt.session === roundTripSession) {
    duringTheRoundTrip.push(
      await reaching("the Messenger took a Message for the named User", async () => {
        const sent = await postJson(`${agentUrl}/messages`, {
          userId: client.id,
          text: roundTripReply,
        });
        return String(sent.status);
      }),
    );
    return { ok: true };
  }
  if (prompt.text !== inFlightAtShutdown) return { ok: true };
  await shuttingDown.promise;
  duringTheDrain.push(...(await whatIsStillUp()));
  return { ok: false, error: "this Run exists to be in flight while the Gateway shuts down" };
});

before(async () => {
  database = await createTestDatabase("gateway");

  gateway = createGateway({
    databaseUrl: database.url,
    runtime,
    agentListen: { port: 0, host: "127.0.0.1" },
    publicListen: { port: 0, host: "127.0.0.1" },
    extend: (infra) => {
      callbacks.push("extend");
      assert.deepEqual(Object.keys(infra), theInfra);
      infra.agentServer.fastify.addHook("onRequest", async (request, reply) => {
        if (request.method !== "POST" || !request.url.startsWith("/messages")) return;
        const context = request.concordeRun?.context;
        if (isObject(context) && context.user === client.id) return;
        return reply.code(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "this Run may not message that User",
        });
      });
      return { ...fullStack(infra), notes: notebook() };
    },
    handlers: (all) => {
      callbacks.push("handlers");
      return {
        [messageReceivedKind]: answering(all),
        [roundTripKind]: roundTripping,
        [scheduleFiredKind]: scheduleFiring,
      };
    },
    logger: silent,
  });
  components = gateway.components;

  await applySchema(
    components.db,
    signalsSchema,
    usersSchema,
    passwordAuthSchema,
    decisionsSchema,
    messengerSchema,
    schedulerSchema,
  );

  await gateway.start();
  agentUrl = components.agentServer.fastify.listeningOrigin;
  publicUrl = components.publicServer.fastify.listeningOrigin;

  client = await admitted();
});

after(async () => {
  await gateway?.stop();
  await database.drop();
});

function answering(all: Full): SignalHandler<MessageRecord> {
  return {
    handle(signal) {
      all.notes.lines.push(signal.payload.text);
      return [{ session: `user_${signal.payload.userId}`, text: signal.payload.text }];
    },
    async post(signal, outcome) {
      if (!outcome.failed) return;
      duringTheDrain.push(
        await reaching("the HTTP Channel sent a Message", async () => {
          const sent = await all.db.tx((tx) =>
            all.messenger.send(tx, signal.payload.userId, "Something went wrong."),
          );
          return sent.direction;
        }),
      );
      duringTheDrain.push(
        await reaching("Decisions published a Decision", async () => {
          const published = await all.db.tx((tx) => all.decisions.publish(tx, decidedOnTheWayOut));
          const [found] = await all.decisions.history({ after: published.seq - 1 });
          if (found === undefined) return "committed to nothing";
          return found.jws === published.jws ? "the same artifact" : "another artifact";
        }),
      );
    },
  };
}

describe("a whole deployment from one call", () => {
  it("holds the infrastructure and the extension, in the start order, with the Worker keyed last", () => {
    assert.deepEqual(Object.keys(components), theRecord);
  });

  it("runs extend before handlers, so a Handler can reach a Component extend returned", () => {
    assert.deepEqual(callbacks, ["extend", "handlers"]);
    assert.equal(components.notes.running, true);
    assert.deepEqual(components.notes.lines, []);
  });

  it("wired every part to every other, which is nine route groups on two servers", async () => {
    assert.equal((await fetch(`${agentUrl}/users`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/signals`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/messages?user=${client.id}`)).status, 200);
    assert.equal((await fetch(`${agentUrl}/decisions`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/users/me`)).status, 200);
    assert.equal(
      (await postJson(`${publicUrl}/auth/tokens`, { user: nobody, password: "not anybody's" }))
        .status,
      401,
    );
    assert.equal((await authenticated(`${publicUrl}/messages`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/decisions`)).status, 200);
    assert.equal((await fetch(`${publicUrl}/jwks.json`)).status, 200);
    assert.equal((await postJson(`${agentUrl}/sign`, {})).status, 400);
    assert.equal((await postJson(`${publicUrl}/verify`, {}, client.token)).status, 400);
  });

  it("has the Messenger's foreign key onto the Users table, and it is enforced", async () => {
    await assert.rejects(
      () => components.db.tx((tx) => components.messenger.send(tx, nobody, "nobody reads this")),
      { name: "UnknownUserError" },
    );
  });

  it("starts and stops the idle parts with nothing to run, and no call does a thing", async () => {
    for (const idle of [
      components.users,
      components.passwordAuth,
      components.signatures,
      components.decisions,
      components.messenger,
    ]) {
      await idle.start();
      await idle.stop();
    }

    assert.equal((await authenticated(`${publicUrl}/messages`)).status, 200);
    assert.equal((await authenticated(`${publicUrl}/decisions`)).status, 200);
    assert.equal((await fetch(`${publicUrl}/jwks.json`)).status, 200);
    assert.equal((await components.users.get(client.id))?.id, client.id);
    assert.deepEqual(await components.messenger.history(client.id), []);
  });

  it("answers a Signal and its Run as the Signal Worker recorded them, and drops nothing", async () => {
    const payload = { ...roundTripPayload, user: client.id };
    const signalId = await components.db.tx((tx) =>
      components.worker.emit(tx, { kind: roundTripKind, payload }),
    );
    await waitUntil("the emitted Signal has been handled and its Run has finished", async () => {
      const signal = await agentJson<SignalRecord>(`/signals/${signalId}`);
      return signal.state === "done";
    });

    const signal = await agentJson<SignalRecord>(`/signals/${signalId}`);
    assert.deepEqual(signal, {
      id: signalId,
      kind: roundTripKind,
      payload,
      emittedAt: signal.emittedAt,
      state: "done",
      error: null,
    } satisfies SignalRecord);
    assert.equal(new Date(signal.emittedAt).toISOString(), signal.emittedAt);

    const listed = await agentJson<{ signals: SignalRecord[] }>(`/signals?kind=${roundTripKind}`);
    assert.deepEqual(listed.signals, [signal]);

    const runs = await agentJson<{ runs: RunRecord[] }>(`/runs?signalId=${signalId}`);
    assert.equal(runs.runs.length, 1, "the round-trip Handler returned exactly one Prompt");
    const [run] = runs.runs;
    assert.ok(run !== undefined);
    assert.deepEqual(run, {
      id: run.id,
      signalId,
      session: roundTripSession,
      prompt: roundTripPayload.text,
      context: roundTripContext(client.id),
      state: "done",
      error: null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    } satisfies RunRecord);

    assert.deepEqual(duringTheRoundTrip, ["the Messenger took a Message for the named User: 201"]);
    assert.equal(new Date(String(run.startedAt)).toISOString(), run.startedAt);
    assert.equal(new Date(String(run.endedAt)).toISOString(), run.endedAt);

    assert.deepEqual(await agentJson<RunRecord>(`/runs/${run.id}`), run);
  });

  it("answers a User and an issued Token as Users recorded them, and drops nothing", async () => {
    const created = await components.db.tx(async (tx) => {
      const user = await components.users.create(tx);
      await components.users.setAttributes(tx, user.id, roundTripAttributes);
      await components.passwordAuth.setPassword(tx, user.id, theOnePassword);
      return user;
    });
    const recorded = await components.users.get(created.id);
    assert.ok(recorded !== undefined, "the User this test just created should be readable");

    const read = await agentJson<UserRecord>(`/users/${created.id}`);
    assert.deepEqual(read, {
      id: created.id,
      attributes: roundTripAttributes,
      createdAt: recorded.createdAt,
    } satisfies UserRecord);

    const listed = await agentJson<{ users: UserRecord[] }>("/users?limit=2");
    assert.deepEqual(listed.users, [read, await agentJson<UserRecord>(`/users/${client.id}`)]);

    const minted = await components.db.tx((tx) =>
      components.passwordAuth.issueToken(tx, created.id),
    );
    const login = await postJson(`${publicUrl}/auth/tokens`, {
      user: created.id,
      password: theOnePassword,
    });
    const issuedBody = await login.text();
    assert.equal(login.status, 201, issuedBody);
    const issued: IssuedToken = JSON.parse(issuedBody);
    assert.deepEqual(Object.keys(issued).sort(), Object.keys(minted).sort());
    assert.deepEqual(issued, {
      token: issued.token,
      expiresAt: issued.expiresAt,
      user: read,
    } satisfies IssuedToken);
    assert.equal(issued.token.length, minted.token.length);
    assert.notEqual(issued.token, minted.token);
    assert.equal(new Date(issued.expiresAt).toISOString(), issued.expiresAt);

    const presented = await fetch(`${publicUrl}/users/me`, {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    const presentedBody = await presented.text();
    assert.equal(presented.status, 200, presentedBody);
    assert.deepEqual(JSON.parse(presentedBody), read);

    for (const [what, body] of [
      ["GET /users/:id", JSON.stringify(read)],
      ["GET /users", JSON.stringify(listed)],
      ["POST /auth/tokens", issuedBody],
      ["GET /users/me", presentedBody],
    ] as const) {
      assert.equal(/password|scrypt/i.test(body), false, `${what} carried a credential: ${body}`);
    }

    const changing = { currentPassword: theOnePassword, newPassword: "and its replacement" };
    for (const [method, path, token, body] of [
      ["PUT", "/auth/password", issued.token, changing],
      ["DELETE", "/auth/tokens/current", issued.token, undefined],
      ["DELETE", "/auth/tokens", minted.token, undefined],
    ] as const) {
      const answered = await fetch(`${publicUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const answeredBody = await answered.text();
      assert.equal(answered.status, 204, `${method} ${path}: ${answeredBody}`);
      assert.equal(answeredBody, "");
      assert.equal(answered.headers.get("content-type"), null);
    }
  });

  it("answers a Message log as the HTTP Channel recorded it, and pages it three ways", async () => {
    const reader = await admitted();

    const first = await sending(reader.id, "the first thing the agent said");
    const submitted = await postJson(
      `${publicUrl}/messages`,
      { text: roundTripSubmission },
      reader.token,
    );
    const submittedBody = await submitted.text();
    assert.equal(submitted.status, 201, submittedBody);
    const second: MessageRecord = JSON.parse(submittedBody);
    const third = await sending(reader.id, "and the answer to it");
    const fourth = await sending(reader.id, "and one more, unasked");

    const recorded = await components.messenger.history(reader.id);
    assert.deepEqual(
      recorded.map((message) => message.seq),
      [1, 2, 3, 4],
    );
    const [, held] = recorded;
    assert.ok(held !== undefined);

    assert.deepEqual(second, {
      id: held.id,
      userId: reader.id,
      direction: "inbound",
      seq: 2,
      text: roundTripSubmission,
      createdAt: held.createdAt,
    } satisfies MessageRecord);
    assert.equal(new Date(second.createdAt).toISOString(), second.createdAt);

    await waitUntil("the submitted Message has woken its Handler", async () =>
      components.notes.lines.includes(roundTripSubmission),
    );

    const agentRead = await agentJson<{ messages: MessageRecord[] }>(`/messages?user=${reader.id}`);
    assert.deepEqual(agentRead.messages, recorded);
    assert.deepEqual((await ownLog(reader.token, "")).messages, recorded);

    assert.deepEqual(await ownTexts(reader.token, "?limit=2"), [third.text, fourth.text]);
    assert.deepEqual(await ownTexts(reader.token, "?before=3&limit=2"), [first.text, second.text]);
    assert.deepEqual(await ownTexts(reader.token, "?after=2"), [third.text, fourth.text]);
    assert.deepEqual(
      await ownTexts(reader.token, "?after=0"),
      recorded.map((message) => message.text),
    );

    const bothCursors = await bearing(`${publicUrl}/messages?after=1&before=4`, reader.token);
    const refusal: { statusCode: number; error: string; message: string } = JSON.parse(
      await bothCursors.text(),
    );
    assert.equal(bothCursors.status, 400);
    assert.deepEqual(Object.keys(refusal).sort(), ["error", "message", "statusCode"]);
    assert.match(refusal.message, /Use after or before/);
  });

  it("answers a Decision as Decisions published it, and a key set with nothing private in it", async () => {
    const published = await postJson(`${agentUrl}/decisions`, {
      statement: "we will keep the Gateway trusted and say so out loud",
    });
    const publishedBody = await published.text();
    assert.equal(published.status, 201, publishedBody);
    const decision: DecisionRecord = JSON.parse(publishedBody);

    const read = await bearing(`${publicUrl}/decisions?after=${decision.seq - 1}`, client.token);
    const readBody = await read.text();
    assert.equal(read.status, 200, readBody);
    const { decisions }: { decisions: DecisionRecord[] } = JSON.parse(readBody);
    assert.deepEqual(decisions, [
      {
        seq: decision.seq,
        statement: "we will keep the Gateway trusted and say so out loud",
        jws: decision.jws,
        createdAt: decision.createdAt,
      } satisfies DecisionRecord,
    ]);

    const numbered = await bearing(`${publicUrl}/decisions/${decision.seq}`, client.token);
    const numberedBody = await numbered.text();
    assert.equal(numbered.status, 200, numberedBody);
    assert.deepEqual(JSON.parse(numberedBody), decisions[0]);

    const [header, payload, signature] = decision.jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined);
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), {
      seq: decision.seq,
      createdAt: decision.createdAt,
      statement: decision.statement,
    });

    const keys = await fetch(`${publicUrl}/jwks.json`);
    const keysBody = await keys.text();
    assert.equal(keys.status, 200, keysBody);
    const [key]: JsonWebKey[] = JSON.parse(keysBody).keys;
    assert.ok(key !== undefined, keysBody);
    assert.equal(Object.hasOwn(key, "d"), false, keysBody);
    assert.equal(keysBody.includes(String(signingKey.export({ format: "jwk" }).d)), false);

    assert.equal(
      verify(
        null,
        Buffer.from(`${header}.${payload}`, "utf8"),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
  });

  it("signs whatever the agent asks for, and checks one back for a User", async () => {
    const claimed = "a receipt for the March invoice, which is not a Decision";
    const signed = await postJson(`${agentUrl}/sign`, {
      statement: claimed,
      typ: "concorde-decision+jws",
    });
    const signedBody = await signed.text();
    assert.equal(signed.status, 200, signedBody);
    const { jws }: { jws: string } = JSON.parse(signedBody);

    const [header, payload, signature] = jws.split(".");
    assert.ok(header !== undefined && payload !== undefined && signature !== undefined);
    const keys = await fetch(`${publicUrl}/jwks.json`);
    const [key]: JsonWebKey[] = JSON.parse(await keys.text()).keys;
    assert.ok(key !== undefined);
    assert.equal(
      verify(
        null,
        Buffer.from(`${header}.${payload}`, "utf8"),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
    assert.deepEqual(decoded(header), { alg: "EdDSA", typ: "concorde-decision+jws" });
    assert.deepEqual(decoded(payload), { statement: claimed });

    const { decisions } = await agentJson<{ decisions: DecisionRecord[] }>("/decisions?after=0");
    assert.equal(
      decisions.some((published) => published.jws === jws),
      false,
      "signing must not have published anything",
    );

    const refused = await fetch(`${publicUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jws }),
    });
    assert.equal(refused.status, 401);
    const elsewhere = await fetch(`${publicUrl}/users/me`);
    assert.equal(elsewhere.status, 401);
    assert.deepEqual(JSON.parse(await refused.text()), JSON.parse(await elsewhere.text()));

    const checked = await postJson(`${publicUrl}/verify`, { jws }, client.token);
    const checkedBody = await checked.text();
    assert.equal(checked.status, 200, checkedBody);
    assert.deepEqual(JSON.parse(checkedBody), {
      verified: true,
      header: decoded(header),
      payload: decoded(payload),
    });

    const nonsense = await postJson(
      `${publicUrl}/verify`,
      { jws: "not an artifact" },
      client.token,
    );
    const nonsenseBody = await nonsense.text();
    assert.equal(nonsense.status, 200, nonsenseBody);
    assert.deepEqual(JSON.parse(nonsenseBody), { verified: false });
  });

  it("answers a Schedule as the Scheduler recorded it, and drops nothing", async () => {
    const at = "2999-01-01T00:00:00.000Z";
    const produced = await components.scheduler.schedule({
      name: "the-round-trip-schedule",
      spec: { kind: "once", at },
      data: awkwardJson,
    });
    assert.equal(produced.created, true, "the round-trip Schedule should be newly created");

    const expected = {
      name: "the-round-trip-schedule",
      spec: { kind: "once", at },
      data: awkwardJson,
      until: null,
      nextFireAt: at,
    } satisfies ScheduleRecord;

    assert.deepEqual(produced.schedule, expected);

    const read = await agentJson<ScheduleRecord>("/schedules/the-round-trip-schedule");
    assert.deepEqual(read, expected);

    const listed = await agentJson<{ schedules: ScheduleRecord[] }>("/schedules");
    assert.deepEqual(listed.schedules, [expected]);
  });

  it("drains with everything still up, and closes it all once the drain is done", async () => {
    const posted = await postMessage(inFlightAtShutdown);
    assert.equal(posted.status, 201);

    await waitUntil("the Run of the submitted Message has started", async () =>
      runtime.texts().includes(inFlightAtShutdown),
    );

    assert.deepEqual(components.notes.lines, [roundTripSubmission, inFlightAtShutdown]);

    const stopped = gateway.stop();
    shuttingDown.resolve();
    await stopped;

    assert.deepEqual(duringTheDrain, [
      "Users read the Db: 1 User",
      "the Agent server answered: 200",
      "the Public server took a submission: 201",
      "the Operator's own Component: still running",
      "the HTTP Channel sent a Message: outbound",
      "Decisions published a Decision: the same artifact",
    ]);

    await assert.rejects(() => fetch(`${agentUrl}/signals`));
    await assert.rejects(() => fetch(`${publicUrl}/messages`));
    await assert.rejects(() => components.users.list());
  });
});

describe("the infrastructure on its own", () => {
  it("is the four infrastructure Components and nothing else when no extend is passed", () => {
    const bare = createGateway({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      handlers: () => ({}),
    });

    assert.deepEqual(Object.keys(bare.components), theInfra);

    const db: Db = bare.components.db;
    assert.equal(typeof db.handle, "function");
  });

  it("refuses to construct without a database, naming the option", () => {
    assert.throws(
      () =>
        // @ts-expect-error databaseUrl is required; omitting it is the case under test
        createGateway({
          runtime,
          agentListen: { port: 0, host: "127.0.0.1" },
          publicListen: { port: 0, host: "127.0.0.1" },
          handlers: () => ({}),
        }),
      /databaseUrl/,
    );
  });

  it("refuses an extend that returns one of the four infrastructure keys", () => {
    const substituting = createGateway({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // @ts-expect-error worker is an infrastructure key and may not be replaced by an extension
      extend: (infra) => ({ notes: notebook(), worker: infra.worker }),
      handlers: () => ({}),
    });

    assert.deepEqual(Object.keys(substituting.components), [
      "db",
      "agentServer",
      "publicServer",
      "notes",
      "worker",
    ]);
  });

  it("refuses an extend that returns any of the other three infrastructure keys", () => {
    createGateway({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // @ts-expect-error db is an infrastructure key and may not be replaced by an extension
      extend: (infra) => ({ db: infra.db }),
      handlers: () => ({}),
    });
    createGateway({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // @ts-expect-error agentServer is an infrastructure key and may not be replaced
      extend: (infra) => ({ agentServer: infra.agentServer }),
      handlers: () => ({}),
    });
    createGateway({
      databaseUrl: "postgres://nobody@example.invalid/none",
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      // @ts-expect-error publicServer is an infrastructure key and may not be replaced
      extend: (infra) => ({ publicServer: infra.publicServer }),
      handlers: () => ({}),
    });
  });
});

describe("the description both servers serve", () => {
  const nowhere = "postgres://nobody@example.invalid/none";

  const agentPaths = [
    "/decisions/",
    "/decisions/{seq}",
    "/messages/",
    "/runs",
    "/runs/{id}",
    "/schedules",
    "/schedules/{name}",
    "/sign",
    "/signals",
    "/signals/{id}",
    "/users/",
    "/users/{id}",
  ];
  const publicPaths = [
    "/auth/password",
    "/auth/tokens",
    "/auth/tokens/current",
    "/decisions/",
    "/decisions/{seq}",
    "/jwks.json",
    "/messages/",
    "/users/me",
    "/verify",
  ];

  type Property = {
    readonly type?: string;
    readonly description?: string;
    readonly enum?: readonly string[];
    readonly items?: Schema;
  };
  type Schema = {
    readonly properties?: Readonly<Record<string, Property>>;
    readonly required?: readonly string[];
  };
  type Parameter = {
    readonly name: string;
    readonly required?: boolean;
    readonly description?: string;
  };
  type Answered = {
    readonly description: string;
    readonly content?: Readonly<Record<string, { readonly schema: Schema }>>;
  };
  type Operation = {
    readonly tags?: readonly string[];
    readonly summary?: string;
    readonly description?: string;
    readonly parameters?: readonly Parameter[];
    readonly requestBody?: {
      readonly content: Readonly<Record<string, { readonly schema: Schema }>>;
    };
    readonly responses: Readonly<Record<string, Answered>>;
  };
  type Method = "get" | "post" | "put" | "delete";
  type Description = {
    readonly openapi: string;
    readonly info: {
      readonly title: string;
      readonly description: string;
      readonly version: string;
    };
    readonly paths: Readonly<Record<string, Partial<Record<Method, Operation>>>>;
  };

  let described: Gateway<InfraComponents & Stack>;

  before(async () => {
    described = unstarted();
    await described.components.agentServer.fastify.ready();
    await described.components.publicServer.fastify.ready();
  });

  after(async () => {
    await described.components.agentServer.fastify.close();
    await described.components.publicServer.fastify.close();
  });

  it("describes the Agent server, and nothing the Public server serves", async () => {
    const document = await documentOf(described.components.agentServer.fastify);

    assert.equal(document.openapi, "3.0.3");
    assert.equal(document.info.title, "Concorde: agent server");
    assert.equal(document.info.version, describedVersion);
    assert.match(document.info.description, /no authentication/);

    assert.deepEqual(Object.keys(document.paths).sort(), agentPaths);
    assert.deepEqual(
      Object.keys(document.paths).filter((path) => path.startsWith("/auth/")),
      [],
    );

    assert.equal(Object.hasOwn(document.paths, "/openapi.json"), false);
    assert.equal(Object.hasOwn(document.paths, "/docs"), false);
  });

  it("describes the Public server, and nothing only the Agent server serves", async () => {
    const document = await documentOf(described.components.publicServer.fastify);

    assert.equal(document.openapi, "3.0.3");
    assert.equal(document.info.title, "Concorde: public server");
    assert.equal(document.info.version, describedVersion);
    assert.match(document.info.description, /bearer token/);

    assert.deepEqual(Object.keys(document.paths).sort(), publicPaths);
    for (const agentOnly of ["/signals", "/runs", "/users/", "/users/{id}"]) {
      assert.equal(Object.hasOwn(document.paths, agentOnly), false, `${agentOnly} is the agent's`);
    }
  });

  it("says what the Signal Worker's four routes answer with, and how they behave", async () => {
    const document = await documentOf(described.components.agentServer.fastify);
    const answers: Readonly<Record<string, readonly string[]>> = {
      "/signals": ["200", "400"],
      "/signals/{id}": ["200", "400", "404"],
      "/runs": ["200", "400"],
      "/runs/{id}": ["200", "400", "404"],
    };

    for (const [path, statuses] of Object.entries(answers)) {
      const route = document.paths[path]?.get;
      assert.ok(route !== undefined, `${path} should be described`);
      assert.deepEqual(Object.keys(route.responses), statuses, path);
      for (const [status, response] of Object.entries(route.responses)) {
        assert.notEqual(response.description, "Default Response", `${path} ${status}`);
      }

      assert.ok(route.tags !== undefined && route.tags.length > 0, `${path} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, path);

      const description = String(route.description);
      assert.match(description, /not restricted by user or session/, path);
      assert.match(description, /Unknown query parameters return 400/, path);
    }

    for (const path of ["/signals", "/runs"]) {
      assert.match(
        String(document.paths[path]?.get?.description),
        /Out-of-range values return 400/,
        path,
      );
    }
  });

  it("says what the three Users routes answer with, across both surfaces", async () => {
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const answers: readonly {
      readonly surface: keyof typeof documents;
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { surface: "agent", path: "/users/", method: "get", statuses: ["200", "400"] },
      { surface: "agent", path: "/users/{id}", method: "get", statuses: ["200", "400", "404"] },
      { surface: "public", path: "/users/me", method: "get", statuses: ["200", "400", "401"] },
    ];

    for (const { surface, path, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${path}`;
      const route = documents[surface].paths[path]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        assert.ok(Object.hasOwn(answered, "content"), `${where} ${status}`);
      }

      assert.ok(route.tags !== undefined && route.tags.length > 0, `${where} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
      assert.deepEqual(tagsOf(documents[surface], path, method), ["Users"], where);
    }

    assert.equal(documents.agent.paths["/users/"]?.post, undefined);
    assert.equal(documents.agent.paths["/users/{id}"]?.post, undefined);
    assert.equal(JSON.stringify(documents.agent.paths).includes('"requestBody"'), true);
    for (const surface of ["agent", "public"] as const) {
      for (const [path, operations] of Object.entries(documents[surface].paths)) {
        if (!path.startsWith("/users")) continue;
        assert.deepEqual(Object.keys(operations), ["get"], `${surface} ${path}`);
      }
    }
    assert.match(
      String(documents.agent.paths["/users/"]?.get?.description),
      /User creation and credential management are available only through trusted application code/,
    );

    const me = String(documents.public.paths["/users/me"]?.get?.description);
    assert.match(me, /Requires a credential/);
    assert.match(me, /auth scheme installed in this deployment/);

    const user = schemaOf(documents.agent, "/users/{id}", "get", "200");
    assert.deepEqual(Object.keys(user.properties ?? {}).sort(), ["attributes", "createdAt", "id"]);
    assert.deepEqual([...(user.required ?? [])].sort(), ["attributes", "createdAt", "id"]);
    for (const document of Object.values(documents)) {
      assert.equal(JSON.stringify(document).includes("passwordHash"), false);
      assert.equal(JSON.stringify(document).includes("password_hash"), false);
    }

    assert.equal(user.properties?.attributes?.type, undefined);

    assert.match(
      String(user.properties?.attributes?.description),
      /Built-in routes do not interpret attributes/,
    );
    assert.equal(user.properties?.id?.description, undefined);
    assert.equal(user.properties?.createdAt?.description, undefined);

    assert.deepEqual(
      Object.keys(schemaOf(documents.public, "/users/me", "get", "200").properties ?? {}).sort(),
      ["attributes", "createdAt", "id"],
    );
  });

  it("says what Password Auth's four routes answer with, and which one needs no Token", async () => {
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const answers: readonly {
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { path: "/auth/tokens", method: "post", statuses: ["201", "400", "401"] },
      { path: "/auth/tokens/current", method: "delete", statuses: ["204", "400", "401"] },
      { path: "/auth/tokens", method: "delete", statuses: ["204", "400", "401"] },
      { path: "/auth/password", method: "put", statuses: ["204", "400", "401"] },
    ];

    for (const { path, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${path}`;
      const route = documents.public.paths[path]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        assert.equal(Object.hasOwn(answered, "content"), status !== "204", `${where} ${status}`);
      }

      assert.deepEqual(tagsOf(documents.public, path, method), ["Authentication"], where);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    assert.equal(JSON.stringify(documents.agent.paths).includes("Authentication"), false);
    assert.deepEqual(tagsOf(documents.agent, "/users/", "get"), ["Users"]);
    for (const path of ["/auth/tokens", "/auth/tokens/current", "/auth/password"]) {
      assert.equal(documents.agent.paths[path], undefined, path);
    }

    for (const [path, method] of [
      ["/auth/tokens/current", "delete"],
      ["/auth/tokens", "delete"],
      ["/auth/password", "put"],
    ] as const) {
      const route = documents.public.paths[path]?.[method];
      assert.match(
        String(route?.description),
        /Requires authentication through a scheme installed/,
        path,
      );
    }
    const trading = String(documents.public.paths["/auth/tokens"]?.post?.description);
    assert.match(trading, /No credential is required/);

    const token = schemaOf(documents.public, "/auth/tokens", "post", "201");
    assert.deepEqual(Object.keys(token.properties ?? {}).sort(), ["expiresAt", "token", "user"]);
    assert.match(String(token.properties?.expiresAt?.description), /Token expiry/);
    assert.equal(token.properties?.token?.description, undefined);
  });

  it("says what the HTTP Channel's four routes answer with, and how a log is paged", async () => {
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const messages = "/messages/";

    const answers: readonly {
      readonly surface: keyof typeof documents;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { surface: "agent", method: "post", statuses: ["201", "400", "404", "503"] },
      { surface: "agent", method: "get", statuses: ["200", "400"] },
      { surface: "public", method: "post", statuses: ["201", "400", "401", "503"] },
      { surface: "public", method: "get", statuses: ["200", "400", "401"] },
    ];

    for (const { surface, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${messages} on the ${surface} server`;
      const route = documents[surface].paths[messages]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        assert.ok(Object.hasOwn(answered, "content"), `${where} ${status}`);
      }

      assert.ok(route.tags !== undefined && route.tags.length > 0, `${where} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    assert.deepEqual(tagsOf(documents.agent, messages, "post"), ["Messages"]);
    assert.deepEqual(tagsOf(documents.public, messages, "get"), ["Messages"]);
    assert.equal(tagsOf(documents.agent, "/signals", "get").includes("Messages"), false);
    assert.equal(tagsOf(documents.public, "/users/me", "get").includes("Messages"), false);

    for (const surface of ["agent", "public"] as const) {
      const reading = String(documents[surface].paths[messages]?.get?.description);
      assert.match(reading, /Without a cursor, returns the latest page/, surface);
      assert.match(reading, /Without a cursor, returns the latest page/, surface);
      assert.match(reading, /`before=N` returns the latest page below N/, surface);
      assert.match(reading, /`after=N` returns the next page above N/, surface);
      assert.match(reading, /Results are always ascending by seq/, surface);
      assert.match(reading, /Supplying both cursors returns 400/, surface);
      assert.match(reading, /A full page may have more results/, surface);
      assert.match(reading, /Clients store their own cursors/, surface);
      assert.match(reading, /Out-of-range values return 400/, surface);
    }

    const agentSend = bodyOf(documents.agent, messages, "post");
    assert.deepEqual(Object.keys(agentSend.properties ?? {}).sort(), ["text", "userId"]);
    assert.deepEqual([...(agentSend.required ?? [])].sort(), ["text", "userId"]);
    const submission = bodyOf(documents.public, messages, "post");
    assert.deepEqual(Object.keys(submission.properties ?? {}), ["text"]);
    assert.deepEqual(submission.required, ["text"]);
    assert.match(
      String(documents.public.paths[messages]?.post?.description),
      /body cannot select another user/,
    );

    const agentWindow = parametersOf(documents.agent, messages, "get");
    assert.deepEqual(
      agentWindow.filter((parameter) => parameter.required).map((parameter) => parameter.name),
      ["user"],
    );
    assert.deepEqual(
      parametersOf(documents.public, messages, "get")
        .map((parameter) => parameter.name)
        .sort(),
      ["after", "before", "limit"],
    );

    const fields = ["createdAt", "direction", "id", "seq", "text", "userId"];
    const message = schemaOf(documents.agent, messages, "post", "201");
    assert.deepEqual(Object.keys(message.properties ?? {}).sort(), fields);
    assert.deepEqual([...(message.required ?? [])].sort(), fields);
    assert.match(String(message.properties?.seq?.description), /Use it as the paging cursor/);
    assert.deepEqual(message.properties?.direction?.enum, ["inbound", "outbound"]);
    assert.match(
      String(message.properties?.direction?.description),
      /The route determines the direction/,
    );
    assert.equal(message.properties?.id?.description, undefined);
    assert.equal(message.properties?.userId?.description, undefined);
    assert.equal(message.properties?.createdAt?.description, undefined);

    const page = schemaOf(documents.public, messages, "get", "200");
    assert.deepEqual(Object.keys(page.properties ?? {}), ["messages"]);
    assert.deepEqual(
      Object.keys(page.properties?.messages?.items?.properties ?? {}).sort(),
      fields,
    );

    assert.match(
      String(documents.agent.paths[messages]?.post?.responses["404"]?.description),
      /No user has this id/,
    );
    for (const surface of ["agent", "public"] as const) {
      assert.match(
        String(documents[surface].paths[messages]?.post?.responses["503"]?.description),
        /message was not recorded; retry the request/,
        surface,
      );
    }

    for (const method of ["post", "get"] as const) {
      const route = documents.public.paths[messages]?.[method];
      assert.match(
        String(route?.description),
        /Requires authentication through a scheme installed/,
        method,
      );
      assert.match(String(route?.responses["401"]?.description), /Authentication failed/, method);
    }
  });

  it("says what Decisions' five routes answer with, and what the artifact in them is", async () => {
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const log = "/decisions/";
    const cited = "/decisions/{seq}";

    const answers: readonly {
      readonly surface: keyof typeof documents;
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { surface: "agent", path: log, method: "post", statuses: ["201", "400"] },
      { surface: "agent", path: log, method: "get", statuses: ["200", "400"] },
      { surface: "agent", path: cited, method: "get", statuses: ["200", "400", "404"] },
      { surface: "public", path: log, method: "get", statuses: ["200", "400", "401"] },
      { surface: "public", path: cited, method: "get", statuses: ["200", "400", "401", "404"] },
    ];

    for (const { surface, path, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${path} on the ${surface} server`;
      const route = documents[surface].paths[path]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        assert.ok(Object.hasOwn(answered, "content"), `${where} ${status}`);
      }
      assert.ok(route.tags !== undefined && route.tags.length > 0, `${where} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    assert.deepEqual(tagsOf(documents.agent, log, "post"), ["Decisions"]);
    assert.deepEqual(tagsOf(documents.public, log, "get"), ["Decisions"]);
    assert.deepEqual(tagsOf(documents.public, cited, "get"), ["Decisions"]);
    assert.equal(documents.public.paths[log]?.post, undefined);
    assert.equal(documents.public.paths[cited]?.post, undefined);

    for (const surface of ["agent", "public"] as const) {
      const citing = String(documents[surface].paths[cited]?.get?.description);
      assert.match(citing, /`GET \/decisions\/7`/, surface);
      assert.match(citing, /Fetch a decision by its sequence number/, surface);
      assert.match(citing, /Rollbacks can leave gaps/, surface);
      assert.deepEqual(
        parametersOf(documents[surface], cited, "get").map((parameter) => parameter.name),
        ["seq"],
        surface,
      );
    }

    for (const surface of ["agent", "public"] as const) {
      assert.deepEqual(
        parametersOf(documents[surface], log, "get")
          .map((parameter) => parameter.name)
          .sort(),
        ["after", "before", "limit"],
        surface,
      );
      const reading = String(documents[surface].paths[log]?.get?.description);
      assert.match(reading, /All authenticated users read the same decisions/, surface);
      assert.match(reading, /Without a cursor, returns the latest page/, surface);
      assert.match(reading, /Results are always ascending by seq/, surface);
    }

    const fields = ["createdAt", "jws", "seq", "statement"];
    const record = schemaOf(documents.agent, log, "post", "201");
    assert.deepEqual(Object.keys(record.properties ?? {}).sort(), fields);
    assert.deepEqual([...(record.required ?? [])].sort(), fields);
    assert.match(String(record.properties?.jws?.description), /Compact JWS/);
    assert.match(String(record.properties?.seq?.description), /Rollbacks can leave gaps/);
    assert.equal(record.properties?.statement?.description, undefined);

    assert.deepEqual(
      Object.keys(schemaOf(documents.public, cited, "get", "200").properties ?? {}).sort(),
      fields,
    );

    const takingItAway = String(documents.public.paths[log]?.get?.description);
    assert.match(takingItAway, /Verify the compact JWS/);
    assert.match(takingItAway, /does not prove correct agent behavior/);
  });

  it("says what Signatures' three routes answer with, and what each of them is worth", async () => {
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const answers: readonly {
      readonly surface: keyof typeof documents;
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { surface: "agent", path: "/sign", method: "post", statuses: ["200", "400"] },
      { surface: "public", path: "/verify", method: "post", statuses: ["200", "400", "401"] },
      { surface: "public", path: "/jwks.json", method: "get", statuses: ["200", "400"] },
    ];

    for (const { surface, path, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${path} on the ${surface} server`;
      const route = documents[surface].paths[path]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        assert.ok(Object.hasOwn(answered, "content"), `${where} ${status}`);
      }
      assert.deepEqual(route.tags, ["Signatures"], where);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    assert.equal(documents.public.paths["/sign"], undefined);
    assert.equal(documents.agent.paths["/verify"], undefined);
    assert.equal(documents.agent.paths["/jwks.json"], undefined);

    const signing = bodyOf(documents.agent, "/sign", "post");
    assert.deepEqual(Object.keys(signing.properties ?? {}).sort(), ["statement", "typ"]);
    assert.deepEqual(signing.required, ["statement"]);
    assert.match(
      String(signing.properties?.typ?.description),
      /No value is reserved, including concorde-decision\+jws/,
    );
    assert.match(String(documents.agent.paths["/sign"]?.post?.description), /no label is reserved/);
    const verdict = schemaOf(documents.public, "/verify", "post", "200");
    assert.deepEqual(Object.keys(verdict.properties ?? {}).sort(), [
      "header",
      "payload",
      "verified",
    ]);
    assert.deepEqual(verdict.required, ["verified"]);
    assert.match(
      String(verdict.properties?.header?.description),
      /not validation of the payload shape/,
    );
    assert.equal(verdict.properties?.header?.type, undefined);
    assert.equal(verdict.properties?.payload?.type, undefined);

    const check = String(documents.public.paths["/verify"]?.post?.description);
    assert.match(check, /requires trusting the gateway's answer/);
    assert.match(check, /For independent verification/);
    assert.match(check, /Requires authentication through a scheme installed/);
    const unauthenticated = String(
      documents.public.paths["/verify"]?.post?.responses["401"]?.description,
    );
    assert.match(unauthenticated, /Authentication failed/);
    assert.match(unauthenticated, /Missing, invalid, or expired credentials/);
    assert.match(unauthenticated, /return the same response/);
    assert.equal(unauthenticated.includes("of the Users component"), false);

    const route = documents.public.paths["/jwks.json"]?.get;
    assert.ok(route !== undefined, "the key set should be described");
    assert.match(String(route.description), /No authentication is required/);
    assert.match(String(route.description), /verify artifacts independently/);

    const keySet = schemaOf(documents.public, "/jwks.json", "get", "200");
    const key = keySet.properties?.keys?.items;
    assert.ok(key !== undefined, "the key set should describe what a key looks like");
    assert.deepEqual(Object.keys(key.properties ?? {}).sort(), ["crv", "e", "kty", "n", "x", "y"]);
    assert.deepEqual(key.required, ["kty"]);
    for (const [surface, served] of Object.entries(documents)) {
      assert.equal(JSON.stringify(served).includes('"d"'), false, surface);
    }
  });

  it("says what the Scheduler's four routes answer with, and that they are the agent's alone", async () => {
    const documents = {
      agent: await documentOf(described.components.agentServer.fastify),
      public: await documentOf(described.components.publicServer.fastify),
    };
    const byName = "/schedules/{name}";
    const list = "/schedules";

    const answers: readonly {
      readonly path: string;
      readonly method: Method;
      readonly statuses: readonly string[];
    }[] = [
      { path: byName, method: "put", statuses: ["200", "201", "400"] },
      { path: list, method: "get", statuses: ["200", "400"] },
      { path: byName, method: "get", statuses: ["200", "400", "404"] },
      { path: byName, method: "delete", statuses: ["204", "400", "404"] },
    ];

    for (const { path, method, statuses } of answers) {
      const where = `${method.toUpperCase()} ${path}`;
      const route = documents.agent.paths[path]?.[method];
      assert.ok(route !== undefined, `${where} should be described`);
      assert.deepEqual(Object.keys(route.responses).sort(), [...statuses].sort(), where);
      for (const [status, answered] of Object.entries(route.responses)) {
        assert.notEqual(answered.description, "Default Response", `${where} ${status}`);
        assert.equal(Object.hasOwn(answered, "content"), status !== "204", `${where} ${status}`);
      }
      assert.ok(route.tags !== undefined && route.tags.length > 0, `${where} should be tagged`);
      assert.ok(route.summary !== undefined && route.summary.length > 0, where);
      assert.ok(route.description !== undefined && route.description.length > 0, where);
    }

    assert.deepEqual(tagsOf(documents.agent, list, "get"), ["Schedules"]);
    assert.equal(documents.public.paths[list], undefined);
    assert.equal(documents.public.paths[byName], undefined);
    assert.equal(JSON.stringify(documents.public.paths).includes("Schedules"), false);

    const upsert = documents.agent.paths[byName]?.put;
    assert.match(String(upsert?.description), /Creates a schedule or replaces/);
    assert.equal(Object.hasOwn(upsert?.responses ?? {}, "404"), false);

    const record = schemaOf(documents.agent, byName, "get", "200");
    const fields = ["data", "name", "nextFireAt", "spec", "until"];
    assert.deepEqual(Object.keys(record.properties ?? {}).sort(), fields);
    assert.deepEqual([...(record.required ?? [])].sort(), fields);

    assert.equal(record.properties?.data?.type, undefined);

    const page = schemaOf(documents.agent, list, "get", "200");
    assert.deepEqual(Object.keys(page.properties ?? {}), ["schedules"]);
    assert.deepEqual(
      Object.keys(page.properties?.schedules?.items?.properties ?? {}).sort(),
      fields,
    );
  });

  it("serves a browsable page on both, at a path neither can be moved off", async () => {
    for (const server of [described.components.agentServer, described.components.publicServer]) {
      const page = await server.fastify.inject({ method: "GET", url: "/docs" });
      assert.equal(page.statusCode, 200);
      assert.match(String(page.headers["content-type"]), /text\/html/);
    }
  });

  it("puts a route registered after the constructor returned into that server's document", async () => {
    const { agentServer, publicServer } = unstarted().components;

    publicServer.fastify.register(async (fastify) => {
      fastify.get("/ask", async () => ({ ok: true }));
    });

    publicServer.fastify.get("/quietly", async () => ({ ok: true }));

    await agentServer.fastify.ready();
    await publicServer.fastify.ready();
    try {
      const theirs = await documentOf(publicServer.fastify);
      assert.deepEqual(Object.keys(theirs.paths).sort(), [...publicPaths, "/ask"].sort());
      assert.equal((await publicServer.fastify.inject("/quietly")).statusCode, 200);

      assert.deepEqual(
        Object.keys((await documentOf(agentServer.fastify)).paths).sort(),
        agentPaths,
      );
    } finally {
      await agentServer.fastify.close();
      await publicServer.fastify.close();
    }
  });

  it("declares the version the package is at", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    assert.equal(describedVersion, (manifest as { version?: string }).version);
  });

  function unstarted(): Gateway<InfraComponents & Stack> {
    return createGateway({
      databaseUrl: nowhere,
      runtime,
      agentListen: { port: 0 },
      publicListen: { port: 0 },
      extend: (infra) => fullStack(infra),
      handlers: () => ({}),
    });
  }

  async function documentOf(fastify: FastifyInstance): Promise<Description> {
    const answered = await fastify.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(answered.statusCode, 200);
    return answered.json<Description>();
  }

  function tagsOf(document: Description, path: string, method: Method): readonly string[] {
    const tags = document.paths[path]?.[method]?.tags;
    assert.ok(tags !== undefined, `${method} ${path} should be tagged`);
    return tags;
  }

  function schemaOf(document: Description, path: string, method: Method, status: string): Schema {
    const schema =
      document.paths[path]?.[method]?.responses[status]?.content?.["application/json"]?.schema;
    assert.ok(schema !== undefined, `${method} ${path} should describe a ${status} body`);
    return schema;
  }

  function bodyOf(document: Description, path: string, method: Method): Schema {
    const schema =
      document.paths[path]?.[method]?.requestBody?.content?.["application/json"]?.schema;
    assert.ok(schema !== undefined, `${method} ${path} should describe a body`);
    return schema;
  }

  function parametersOf(document: Description, path: string, method: Method): readonly Parameter[] {
    const parameters = document.paths[path]?.[method]?.parameters;
    assert.ok(parameters !== undefined, `${method} ${path} should describe its parameters`);
    return parameters;
  }
});

describe("the package root", () => {
  it("reaches no Agent Implementation and none of the four parts, however far the imports go", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const reached = reachableFrom(path.join(src, "gateway", "index.ts"));

    assert.deepEqual(
      [...reached].filter((module) => module.startsWith(path.join(src, "pi/"))),
      [],
    );

    for (const part of [
      path.join(src, "users", "users.ts"),
      path.join(src, "messenger", "messenger.ts"),
      path.join(src, "http-channel", "http-channel.ts"),
      path.join(src, "signatures", "signatures.ts"),
      path.join(src, "decisions", "decisions.ts"),
    ]) {
      assert.equal(reached.has(part), false, `the root should not reach ${part}`);
    }

    assert.ok(reached.has(path.join(src, "signals", "worker.ts")));
  });
});

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let module = pending.pop(); module !== undefined; module = pending.pop()) {
    if (seen.has(module)) continue;
    seen.add(module);
    const specifiers = readFileSync(module, "utf8").matchAll(
      /(?:from|import)\s*\(?\s*"(\.[^"]+)"/g,
    );
    for (const [, specifier] of specifiers) {
      if (specifier !== undefined) pending.push(path.resolve(path.dirname(module), specifier));
    }
  }
  return seen;
}

async function whatIsStillUp(): Promise<string[]> {
  return [
    await reaching("Users read the Db", async () => {
      const found = await components.users.list({ limit: 1 });
      return `${found.length} User`;
    }),
    await reaching("the Agent server answered", async () =>
      String((await fetch(`${agentUrl}/signals`)).status),
    ),
    await reaching("the Public server took a submission", async () =>
      String((await postMessage("and one more, while you were leaving")).status),
    ),
    await reaching("the Operator's own Component", async () =>
      components.notes.running ? "still running" : "stopped",
    ),
  ];
}

async function reaching(what: string, act: () => Promise<string>): Promise<string> {
  try {
    return `${what}: ${await act()}`;
  } catch (error) {
    return `${what}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function admitted(): Promise<{ id: string; token: string }> {
  const user: UserRecord = await components.db.tx((tx) => components.users.create(tx));
  const issued = await components.db.tx((tx) => components.passwordAuth.issueToken(tx, user.id));
  return { id: user.id, token: issued.token };
}

async function agentJson<T>(path: string): Promise<T> {
  const response = await fetch(`${agentUrl}${path}`);
  const body = await response.text();
  assert.equal(response.status, 200, `${path} should have answered: ${body}`);
  return JSON.parse(body);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decoded(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function postMessage(text: string): Promise<Response> {
  return postJson(`${publicUrl}/messages`, { text }, client.token);
}

function sending(userId: string, text: string): Promise<MessageRecord> {
  return components.db.tx((tx) => components.messenger.send(tx, userId, text));
}

async function ownLog(token: string, window: string): Promise<{ messages: MessageRecord[] }> {
  const response = await bearing(`${publicUrl}/messages${window}`, token);
  const body = await response.text();
  assert.equal(response.status, 200, `GET /messages${window} should have answered: ${body}`);
  return JSON.parse(body);
}

async function ownTexts(token: string, window: string): Promise<string[]> {
  const page = await ownLog(token, window);
  return page.messages.map((message) => message.text);
}

function authenticated(url: string): Promise<Response> {
  return bearing(url, client.token);
}

function bearing(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
}

function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}
