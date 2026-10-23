import type { FastifyInstance, FastifyListenOptions, preHandlerAsyncHookHandler } from "fastify";
import { defaultLogger, type Logger } from "../logging/logging.ts";
import { type Auth, createAuthAggregate } from "./auth.ts";

export type Component = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type Gateway<C extends Record<string, Component>> = Component & {
  readonly components: C;
};

/**
 * Starts components in `Object.entries` order and stops them in reverse order.
 * Use nonnumeric string keys to preserve insertion order; symbol keys are ignored.
 *
 * If startup fails, stops the components whose startup completed. Shutdown attempts every stop
 * and reports failures in an `AggregateError`. Repeated shutdown calls have no effect.
 */
export function createBareGateway<C extends Record<string, Component>>(components: C): Gateway<C> {
  const started: Component[] = [];

  async function unwind(): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (let component = started.pop(); component !== undefined; component = started.pop()) {
      try {
        await component.stop();
      } catch (error) {
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
  readonly logger?: Logger;
};

export type ServerComponent<S extends ListeningServer = FastifyInstance> = Component & {
  readonly fastify: S;

  /** Auths are tried in registration order. Duplicate schemes are allowed. */
  registerAuth(auth: Auth): void;

  /**
   * Attach this hook to each protected route. Sets `request.concordeUser` on success.
   * An auth refusal ends authentication immediately; an absent credential tries the next auth.
   *
   * Throws `NoAuthRegisteredError` when no auth is registered. Routes without this hook
   * have no authenticated user, despite the request property's static type.
   */
  readonly requireUser: preHandlerAsyncHookHandler;
};

/** Uses the supplied server instance. Starts listening on `start()` and closes it on `stop()`. */
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
