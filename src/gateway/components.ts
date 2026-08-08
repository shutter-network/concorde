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
 * hand over an instance it made itself. It defaults exactly one thing, and it is the Logger the
 * refusal details go to.
 *
 * The authentication aggregate is built here for every server rather than only for the one an
 * Operator exposes. A server type that carried it and a server type that did not would put the two
 * halves of "how a person authenticates here" on different objects, since an Auth's own login
 * route is registered on the same instance it registers itself with. What it costs is a member on
 * the Agent server that nobody should reach for, and that cost is documented where an Operator
 * meets it rather than prevented.
 */

import type { FastifyInstance, FastifyListenOptions, preHandlerAsyncHookHandler } from "fastify";
import { defaultLogger, type Logger } from "../logging/logging.ts";
import { type Auth, createAuthAggregate } from "./auth.ts";

/**
 * One part of a Gateway: it starts, and it stops.
 *
 * A part with nothing to start and nothing to release supplies two methods that do nothing, which
 * is ordinary rather than an apology: the record is the Gateway's directory of its own parts, and a
 * part that holds no resource still belongs in it.
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

export type ServerComponentOptions = {
  /**
   * Where a refused request's `detail` is written. Defaults to a `pino` instance on stdout.
   *
   * One `warn` line per refusal that carried one, naming the scheme and the code beside it.
   * Nothing else is written here, so a server no Auth registered with logs nothing through it.
   */
  readonly logger?: Logger;
};

/**
 * A server in a Gateway's record: the instance, its place in the start order, and the
 * authentication every protected route on it goes through.
 */
export type ServerComponent<S extends ListeningServer = FastifyInstance> = Component & {
  /** The instance that was passed in, unwrapped, so routes of your own go on the same server. */
  readonly fastify: S;

  /**
   * Adds an {@link Auth} to the schemes this server accepts, at the end of that Auth's own
   * constructor.
   *
   * Registration order is the order {@link ServerComponent.requireUser} asks them in, and it is the
   * order the schemes are named in a 401. Nothing is refused: a second Auth of one scheme is two
   * challenges in the header and two chances to authenticate a request.
   */
  registerAuth(auth: Auth): void;

  /**
   * The preHandler a protected route on this server takes, as one route option.
   *
   * `publicServer.requireUser` on a route asks every registered Auth in turn. The first that
   * authenticates the request has its User assigned to `request.safUser`; the first that refuses
   * one ends it there, and so does a request no Auth recognised. Every refusal is the same 401 with
   * the same body, and carries a `WWW-Authenticate` header naming every scheme this server accepts.
   *
   * It reads the registered Auths per request, so a route registered before the Auth that
   * authenticates it works. A hook and not a plugin, so it goes on a route of your own at any depth
   * and under any prefix. Nothing is protected by default, and a route that omits it reads
   * `request.safUser` as `undefined` despite the type.
   *
   * @throws `NoAuthRegisteredError` if no Auth has registered with this server. A wiring mistake is
   *   a 500 rather than a 401 that every User would read as their own credential failing.
   */
  readonly requireUser: preHandlerAsyncHookHandler;
};

/**
 * Wraps a server as a Component: `start` binds it, and `stop` closes it.
 *
 * It constructs nothing, so call `Fastify()` with whatever options you want and state where the
 * instance binds. There is no default address. What comes back carries that instance on `.fastify`
 * with its own type parameters intact, `withTypeProvider` and http2 included, so routes of your own
 * go on the same server the framework's components registered theirs on.
 *
 * It also carries the authentication every protected route on that server goes through. No scheme
 * is accepted until an Auth registers itself here.
 */
export function serverComponent<S extends ListeningServer>(
  server: S,
  listen: FastifyListenOptions,
  options: ServerComponentOptions = {},
): ServerComponent<S> {
  return {
    fastify: server,
    ...createAuthAggregate(options.logger ?? defaultLogger()),
    async start(): Promise<void> {
      await server.listen(listen);
    },
    async stop(): Promise<void> {
      await server.close();
    },
  };
}
