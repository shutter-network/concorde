/**
 * The one interface the framework defines, and the record a Gateway is made of.
 *
 * A **Component** is a `start` and a `stop`, and a **Gateway** is a record of them
 * keyed by the Operator's own words
 * ([ADR-0037](../docs/adr/0037-the-gateway-is-a-record-of-components.md)). There is no
 * registry, nothing declares a dependency, and nothing here can say what depends on
 * what: `createBareGateway` receives objects that already hold each other, because
 * dependencies are ordinary constructor options and the wiring is where the Signal
 * Handlers are built. What it adds is an order and what happens when one of them
 * fails, which is the whole of what a lifecycle interface buys and the thing every
 * deployment was otherwise hand-writing.
 *
 * This is not the plugin contract [ADR-0021](../docs/adr/0021-the-framework-has-no-plugin-system.md)
 * rejected, and the reason is the size: enumerating what an Operator wants to vary
 * produced seams with nothing in common, and a type covering all of them degenerates
 * to "a thing with an optional everything". Two methods have nothing to degenerate
 * into.
 */

import type { FastifyListenOptions } from "fastify";

/**
 * A part of a Gateway, and one entry of its record.
 *
 * **Both methods are required**, and the reason is structural typing rather than
 * ceremony: a `Component` whose methods were both optional would be the empty type,
 * satisfied by every value in the program — a `MigrationDescriptor`, an options bag, a
 * string. The record is order-bearing, so a wrong entry in it is silent by
 * construction and the type has to be tight enough that an accident cannot happen. A
 * part with nothing to run and nothing to release says so with two methods that do
 * nothing (ADR-0037).
 *
 * There is no `name`. The key a Component is under is the Operator's own word for it,
 * unique by construction, and is what an error names; a `name` beside it would be a
 * second answer to the same question and the two would disagree.
 */
export type Component = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Every Component a deployment has, under the Operator's own names, with the two
 * methods that run them.
 *
 * A Gateway **is** a Component, because it has exactly a Component's shape and
 * declaring that it is not would be an assertion nothing needs. Nothing nests one
 * today and nothing has to.
 */
export type Gateway<C extends Record<string, Component>> = Component & {
  /** The record it was given, unchanged, so a part can be reached by its own key. */
  readonly components: C;
};

/**
 * Start these in key order, and stop them in the reverse of it.
 *
 * The order is the Operator's: the framework cannot know that the Agent server must
 * outlive the Signal Worker because the agent calls it mid-Run, so it is written out
 * and nothing checks it.
 *
 * `start` awaits each in turn and records a Component as started only once its
 * `start` has resolved, so a failure leaves everything running or nothing running and
 * never a pool held open by a Gateway that could not boot. `stop` is best-effort and
 * idempotent: every Component is stopped even if one throws, and a second call finds
 * nothing to do, which is what a second Ctrl-C does.
 *
 * **An integer-like key jumps the queue, and nothing checks that either.** JavaScript
 * orders `"2"` before `"db"` in any object, so a Component keyed `"2"` silently starts
 * first; `"2fa"` is fine. A static refusal was considered and dropped for costing a
 * baffling error message to prevent a thing nobody does (ADR-0037). A **symbol** key
 * is the same cost recorded once more: a string index signature says nothing about
 * symbols, so one type-checks, and `Object.entries` never sees it — that part is
 * neither started nor stopped, and nothing says so.
 *
 * `start` called twice is not guarded: it would start a second Signal Worker and break
 * serial execution
 * ([ADR-0012](../docs/adr/0012-the-gateway-is-a-serial-signal-worker.md)), but it is
 * the Operator calling `start` twice in a file of their own.
 */
export function createBareGateway<C extends Record<string, Component>>(components: C): Gateway<C> {
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
    components,

    async start(): Promise<void> {
      for (const [key, component] of Object.entries(components)) {
        try {
          await component.start();
        } catch (error) {
          const failures = await unwind();
          // The part's own error, as itself, when there is nothing else to say: an
          // Operator is told which part failed and why rather than being handed a
          // wrapper. A wrapper only appears when the unwind failed too, because then
          // there is more than one thing that went wrong — and what it names is the
          // key, which is the word the Operator wrote and the one they are reading.
          if (failures.length === 0) throw error;
          throw new AggregateError(
            [error, ...failures],
            `${key} failed to start, and stopping what had started failed too`,
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
  server: S,
  listen: FastifyListenOptions,
): Component & { readonly fastify: S } {
  return {
    fastify: server,
    async start(): Promise<void> {
      await server.listen(listen);
    },
    async stop(): Promise<void> {
      await server.close();
    },
  };
}
