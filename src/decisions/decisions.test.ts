import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.ts";
import { type ServerComponent, serverComponent } from "../gateway/components.ts";
import type { SignalRecord } from "../signals/routes.ts";
import * as signalsSchema from "../signals/schema/index.ts";
import { createSignalWorker } from "../signals/worker.ts";
import { createSignatures } from "../signatures/index.ts";
import { applySchema } from "../test-support/apply-schema.ts";
import { createTestDatabase, type TestDatabase } from "../test-support/database.ts";
import { fakeRuntime } from "../test-support/fake-runtime.ts";
import { createDecisions, type DecisionRecord } from "./decisions.ts";
import * as decisionsSchema from "./schema/index.ts";

let database: TestDatabase;
let db: Db;
let agentServer: ServerComponent<FastifyInstance>;
let publicServer: ServerComponent<FastifyInstance>;

const prefix = "/decisions";

const nowhere = { port: 0, host: "127.0.0.1" } as const;

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

before(async () => {
  database = await createTestDatabase("decisions_agent");
  db = database.db;

  agentServer = serverComponent(Fastify(), nowhere);
  publicServer = serverComponent(Fastify(), nowhere);

  createSignalWorker({ db, runtime: fakeRuntime(), handlers: {}, agentServer });
  const { privateKey } = generateKeyPairSync("ed25519");
  const signatures = createSignatures({
    signingKey: privateKey,
    agentServer,
    publicServer,
    logger: silent,
  });
  createDecisions({ db, signatures, agentServer, publicServer });

  await applySchema(db, signalsSchema, decisionsSchema);
});

after(async () => {
  await agentServer.stop();
  await publicServer.stop();
  await database.drop();
});

describe("publishing a Decision", () => {
  it("answers the record it stored, artifact included, with no read-back to do", async () => {
    const published = await publish("the first thing we committed to");

    assert.deepEqual(published, {
      seq: published.seq,
      statement: "the first thing we committed to",
      jws: published.jws,
      createdAt: published.createdAt,
    } satisfies DecisionRecord);
    assert.equal(typeof published.seq, "number");
    assert.ok(published.jws.length > 0, "the artifact is the Decision and cannot be absent");
    assert.equal(new Date(published.createdAt).toISOString(), published.createdAt);
  });

  it("numbers the log globally, with nothing to scope the sequence to", async () => {
    const first = await publish("one");
    const second = await publish("two");

    assert.equal(second.seq, first.seq + 1);
  });

  it("signs the number and the timestamp it stored, and not some other pair", async () => {
    const published = await publish("the statement whose payload is read back");

    assert.deepEqual(payloadOf(published.jws), {
      seq: published.seq,
      createdAt: published.createdAt,
      statement: published.statement,
    });
  });

  it("refuses a statement that says nothing", async () => {
    assert.equal((await publishing({ statement: "" })).statusCode, 400);
    assert.equal((await publishing({})).statusCode, 400);
  });

  it("ignores an artifact a caller wrote into the body, and signs its own", async () => {
    const published = await publish("mine, whatever else I sent with it", {
      jws: "not.a.signature",
    });

    assert.notEqual(published.jws, "not.a.signature");
    assert.deepEqual(payloadOf(published.jws), {
      seq: published.seq,
      createdAt: published.createdAt,
      statement: published.statement,
    });
  });

  it("wakes nothing at all, which is why the agent cannot queue work for itself", async () => {
    await publish("this one notifies nobody");

    const queue = await agentJson<{ signals: SignalRecord[] }>("/signals");
    assert.deepEqual(queue.signals, []);
  });
});

describe("the agent reading the log", () => {
  it("answers the whole log ascending, which is what a fresh Session reads", async () => {
    const before = await read("?after=0&limit=200");
    const published = await publish("and something after everything else");
    const whole = await read("?after=0&limit=200");

    assert.deepEqual(
      whole.map((decision) => decision.seq),
      [...before.map((decision) => decision.seq), published.seq],
    );
    assert.deepEqual(whole.at(-1), published);
  });

  it("pages by cursor, all three cases the same way up", async () => {
    const first = await publish("page one of the walk");
    const second = await publish("page two of the walk");
    const third = await publish("page three of the walk");

    assert.deepEqual(await seqs("?limit=2"), [second.seq, third.seq]);
    assert.deepEqual(await seqs(`?before=${third.seq}&limit=2`), [first.seq, second.seq]);
    assert.deepEqual(await seqs(`?after=${first.seq}&limit=2`), [second.seq, third.seq]);
  });

  it("refuses two windows in one request, and a parameter it does not have", async () => {
    const both = await agentServer.fastify.inject({ url: `${prefix}?after=1&before=4` });
    assert.equal(both.statusCode, 400, both.body);
    assert.match(both.json<{ message: string }>().message, /two different windows/);

    const scoped = await agentServer.fastify.inject({ url: `${prefix}?user=someone` });
    assert.equal(scoped.statusCode, 400, scoped.body);
    assert.match(scoped.json<{ message: string }>().message, /"user" is not a parameter/);
  });
});

describe("the agent citing a Decision by number", () => {
  it("answers exactly the one cited, and it is what the cursored read answers", async () => {
    const published = await publish("the one that gets quoted back by its number");

    const cited = await agentJson<DecisionRecord>(`${prefix}/${published.seq}`);
    assert.deepEqual(cited, published);

    assert.deepEqual(await read(`?after=${published.seq - 1}&limit=1`), [cited]);
  });

  it("cites the first Decision in the log, where the cursor underneath it is 0", async () => {
    const [first] = await read("?after=0&limit=1");
    assert.ok(first !== undefined, "this file has published something by now");

    assert.deepEqual(await agentJson<DecisionRecord>(`${prefix}/${first.seq}`), first);
  });

  it("answers a number nobody has with a 404 saying which number", async () => {
    const beyond = (await publish("the newest thing in the log")).seq + 1000;
    const missing = await agentServer.fastify.inject({ url: `${prefix}/${beyond}` });

    assert.equal(missing.statusCode, 404, missing.body);
    assert.deepEqual(missing.json(), {
      statusCode: 404,
      error: "Not Found",
      message: `no Decision ${beyond} exists`,
    });
  });

  it("answers a number that is not one with a 400, which the caller earned", async () => {
    for (const cited of ["seven", "1.5", "0", "-1", "%20", "2147483648", "9999999999"]) {
      const refused = await agentServer.fastify.inject({ url: `${prefix}/${cited}` });
      assert.equal(refused.statusCode, 400, `${cited}: ${refused.body}`);
    }
  });

  it("refuses a window on a route that answers one record", async () => {
    const published = await publish("the one somebody asked for a page of");
    const windowed = await agentServer.fastify.inject({
      url: `${prefix}/${published.seq}?limit=1`,
    });

    assert.equal(windowed.statusCode, 400, windowed.body);
    assert.match(windowed.json<{ message: string }>().message, /"limit" is not a parameter/);
  });
});

async function publish(
  statement: string,
  alsoSent: Record<string, unknown> = {},
): Promise<DecisionRecord> {
  const answered = await publishing({ statement, ...alsoSent });
  assert.equal(answered.statusCode, 201, `publishing should have answered: ${answered.body}`);
  return answered.json<DecisionRecord>();
}

function publishing(payload: Record<string, unknown>) {
  return agentServer.fastify.inject({ method: "POST", url: prefix, payload });
}

async function read(window: string): Promise<DecisionRecord[]> {
  return (await agentJson<{ decisions: DecisionRecord[] }>(`${prefix}${window}`)).decisions;
}

async function seqs(window: string): Promise<number[]> {
  return (await read(window)).map((decision) => decision.seq);
}

async function agentJson<T>(url: string): Promise<T> {
  const answered = await agentServer.fastify.inject({ url });
  assert.equal(answered.statusCode, 200, `${url} should have answered: ${answered.body}`);
  return answered.json<T>();
}

function payloadOf(jws: string): unknown {
  const [, payload] = jws.split(".");
  return JSON.parse(Buffer.from(String(payload), "base64url").toString("utf8"));
}
