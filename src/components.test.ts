/**
 * The ordering contract, and nothing else.
 *
 * Every Component here is a mock: an object that appends to a shared call log and
 * optionally throws. No database, no Fastify and no real part, because none of them
 * would make a claim this file makes any truer — what is under test is the order the
 * calls come in, which Component is stopped after a start fails, and which errors
 * come back out.
 *
 * That a real Fastify instance satisfies `ListeningServer` is a type claim rather
 * than a runtime one, so `serverComponent` is exercised against a fake here and the
 * structural fit is proven by the suites that pass real instances in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyListenOptions } from "fastify";
import { type Component, components, type ListeningServer, serverComponent } from "./components.ts";

type Behaviour = {
  /**
   * How long each call waits before it records itself.
   *
   * Descending across a list is what separates "awaited each in turn" from "started
   * them all and waited": run in parallel, a list whose delays descend records itself
   * backwards.
   */
  readonly delayMs?: number;
  readonly failStart?: Error;
  readonly failStop?: Error;
};

/**
 * A Component that does nothing but say so. It records the attempt *before* it
 * throws, so a log tells you what was called rather than only what succeeded.
 */
function mock(log: string[], name: string, behaviour: Behaviour = {}): Component {
  return {
    name,
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

describe("a list of Components", () => {
  it("starts in list order and stops in the reverse, awaiting each", async () => {
    const log: string[] = [];
    const gateway = components([
      mock(log, "db", { delayMs: 6 }),
      mock(log, "agent server", { delayMs: 3 }),
      mock(log, "worker"),
    ]);

    await gateway.start();
    assert.deepEqual(log, ["db.start", "agent server.start", "worker.start"]);

    await gateway.stop();
    assert.deepEqual(log, [
      "db.start",
      "agent server.start",
      "worker.start",
      "worker.stop",
      "agent server.stop",
      "db.stop",
    ]);
  });

  it("stops exactly what had started, in reverse, when a start throws", async () => {
    const log: string[] = [];
    const failed = new Error("the worker could not reach the queue");
    const gateway = components([
      mock(log, "db"),
      mock(log, "agent server"),
      mock(log, "worker", { failStart: failed }),
      mock(log, "public server"),
    ]);

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
      "agent server.start",
      "worker.start",
      "agent server.stop",
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
    const gateway = components([
      mock(log, "db", { failStop: alsoFailed }),
      mock(log, "agent server"),
      mock(log, "worker", { failStart: failed }),
    ]);

    await assert.rejects(
      () => gateway.start(),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        // The start error first: it is the one that says why the Gateway is not up.
        assert.deepEqual(error.errors, [failed, alsoFailed]);
        assert.match(error.message, /worker/);
        return true;
      },
    );

    // A failing stop does not abandon the rest of the unwind either.
    assert.deepEqual(log, [
      "db.start",
      "agent server.start",
      "worker.start",
      "agent server.stop",
      "db.stop",
    ]);
  });

  it("stops every Component even when one throws, and aggregates the errors", async () => {
    const log: string[] = [];
    const first = new Error("the public server would not close");
    const second = new Error("the pool would not drain");
    const gateway = components([
      mock(log, "db", { failStop: second }),
      mock(log, "worker"),
      mock(log, "public server", { failStop: first }),
    ]);

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
    assert.deepEqual(log.slice(3), ["public server.stop", "worker.stop", "db.stop"]);

    // A stop is popped whether or not it threw, so the second call is quiet rather
    // than throwing the same aggregate again.
    await gateway.stop();
    assert.equal(log.length, 6);
  });

  it("does nothing the second time it is stopped", async () => {
    const log: string[] = [];
    const gateway = components([mock(log, "db"), mock(log, "worker")]);

    await gateway.start();
    await gateway.stop();
    assert.deepEqual(log, ["db.start", "worker.start", "worker.stop", "db.stop"]);

    // What a second Ctrl-C does. No flag says so: the started list is empty.
    await gateway.stop();
    assert.deepEqual(log, ["db.start", "worker.start", "worker.stop", "db.stop"]);
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

    const component = serverComponent("public server", server, listen);
    assert.equal(component.name, "public server");
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
    assert.equal(serverComponent("agent server", server, { port: 7411 }).fastify, server);
  });
});
