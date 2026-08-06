/**
 * The Component contract, and the record a Gateway is made of.
 *
 * A Component starts and stops. A Gateway is a record of Components under the Operator's
 * own keys. Nothing declares a dependency here. A Component receives what it needs as ordinary
 * constructor options. The record adds only an order.
 */

import type { FastifyListenOptions } from "fastify";

/**
 * One part of a Gateway. It starts, and it stops.
 *
 * Both methods are necessary. If a part has nothing to start and nothing to release, give
 * two methods that do nothing.
 *
 * A Component has no name. Its key in the Gateway record is its name.
 */
export type Component = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Every Component a deployment has, under the Operator's own keys.
 *
 * A Gateway is itself a Component, because it has a Component's shape.
 */
export type Gateway<C extends Record<string, Component>> = Component & {
  /** The record it was given, unchanged, so a part can be reached by its own key. */
  readonly components: C;
};

/**
 * Assembles a Gateway from a record of Components. Start order is key order.
 *
 * `start` starts each Component in turn. If one throws, it stops what had already started
 * and rethrows, so a failed boot leaves nothing running. `stop` stops every Component in
 * reverse, even if one throws, and a second call finds nothing to do.
 *
 * Two things are not guarded. An integer-like key such as `"2"` sorts ahead of every word
 * in any JavaScript object, so it starts first. A symbol key is never started at all,
 * because `Object.entries` does not see one.
 *
 * @param components The parts to run, in the order they must start.
 *
 * @example
 * ```ts
 * import { createBareGateway, openDb, serverComponent } from "shared-agent-framework";
 * import Fastify from "fastify";
 *
 * const db = openDb(process.env.DATABASE_URL ?? "");
 * const gateway = createBareGateway({
 *   db,
 *   publicServer: serverComponent(Fastify(), { host: "0.0.0.0", port: 8080 }),
 * });
 *
 * await gateway.start();
 * ```
 */
export function createBareGateway<C extends Record<string, Component>>(components: C): Gateway<C> {
  /** What is running, oldest first. Popping it is what makes `stop` idempotent. */
  const started: Component[] = [];

  /** Stop everything recorded, newest first, collecting what each stop threw. */
  async function unwind(): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (let component = started.pop(); component !== undefined; component = started.pop()) {
      try {
        await component.stop();
      } catch (error) {
        // Collected rather than rethrown, so one bad teardown cannot strand the rest. A
        // shutdown problem is then diagnosable in one pass.
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
          // The part's own error, as itself, when there is nothing else to say. A wrapper
          // appears only when the unwind failed too, and it names the Operator's own key.
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
 * The whole of what the framework asks of a server: somewhere to listen, and a way to close.
 *
 * A Fastify instance satisfies it. That is all that is asked. It is what keeps `fastify` a
 * peer dependency with no runtime value imported.
 */
export type ListeningServer = {
  listen(options: FastifyListenOptions): Promise<unknown>;
  close(): Promise<unknown>;
};

/**
 * Gives a server a place in the Gateway's start order.
 *
 * It constructs nothing and defaults nothing. Call `Fastify()` with your own options, pass
 * the instance here, and state where it listens. The instance comes back on `.fastify`, so
 * your own routes go on the same server the framework's do.
 *
 * @param server Anything with `listen` and `close`. A Fastify instance of any type
 *   parameters, including `withTypeProvider` and http2.
 * @param listen Where to bind. There is no default address.
 *
 * @example
 * ```ts
 * import { serverComponent } from "shared-agent-framework";
 * import Fastify from "fastify";
 *
 * const publicServer = serverComponent(Fastify({ trustProxy: true }), {
 *   host: "0.0.0.0",
 *   port: 8080,
 * });
 *
 * publicServer.fastify.register(async (instance) => {
 *   instance.get("/health", async () => ({ ok: true }));
 * });
 * ```
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
