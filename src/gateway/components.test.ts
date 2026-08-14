/**
 * The ordering contract, and nothing else.
 *
 * Every Component here is a mock: an object that appends to a shared call log and
 * optionally throws. No database, no Fastify and no real part, because none of them
 * would make a claim this file makes any truer — what is under test is the order the
 * calls come in, which Component is stopped after a start fails, and which errors
 * come back out.
 *
 * The log entries are written from the key each mock is put under, because the key is
 * the only name a Component has: a mock is handed the word it is filed as, so a test
 * that read back the wrong order would say so in the Operator's own vocabulary.
 *
 * That a real Fastify instance satisfies `ListeningServer` is a type claim rather
 * than a runtime one, so `serverComponent` is exercised against a fake here and the
 * structural fit is proven by the suites that pass real instances in.
 */

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
  /**
   * How long each call waits before it records itself.
   *
   * Descending across a record is what separates "awaited each in turn" from "started
   * them all and waited": run in parallel, a record whose delays descend records itself
   * backwards.
   */
  readonly delayMs?: number;
  readonly failStart?: Error;
  readonly failStop?: Error;
};

/**
 * A Component that does nothing but say so. It records the attempt *before* it
 * throws, so a log tells you what was called rather than only what succeeded.
 *
 * `name` is the key it is about to be filed under, passed in by hand: nothing on a
 * Component carries one, and this is a test writing a legible log.
 */
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

    // The same objects, under the same keys: the record is the Gateway's directory of
    // its own parts, so a part is reached by the word the Operator filed it under.
    assert.equal(gateway.components.db, db);

    // And two methods, which is exactly a Component's shape — nothing nests one today,
    // and nothing declares that it may not.
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

    // The error the part threw, as itself: an Operator is told which part failed and
    // why rather than being handed a wrapper.
    await assert.rejects(
      () => gateway.start(),
      (error: unknown) => error === failed,
    );

    // The worker itself is not stopped — it never finished starting — and the public
    // server is never reached at all.
    assert.deepEqual(log, [
      "db.start",
      "agentServer.start",
      "worker.start",
      "agentServer.stop",
      "db.stop",
    ]);

    // And nothing is left recorded as started, so the Operator's own stop finds
    // nothing to do.
    await gateway.stop();
    assert.equal(log.length, 5);
  });

  it("surfaces both errors when a start throws and the unwind throws too", async () => {
    const log: string[] = [];
    const failed = new Error("the worker could not reach the queue");
    const alsoFailed = new Error("the pool would not drain");
    // Keyed with the Operator's own word for the part rather than the part's word for
    // itself, which is the whole of what replaced `name`: this Worker is filed under
    // `queue`, and that is what the message below has to say.
    const gateway = createBareGateway({
      db: mock(log, "db", { failStop: alsoFailed }),
      agentServer: mock(log, "agentServer"),
      queue: mock(log, "signal worker", { failStart: failed }),
    });

    await assert.rejects(
      () => gateway.start(),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        // The start error first: it is the one that says why the Gateway is not up.
        assert.deepEqual(error.errors, [failed, alsoFailed]);
        assert.match(error.message, /^queue failed to start/);
        // And nothing of the part's own vocabulary, which nothing here has: an
        // Operator reading this message is looking at their own record.
        assert.doesNotMatch(error.message, /signal worker/);
        return true;
      },
    );

    // A failing stop does not abandon the rest of the unwind either.
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
        // In the order they were thrown, which is the order things were stopped.
        assert.deepEqual(error.errors, [first, second]);
        return true;
      },
    );

    // The worker in the middle stopped, and so did the Db behind the thrower.
    assert.deepEqual(log.slice(3), ["publicServer.stop", "worker.stop", "db.stop"]);

    // A stop is popped whether or not it threw, so the second call is quiet rather
    // than throwing the same aggregate again.
    await gateway.stop();
    assert.equal(log.length, 6);
  });

  it("does nothing the second time it is stopped", async () => {
    const log: string[] = [];
    const gateway = createBareGateway({ db: mock(log, "db"), worker: mock(log, "worker") });

    await gateway.start();
    await gateway.stop();
    assert.deepEqual(log, ["db.start", "worker.start", "worker.stop", "db.stop"]);

    // What a second Ctrl-C does. No flag says so: the started list is empty.
    await gateway.stop();
    assert.deepEqual(log, ["db.start", "worker.start", "worker.stop", "db.stop"]);
  });

  it("starts an integer-like key first, whatever the Operator wrote", async () => {
    const log: string[] = [];
    // Recorded rather than guarded against. JavaScript orders `"2"` before
    // every ordinary key in any object, so this Gateway starts the wrong part first and
    // nothing anywhere says so — which is the cost of not refusing it statically.
    const gateway = createBareGateway({
      db: mock(log, "db"),
      "2": mock(log, "2"),
      "2fa": mock(log, "2fa"),
    });

    await gateway.start();
    assert.deepEqual(log, ["2.start", "db.start", "2fa.start"]);
  });
});

/** A `ListeningServer` that is nothing but its two methods, which is all one is. */
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
    // Construction does nothing: the address is held until `start`, because
    // Fastify takes none at construction and `listen` is the call `start` makes.
    assert.deepEqual(log, []);

    await component.start();
    assert.deepEqual(log, ["listen"]);
    // The options themselves, unread and undefaulted — no bind address of ours is
    // behind this one.
    assert.equal(server.listenedWith.length, 1);
    assert.equal(server.listenedWith[0], listen);

    await component.stop();
    assert.deepEqual(log, ["listen", "close"]);
  });

  it("exposes the instance it was handed, unchanged", async () => {
    const server = fakeServer([]);
    // The same object, not a wrapper around it: the Operator constructed it and
    // goes on registering their own routes on it.
    assert.equal(serverComponent(server, { port: 7411 }).fastify, server);
  });
});
