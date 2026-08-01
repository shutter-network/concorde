/**
 * The Gateway's two HTTP servers.
 *
 * Two of them, so that what the world can reach and what the agent can reach are
 * different surfaces **by construction** rather than by a check somewhere. Neither
 * knows the other exists: no shared configuration, no shared Fastify instance, and
 * nothing here reads one server's options to fill in the other's.
 *
 * Both are thin wrappers, and deliberately so. `server.fastify` is the Fastify
 * instance itself, because Fastify's plugin system *is* the framework's route
 * extension mechanism — there is no plugin contract of ours to satisfy (ADR-0021).
 * The cost is accepted and worth stating: a Fastify major version is a breaking
 * change for every deployment. What these wrappers add over calling Fastify
 * directly is the pair of names, the bind-address defaults that differ between them
 * for a reason, and — on the Agent server — the reachable-from address, which
 * nothing can derive.
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { defaultLogger, type Logger } from "./logging.ts";

/**
 * Where the Agent server binds when the Operator says nothing.
 *
 * The Agent server is **unauthenticated** — a credential is no boundary against the
 * agent, which is the only party meant to reach it, so reaching the port is access
 * (ADR-0010). Loopback is therefore the default so that exposing it takes a
 * deliberate change, and the risk that makes it matter is specific: publishing a
 * container port inserts rules that bypass the host's own firewall, and the
 * consequence of an accidental exposure is the whole Store readable and writable.
 */
const loopback = "127.0.0.1";

/**
 * Where the Public server binds when the Operator says nothing.
 *
 * The opposite default to the Agent server's, which is the asymmetry the two servers
 * exist for: this is the one surface meant to be exposed, and a Public server bound
 * to loopback inside a container is reachable by nothing at all — a deployment that
 * looks healthy and serves no User. An Operator putting it behind a reverse proxy on
 * the same host passes `host: "127.0.0.1"`.
 */
const everyInterface = "0.0.0.0";

/**
 * Whether an address the server actually bound is one only this machine can reach.
 *
 * Asked of the bound address rather than the configured `host`, because the two are
 * not the same string: `localhost` resolves at bind time, and `0.0.0.0` and `::`
 * both mean every interface without saying so.
 */
function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.");
}

export type PublicServerOptions = {
  /** The port to listen on. `0` takes whatever the operating system gives. */
  readonly port: number;
  /** The address to bind. Defaults to `0.0.0.0`: this is the exposed surface. */
  readonly host?: string;
  /** Defaults to a `pino` instance on stdout. Used for this server's own lines. */
  readonly logger?: Logger;
  /**
   * Passed to Fastify itself — `bodyLimit`, `trustProxy`, Fastify's own request
   * logging, whatever a deployment needs.
   *
   * The escape hatch exists because the alternative to a passthrough is wrapping
   * Fastify option by option, which costs exactly the ecosystem that was the reason
   * to choose it (ADR-0021). Note that `fastifyOptions.logger` is Fastify's own
   * logger for requests, and `logger` above is the framework's structural one; they
   * are different seams and setting one says nothing about the other.
   */
  readonly fastifyOptions?: FastifyServerOptions;
};

export type AgentServerOptions = {
  /** The port to listen on. `0` takes whatever the operating system gives. */
  readonly port: number;
  /**
   * The address to bind. Defaults to `127.0.0.1`, and changing it exposes an
   * unauthenticated read-write surface over the whole Store (ADR-0010).
   */
  readonly host?: string;
  /**
   * How this server is reachable **from inside the agent's container**, as an
   * absolute `http`/`https` base URL — `http://host.docker.internal:7411` under
   * Docker Desktop, `http://gateway:7411` on a shared compose network, the bridge
   * address under a plain Linux daemon.
   *
   * Stated rather than derived, and a separate value from the bind address on
   * purpose: those three deployments differ, none of them is discoverable from the
   * socket, and the port may differ too when a published port is mapped. Refused at
   * construction if it is not an absolute URL, so a bad deploy is obvious
   * immediately instead of arriving as a failed Run mid-flight (ADR-0017).
   */
  readonly reachableAt: string;
  /** Defaults to a `pino` instance on stdout. Used for this server's own lines. */
  readonly logger?: Logger;
  /** Passed to Fastify itself. See `PublicServerOptions.fastifyOptions`. */
  readonly fastifyOptions?: FastifyServerOptions;
};

/**
 * The HTTP server exposed outside the Gateway.
 *
 * In this slice it carries **no framework routes at all**, because Users reach the
 * Messenger through it and the Messenger is out of scope. That is its shape rather
 * than an omission: it is where an Operator's own plugins go, and where the
 * Messenger's routes will go when it arrives.
 */
export type PublicServer = {
  /**
   * The Fastify instance. Mount routes with `fastify.register(plugin, { prefix })`,
   * which is Fastify's mechanism and the only one there is (ADR-0021).
   */
  readonly fastify: FastifyInstance;
  /**
   * Starts listening and resolves to the address it bound, as `http://host:port`.
   *
   * The address is composed from the socket rather than taken from Fastify's own
   * return value, which substitutes a loopback address for `0.0.0.0` for display and
   * so cannot be used to tell the two apart.
   */
  listen(): Promise<string>;
  /** Stops listening. Shutdown ordering is the Operator's (ADR-0021). */
  close(): Promise<void>;
};

/**
 * The HTTP server only the Agent Runtime reaches: the Core's Signal and Run routes,
 * plus whatever else a deployment exposes to the agent.
 *
 * A mediation point and not a security boundary against the agent. It is
 * unauthenticated, and the read surface it carries is deliberately unscoped
 * (ADR-0010, ADR-0011).
 */
export type AgentServer = {
  /** The Fastify instance. `fastify.register(core.agentRoutes)` puts the Core on it. */
  readonly fastify: FastifyInstance;
  /**
   * The base URL the agent uses, with no trailing slash — so `${reachableAt}/signals`
   * is what a `curl` in the agent's container composes. Whatever the Operator
   * stated, and not where the server bound.
   */
  readonly reachableAt: string;
  /** Starts listening and resolves to the address it bound, as `http://host:port`. */
  listen(): Promise<string>;
  /** Stops listening. Shutdown ordering is the Operator's (ADR-0021). */
  close(): Promise<void>;
};

export function createPublicServer(options: PublicServerOptions): PublicServer {
  const log = options.logger ?? defaultLogger();
  const fastify = Fastify({ ...options.fastifyOptions });
  const host = options.host ?? everyInterface;

  return {
    fastify,
    async listen() {
      const { address } = await listenOn(fastify, options.port, host);
      log.info({ address }, "the Public server is listening");
      return address;
    },
    close() {
      return fastify.close();
    },
  };
}

export function createAgentServer(options: AgentServerOptions): AgentServer {
  const log = options.logger ?? defaultLogger();
  const fastify = Fastify({ ...options.fastifyOptions });
  const host = options.host ?? loopback;
  const reachableAt = normalizeReachableAt(options.reachableAt);

  return {
    fastify,
    reachableAt,
    async listen() {
      const { address, bound } = await listenOn(fastify, options.port, host);
      // Both values on one line, because a mount or network problem is diagnosed by
      // comparing them and they are the two an Operator cannot see anywhere else.
      log.info({ address, reachableAt }, "the Agent server is listening");
      if (!isLoopback(bound)) {
        // Said out loud every time, not once in a document. The Agent server has no
        // authentication by design, so this line is the only warning between a bind
        // address someone changed and the whole Store readable and writable by
        // whoever finds the port (ADR-0010).
        log.warn(
          { address },
          "the Agent server is bound beyond loopback and has no authentication: anything that reaches this port can read and write the Store (ADR-0010)",
        );
      }
      return address;
    },
    close() {
      return fastify.close();
    },
  };
}

/**
 * Listens, and reports the address that was actually bound.
 *
 * Fastify's own `listen` resolves `0.0.0.0` to a loopback address in the string it
 * returns, which is friendlier to paste into a browser and useless for telling an
 * exposed server from a confined one — the one distinction the Agent server rests on
 * (ADR-0010). So the socket is asked instead.
 *
 * Shared by both servers because it is about Fastify rather than about either of
 * them: no configuration crosses between the two, and neither reads the other's.
 */
async function listenOn(
  fastify: FastifyInstance,
  port: number,
  host: string,
): Promise<{ readonly address: string; readonly bound: string }> {
  await fastify.listen({ port, host });
  const listening = fastify.server.address();
  if (listening === null || typeof listening === "string") {
    // Neither happens for a TCP listen that has resolved: a string means a pipe or a
    // socket path, and null means nothing is listening. Reported rather than
    // asserted away, because the alternative is a plausible-looking address built
    // out of the request instead of the socket.
    throw new Error(
      `the server listened on ${host}:${port} but reports no TCP address, so there is nothing to tell an agent`,
    );
  }
  const bound = listening.address;
  // Brackets are how an IPv6 address goes in a URL, and `::1` is what `localhost`
  // resolves to on a host with IPv6.
  const inUrl = listening.family === "IPv6" ? `[${bound}]` : bound;
  return { address: `http://${inUrl}:${listening.port}`, bound };
}

/**
 * Checks the reachable-from address and drops any trailing slash.
 *
 * Rejected here rather than accepted and worked around later: it is a value nothing
 * can validate against reality — only the agent's container knows whether it
 * resolves — so the most that can be done is to insist it is a URL an agent could
 * put in front of a path, and to say what the plausible answers look like when it is
 * not.
 */
function normalizeReachableAt(reachableAt: string): string {
  let parsed: URL;
  try {
    parsed = new URL(reachableAt);
  } catch {
    throw new Error(reachableAtProblem(reachableAt, "it is not an absolute URL"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(reachableAtProblem(reachableAt, `${parsed.protocol} is not http or https`));
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      reachableAtProblem(reachableAt, "a base URL carries no query string and no fragment"),
    );
  }
  return reachableAt.replace(/\/+$/, "");
}

function reachableAtProblem(reachableAt: string, problem: string): string {
  return `reachableAt ${JSON.stringify(reachableAt)} is not usable as a base URL: ${problem}. It is how the Agent server is reachable from inside the agent's container, which nothing can derive — http://host.docker.internal:7411 under Docker Desktop, http://<compose service>:7411 on a shared network, the bridge address under a plain Linux daemon.`;
}
