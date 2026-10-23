import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyListenOptions } from "fastify";
import {
  type Component,
  createBareGateway,
  type ListeningServer,
  serverComponent,
} from "./components.ts";

type Behaviour = {
  readonly delayMs?: number;
  readonly failStart?: Error;
  readonly failStop?: Error;
};

function mock(log: string[], name: string, behaviour: Behaviour = {}): Component {
  return {
    async start() {
      await sleep(behaviour.delayMs ?? 0);
      log.push(`${name}.start`);
      if (behaviour.failStart !== undefined) throw behaviour.failStart;
    },
    async stop() {
      await sleep(behaviour.delayMs ?? 0);
      log.push(`${name}.stop`);
      if (behaviour.failStop !== undefined) throw behaviour.failStop;
    },
  };
}

describe("a record of Components", () => {
  it("starts in key order and stops in the reverse, awaiting each", async () => {
    const log: string[] = [];
    const gateway = createBareGateway({
      db: mock(log, "db", { delayMs: 6 }),
      agentServer: mock(log, "agentServer", { delayMs: 3 }),
      worker: mock(log, "worker"),
    });

    await gateway.start();
    assert.deepEqual(log, ["db.start", "agentServer.start", "worker.start"]);

    await gateway.stop();
    assert.deepEqual(log, [
      "db.start",
      "agentServer.start",
      "worker.start",
      "worker.stop",
      "agentServer.stop",
      "db.stop",
    ]);
  });

  it("is a Component itself, and hands back the record it was given", async () => {
    const log: string[] = [];
    const db = mock(log, "db");
    const gateway = createBareGateway({ db });

    assert.equal(gateway.components.db, db);

    const nested: Component = gateway;
    await nested.start();
    await nested.stop();
    assert.deepEqual(log, ["db.start", "db.stop"]);
  });

  it("stops exactly what had started, in reverse, when a start throws", async () => {
    const log: string[] = [];
    const failed = new Error("the worker could not reach the queue");
    const gateway = createBareGateway({
      db: mock(log, "db"),
      agentServer: mock(log, "agentServer"),
      worker: mock(log, "worker", { failStart: failed }),
      publicServer: mock(log, "publicServer"),
    });

    await assert.rejects(
      () => gateway.start(),
      (error: unknown) => error === failed,
    );

    assert.deepEqual(log, [
      "db.start",
      "agentServer.start",
      "worker.start",
      "agentServer.stop",
      "db.stop",
    ]);

    await gateway.stop();
    assert.equal(log.length, 5);
  });

  it("surfaces both errors when a start throws and the unwind throws too", async () => {
    const log: string[] = [];
    const failed = new Error("the worker could not reach the queue");
    const alsoFailed = new Error("the pool would not drain");
    const gateway = createBareGateway({
      db: mock(log, "db", { failStop: alsoFailed }),
      agentServer: mock(log, "agentServer"),
      queue: mock(log, "signal worker", { failStart: failed }),
    });

    await assert.rejects(
      () => gateway.start(),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [failed, alsoFailed]);
        assert.match(error.message, /^Component queue failed to start/);
        assert.doesNotMatch(error.message, /signal worker/);
        return true;
      },
    );

    assert.deepEqual(log, [
      "db.start",
      "agentServer.start",
      "signal worker.start",
      "agentServer.stop",
      "db.stop",
    ]);
  });

  it("stops every Component even when one throws, and aggregates the errors", async () => {
    const log: string[] = [];
    const first = new Error("the public server would not close");
    const second = new Error("the pool would not drain");
    const gateway = createBareGateway({
      db: mock(log, "db", { failStop: second }),
      worker: mock(log, "worker"),
      publicServer: mock(log, "publicServer", { failStop: first }),
    });

    await gateway.start();
    await assert.rejects(
      () => gateway.stop(),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [first, second]);
        return true;
      },
    );

    assert.deepEqual(log.slice(3), ["publicServer.stop", "worker.stop", "db.stop"]);

    await gateway.stop();
    assert.equal(log.length, 6);
  });

  it("does nothing the second time it is stopped", async () => {
    const log: string[] = [];
    const gateway = createBareGateway({ db: mock(log, "db"), worker: mock(log, "worker") });

    await gateway.start();
    await gateway.stop();
    assert.deepEqual(log, ["db.start", "worker.start", "worker.stop", "db.stop"]);

    await gateway.stop();
    assert.deepEqual(log, ["db.start", "worker.start", "worker.stop", "db.stop"]);
  });

  it("starts an integer-like key first, whatever the Operator wrote", async () => {
    const log: string[] = [];
    const gateway = createBareGateway({
      db: mock(log, "db"),
      "2": mock(log, "2"),
      "2fa": mock(log, "2fa"),
    });

    await gateway.start();
    assert.deepEqual(log, ["2.start", "db.start", "2fa.start"]);
  });
});

function fakeServer(log: string[]): ListeningServer & { readonly listenedWith: unknown[] } {
  const listenedWith: unknown[] = [];
  return {
    listenedWith,
    async listen(options: FastifyListenOptions) {
      listenedWith.push(options);
      log.push("listen");
      return "http://127.0.0.1:8080";
    },
    async close() {
      log.push("close");
    },
  };
}

describe("a server as a Component", () => {
  it("listens with the options it was given and closes on stop", async () => {
    const log: string[] = [];
    const server = fakeServer(log);
    const listen: FastifyListenOptions = { port: 8080, host: "0.0.0.0" };

    const component = serverComponent(server, listen);
    assert.deepEqual(log, []);

    await component.start();
    assert.deepEqual(log, ["listen"]);
    assert.equal(server.listenedWith.length, 1);
    assert.equal(server.listenedWith[0], listen);

    await component.stop();
    assert.deepEqual(log, ["listen", "close"]);
  });

  it("exposes the instance it was handed, unchanged", async () => {
    const server = fakeServer([]);
    assert.equal(serverComponent(server, { port: 7411 }).fastify, server);
  });
});
