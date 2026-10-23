import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { serverComponent } from "../gateway/components.ts";
import type { Logger } from "../logging/logging.ts";
import type { MessageRecord } from "../messenger/messages.ts";
import { createMessenger, messageReceivedKind } from "../messenger/messenger.ts";
import * as messengerSchema from "../messenger/schema/index.ts";
import { createPasswordAuth, type PasswordAuth } from "../password-auth/password-auth.ts";
import * as passwordAuthSchema from "../password-auth/schema/index.ts";
import type { ScryptParameters } from "../password-auth/secrets.ts";
import type { Signal, SignalHandlers } from "../signals/handlers.ts";
import type { SignalRecord } from "../signals/routes.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { type FakeRuntime, fakeRuntime } from "../test-support/fake-runtime.ts";
import { waitUntil } from "../test-support/wait.ts";
import * as usersSchema from "../users/schema/index.ts";
import { createUsers, type Users } from "../users/users.ts";
import { createHttpChannel } from "./http-channel.ts";

let database: TestDatabase;
let db: Db;

const prefix = "/messages";
const auth = "/auth";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const hour = 60 * 60 * 1000;

const cheap: ScryptParameters = { logN: 12, blockSize: 8, parallelism: 1 };

const password = "correct horse battery staple";

const sweepIntervalMs = 25;

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

type Client = {
  readonly id: string;
  readonly token: string;
};

type Gateway = {
  readonly publicServer: FastifyInstance;
  readonly agentServer: FastifyInstance;
  readonly runtime: FakeRuntime;
  readonly users: Users;
  readonly passwordAuth: PasswordAuth;
};

before(async () => {
  database = await createTestDatabase("http_messages_posted");
  db = database.db;
  await applySchema(db, signalsSchema, usersSchema, passwordAuthSchema, messengerSchema);
});

after(() => database.drop());

async function withGateway(
  handlers: SignalHandlers,
  body: (gateway: Gateway) => Promise<void>,
): Promise<void> {
  const agentServer = serverComponent(Fastify(), nowhere);
  const publicServer = serverComponent(Fastify(), nowhere);
  const runtime = fakeRuntime();
  const worker = createSignalWorker({
    db,
    runtime,
    handlers,
    agentServer,
    logger: silent,
    sweepIntervalMs,
  });
  const users = createUsers({ db, agentServer, publicServer });
  const passwordAuth = createPasswordAuth({
    db,
    users,
    publicServer,
    tokenTtl: hour,
    scrypt: cheap,
  });
  createHttpChannel({
    db,
    messenger: createMessenger({ db, users, worker, agentServer }),
    publicServer,
  });

  await worker.start();
  try {
    await body({
      publicServer: publicServer.fastify,
      agentServer: agentServer.fastify,
      runtime,
      users,
      passwordAuth,
    });
  } finally {
    await worker.stop();
    await agentServer.stop();
    await publicServer.stop();
  }
}

async function admitted(gateway: Gateway): Promise<Client> {
  const { id } = await db.tx(async (tx) => {
    const user = await gateway.users.create(tx);
    await gateway.passwordAuth.setPassword(tx, user.id, password);
    return user;
  });

  const issued = await gateway.publicServer.inject({
    method: "POST",
    url: `${auth}/tokens`,
    payload: { user: id, password },
  });
  assert.equal(issued.statusCode, 201, `logging in should have answered: ${issued.body}`);
  return { id, token: issued.json<{ token: string }>().token };
}

function posting(
  gateway: Gateway,
  authorization: string | undefined,
  payload: Record<string, unknown>,
) {
  return gateway.publicServer.inject({
    method: "POST",
    url: prefix,
    headers: authorization === undefined ? {} : { authorization },
    payload,
  });
}

function bearing(gateway: Gateway, client: Client, payload: Record<string, unknown>) {
  return posting(gateway, `Bearer ${client.token}`, payload);
}

async function posted(
  gateway: Gateway,
  client: Client,
  payload: Record<string, unknown>,
): Promise<MessageRecord> {
  const response = await bearing(gateway, client, payload);
  assert.equal(response.statusCode, 201, `POST ${prefix} should have answered: ${response.body}`);
  return response.json<MessageRecord>();
}

async function own(gateway: Gateway, client: Client): Promise<MessageRecord[]> {
  const response = await gateway.publicServer.inject({
    method: "GET",
    url: prefix,
    headers: { authorization: `Bearer ${client.token}` },
  });
  assert.equal(response.statusCode, 200, `GET ${prefix} should have answered: ${response.body}`);
  return response.json<{ messages: MessageRecord[] }>().messages;
}

async function emitted(gateway: Gateway, client: Client): Promise<SignalRecord[]> {
  const response = await gateway.agentServer.inject({ method: "GET", url: "/signals" });
  assert.equal(response.statusCode, 200, `GET /signals should have answered: ${response.body}`);
  const signals = response.json<{ signals: SignalRecord[] }>().signals;
  return signals.filter((signal) => payloadUser(signal) === client.id);
}

function payloadUser(signal: SignalRecord): string | undefined {
  const payload = signal.payload;
  if (typeof payload !== "object" || payload === null || !("userId" in payload)) return undefined;
  return typeof payload.userId === "string" ? payload.userId : undefined;
}

function recording(seen: Signal<MessageRecord>[], prompts: readonly string[] = []): SignalHandlers {
  return {
    [messageReceivedKind]: {
      handle(signal: Signal<MessageRecord>) {
        seen.push(signal);
        return prompts.map((text) => ({ session: `user_${signal.payload.userId}`, text }));
      },
    },
  };
}

describe("a User posting a Message", () => {
  it("wakes a Handler with the whole record, and the Run happens", async () => {
    const seen: Signal<MessageRecord>[] = [];
    await withGateway(recording(seen, ["what happened to the deploy?"]), async (gateway) => {
      const client = await admitted(gateway);
      const message = await posted(gateway, client, {
        text: "what happened to the deploy?",
      });

      assert.match(message.id, /^[0-9a-f-]{36}$/);
      assert.equal(message.userId, client.id);
      assert.equal(message.direction, "inbound");
      assert.equal(message.seq, 1);
      assert.equal(message.text, "what happened to the deploy?");
      assert.equal(new Date(message.createdAt).toISOString(), message.createdAt);

      assert.deepEqual(await own(gateway, client), [message]);

      await waitUntil("the Handler for message.received has run", async () => seen.length === 1);
      const signal = seen[0];
      assert.ok(signal !== undefined);
      assert.equal(signal.kind, messageReceivedKind);
      assert.deepEqual(signal.payload, message);

      await waitUntil("the Run has finished", async () => gateway.runtime.texts().length === 1);
      assert.deepEqual(gateway.runtime.texts(), ["what happened to the deploy?"]);
      assert.equal(gateway.runtime.recorded[0]?.session, `user_${client.id}`);
      assert.equal(gateway.runtime.overlapped, false);

      await waitUntil("the Signal has finished", async () => {
        const [only] = await emitted(gateway, client);
        return only?.state === "done";
      });
      const [only] = await emitted(gateway, client);
      assert.equal(only?.error, null);
      assert.deepEqual(only?.payload, message);
    });
  });

  it("attributes it to the User the Token named, whatever the client wrote", async () => {
    const seen: Signal<MessageRecord>[] = [];
    await withGateway(recording(seen), async (gateway) => {
      const client = await admitted(gateway);
      const other = await admitted(gateway);

      const message = await posted(gateway, client, {
        text: "it was me, honestly",
        userId: other.id,
        user: other.id,
        direction: "outbound",
        seq: 99,
        id: "3c1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21",
        createdAt: new Date(0).toISOString(),
      });

      assert.equal(message.userId, client.id);
      assert.equal(message.direction, "inbound");
      assert.equal(message.seq, 1);
      assert.notEqual(message.id, "3c1b4d54-1c3a-4f2e-9d7b-8e6a5c4b3a21");
      assert.ok(Date.parse(message.createdAt) > 0);

      await waitUntil("the Handler for message.received has run", async () => seen.length === 1);
      assert.equal(seen[0]?.payload.userId, client.id);
      assert.deepEqual(seen[0]?.payload, message);

      assert.deepEqual(await own(gateway, other), []);
      assert.deepEqual(await own(gateway, client), [message]);
    });
  });

  it("numbers posts arriving at once distinctly and without gaps, and wakes for each", async () => {
    const seen: Signal<MessageRecord>[] = [];
    await withGateway(recording(seen), async (gateway) => {
      const client = await admitted(gateway);

      const at = ["one", "two", "three", "four", "five"];
      const posts = await Promise.all(
        at.map((which) => posted(gateway, client, { text: `all at once: ${which}` })),
      );

      assert.deepEqual(
        posts.map((message) => message.seq).sort((a, b) => a - b),
        [1, 2, 3, 4, 5],
      );
      const stored = await own(gateway, client);
      assert.deepEqual(
        stored.map((message) => message.seq),
        [1, 2, 3, 4, 5],
      );
      assert.deepEqual(
        stored.map((message) => message.text).sort(),
        at.map((which) => `all at once: ${which}`).sort(),
      );

      await waitUntil("every post has reached the Handler", async () => seen.length === 5);
      assert.deepEqual(
        seen.map((signal) => signal.payload.seq).sort((a, b) => a - b),
        [1, 2, 3, 4, 5],
      );
    });
  });

  it("refuses a body with nothing in it to say, and stores nothing", async () => {
    await withGateway({}, async (gateway) => {
      const client = await admitted(gateway);

      for (const body of [{ text: "" }, {}, { text: ["one", "two"] }, { text: null }]) {
        assert.equal((await bearing(gateway, client, body)).statusCode, 400, JSON.stringify(body));
      }

      const queried = await gateway.publicServer.inject({
        method: "POST",
        url: `${prefix}?user=${client.id}`,
        headers: { authorization: `Bearer ${client.token}` },
        payload: { text: "hello" },
      });
      assert.equal(queried.statusCode, 400, queried.body);
      assert.match(queried.json<{ message: string }>().message, /read by cursor/);

      assert.deepEqual(await own(gateway, client), []);
      assert.deepEqual(await emitted(gateway, client), []);
    });
  });

  it("is the single 401 of Users when nobody is behind it", async () => {
    await withGateway({}, async (gateway) => {
      const client = await admitted(gateway);
      const said = { text: "let me in" };

      const refusals = [
        await posting(gateway, undefined, said),
        await posting(
          gateway,
          `Basic ${Buffer.from(`${client.id}:${password}`).toString("base64")}`,
          said,
        ),
        await posting(gateway, client.token, said),
        await posting(gateway, `Bearer concorde_${"A".repeat(43)}`, said),
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

      assert.equal((await posting(gateway, undefined, { text: "" })).statusCode, 400);

      assert.deepEqual(await own(gateway, client), []);
      assert.deepEqual(await emitted(gateway, client), []);
      assert.deepEqual(gateway.runtime.texts(), []);
    });
  });

  it("stores the Message and fails the Signal when no Handler is registered", async () => {
    await withGateway({}, async (gateway) => {
      const client = await admitted(gateway);
      const message = await posted(gateway, client, { text: "is anybody there?" });

      await waitUntil("the Signal has failed", async () => {
        const [only] = await emitted(gateway, client);
        return only?.state === "failed";
      });
      const [only] = await emitted(gateway, client);
      assert.equal(only?.kind, messageReceivedKind);
      assert.match(
        only?.error ?? "",
        /no Signal Handler is registered for kind "message\.received"/,
      );

      assert.deepEqual(await own(gateway, client), [message]);
      assert.deepEqual(gateway.runtime.texts(), []);
    });
  });
});
