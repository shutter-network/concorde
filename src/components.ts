/**
 * The record is order-bearing and a wrong entry in it is silent, so the type has to be tight enough
 * that an accident cannot happen. That is why both of `Component`'s methods stay required: with
 * `name` gone (ADR-0037) a type whose two methods were optional would be the empty type, satisfied
 * by every value in the program, an options bag and a string included.
 *
 * `unwind` collects what each `stop` threw rather than rethrowing the first. One bad teardown
 * cannot then strand the rest, and a shutdown problem is diagnosable in one pass.
 *
 * `serverComponent` constructs no server and defaults no address, which is the whole reason it is a
 * wrapper and not a constructor: a deployment needing Fastify options of its own has to be able to
 * hand over an instance it made itself.
 */

import type { FastifyListenOptions } from "fastify";

/**
 * One part of a Gateway: it starts, and it stops.
 *
 * Both methods are required. A part with nothing to start and nothing to release supplies two that
 * do nothing, which is ordinary rather than an apology: the record is the Gateway's directory of
 * its own parts, and membership gives a part a position before it needs one.
 *
 * A Component has no name of its own. Its key in the Gateway's record is its name, and that key is
 * what a failed start is reported under.
 */
export type Component = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Every Component a deployment runs, under the Operator's own keys.
 *
 * It has a Component's shape and therefore is one, so `start` and `stop` on the whole deployment
 * are the same two calls as on any part of it.
 */
export type Gateway<C extends Record<string, Component>> = Component & {
  /** The record as it was given, so a part is reached by the key you wrote it under. */
  readonly components: C;
};

/**
 * Assembles a Gateway from a record of Components. Start order is key order, and stop order is the
 * reverse of it.
 *
 * A Component counts as started only once its own `start` resolves. If one throws, everything
 * already started is stopped and the error is rethrown, so a failed boot leaves nothing running.
 * `stop` stops every Component even when one of them throws, gathers the failures into an
 * `AggregateError`, and finds nothing left to do on a second call.
 *
 * Two properties of a JavaScript record are not guarded against. An integer-like key such as `"2"`
 * sorts ahead of every word, so a Component under one starts first. A symbol key is never started
 * at all.
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

export type ListeningServer = {
  listen(options: FastifyListenOptions): Promise<unknown>;
  close(): Promise<unknown>;
};

/**
 * Gives a server a place in a Gateway's start order: `start` binds it, and `stop` closes it.
 *
 * It constructs nothing and defaults nothing, so call `Fastify()` with whatever options you want
 * and state where the instance binds. There is no default address. What comes back carries that
 * instance on `.fastify` with its own type parameters intact, `withTypeProvider` and http2
 * included, so routes of your own go on the same server the framework's components registered
 * theirs on.
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
