/**
 * The one interface the framework defines, and the only thing it knows about the
 * parts a Gateway is assembled from.
 *
 * A **Component** is a `name`, a `start` and a `stop`
 * ([ADR-0031](../docs/adr/0031-parts-that-run-are-components.md)). There is no
 * registry, nothing declares a dependency, and nothing here can say what depends on
 * what: `components(list)` receives objects that already hold each other, because
 * dependencies are ordinary constructor options and the wiring is where the Signal
 * Handlers are built. What it adds is an order and what happens when one of them
 * fails, which is the whole of what a lifecycle interface buys and the thing every
 * deployment was otherwise hand-writing.
 *
 * This is not the plugin contract [ADR-0021](../docs/adr/0021-the-framework-has-no-plugin-system.md)
 * rejected, and the reason is the size: enumerating what an Operator wants to vary
 * produced seams with nothing in common, and a type covering all of them degenerates
 * to "a thing with an optional everything". Two methods and a name have nothing to
 * degenerate into. Only parts that run are Components — the Db, the Signal Worker and
 * the two servers — and most parts are not.
 */

import type { FastifyListenOptions } from "fastify";

/**
 * A part of the Gateway with something to run and something to release.
 *
 * **Both methods are required.** A part with no work at either end has no position in
 * an order, so putting one in the list is ceremony implying its placement matters
 * when it does not, and an optional method is the first field of the contract
 * ADR-0021 rejected. The rule is a sentence rather than a type: if you have
 * background work or a resource to release, you are a Component.
 */
export type Component = {
  /**
   * What this part is called, for a person reading an error.
   *
   * Nothing looks a Component up by it, nothing requires it to be unique, and the one
   * place it is read is the error raised when this part's `start` throws while the
   * unwind behind it throws too.
   */
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Start these in the order given, and stop them in the reverse of it.
 *
 * The list is the Operator's: the framework cannot know that the Agent server must
 * outlive the Signal Worker because the agent calls it mid-Run, so it is written out
 * and nothing checks it.
 *
 * `start` awaits each in turn and records a Component as started only once its
 * `start` has resolved, so a failure leaves everything running or nothing running and
 * never a pool held open by a Gateway that could not boot. `stop` is best-effort and
 * idempotent: every Component is stopped even if one throws, and a second call finds
 * nothing to do, which is what a second Ctrl-C does.
 *
 * The returned object is deliberately **not** itself a Component. Nesting has no use
 * here, and it would force a `name` that nothing reads. `start` called twice is not
 * guarded either: it would start a second Signal Worker and break serial execution
 * ([ADR-0012](../docs/adr/0012-the-gateway-is-a-serial-signal-worker.md)), but it is
 * the Operator calling `start` twice in a file of their own.
 */
export function components(list: readonly Component[]): {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  /**
   * What is running, oldest first. Popping it is what makes `stop` idempotent, and
   * it is also what the unwind of a failed `start` walks — there is one teardown here
   * and no flag beside it.
   */
  const started: Component[] = [];

  /** Stop everything recorded, newest first, collecting what each stop threw. */
  async function unwind(): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (let component = started.pop(); component !== undefined; component = started.pop()) {
      try {
        await component.stop();
      } catch (error) {
        // Collected rather than rethrown: one bad teardown stranding the rest is the
        // worst available behaviour, and a shutdown problem should be diagnosable in
        // one pass rather than one restart at a time.
        failures.push(error);
      }
    }
    return failures;
  }

  return {
    async start(): Promise<void> {
      for (const component of list) {
        try {
          await component.start();
        } catch (error) {
          const failures = await unwind();
          // The part's own error, as itself, when there is nothing else to say: an
          // Operator is told which part failed and why rather than being handed a
          // wrapper. A wrapper only appears when the unwind failed too, because then
          // there is more than one thing that went wrong.
          if (failures.length === 0) throw error;
          throw new AggregateError(
            [error, ...failures],
            `${component.name} failed to start, and stopping what had started failed too`,
          );
        }
        started.push(component);
      }
    },

    async stop(): Promise<void> {
      const failures = await unwind();
      if (failures.length > 0) {
        throw new AggregateError(failures, "the Gateway did not stop cleanly");
      }
    },
  };
}

/**
 * The whole of what the framework asks of a server: somewhere to listen, and a way
 * to close.
 *
 * Structural on purpose. A real Fastify instance satisfies it, and satisfying it is
 * all that is asked, which is what keeps `fastify` a peer dependency this package
 * imports no runtime value from.
 */
export type ListeningServer = {
  listen(options: FastifyListenOptions): Promise<unknown>;
  close(): Promise<unknown>;
};

/**
 * A server's place in the start order.
 *
 * This constructs nothing and defaults nothing, which is what separates it from the
 * two server constructors this framework deleted. The Operator calls `Fastify()`
 * with their own options and holds the instance; only `listen` and `close` come
 * through us, and the instance is on `.fastify` so their own routes go on the same
 * server ours do. There is no framework logger beside Fastify's, no callback URL,
 * nothing inspecting the bound socket, and **no bind default** — the address is
 * stated here or it is Fastify's own.
 *
 * It is generic in the instance type because `FastifyInstance` is generic in five
 * parameters: a server built with `withTypeProvider`, http2 or a custom logger is
 * not assignable to the bare one, so the type is passed through and `.fastify` is
 * exactly what `Fastify()` returned.
 *
 * The address lives on the Component rather than on the instance because that is
 * Fastify's own split: `Fastify()` takes no port, `listen` resolves to the bound
 * address, and `listen` is the call `start` has to make.
 */
export function serverComponent<S extends ListeningServer>(
  name: string,
  server: S,
  listen: FastifyListenOptions,
): Component & { readonly fastify: S } {
  return {
    name,
    fastify: server,
    async start(): Promise<void> {
      await server.listen(listen);
    },
    async stop(): Promise<void> {
      await server.close();
    },
  };
}
