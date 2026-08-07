/**
 * Where a part of a Gateway says what it is doing: one small interface, and the default that
 * satisfies it.
 *
 * {@link Logger} is what every part takes, and {@link LogFields} is what a line carries beside its
 * message. {@link defaultLogger} builds the one a part logs through when the Operator passes
 * nothing.
 *
 * A logger is per part and never global. Each constructor takes its own, so one logger everywhere
 * means handing one object to each of them, and a part left with the default writes to stdout while
 * the rest write wherever you sent them. `createGateway`'s `logger` option is the Signal Worker's
 * alone.
 *
 * This subpath has no Component and no route, it does not use the Db, and it exports no schema.
 *
 * @example
 * A logger of the deployment's own, given to two parts that each take theirs separately.
 * ```ts
 * import { createGateway } from "shared-agent-framework/gateway";
 * import type { LogFields, Logger } from "shared-agent-framework/logging";
 * import { createPiRuntime } from "shared-agent-framework/pi";
 * import { createScheduler } from "shared-agent-framework/scheduler";
 *
 * // Four methods, and nothing to inherit from or register with.
 * const toConsole: Logger = {
 *   debug: () => {},
 *   info: (fields: LogFields, message: string) => console.log(message, fields),
 *   warn: (fields: LogFields, message: string) => console.warn(message, fields),
 *   error: (fields: LogFields, message: string) => console.error(message, fields),
 * };
 *
 * const gateway = createGateway({
 *   databaseUrl: process.env.DATABASE_URL ?? "",
 *   runtime: createPiRuntime({ image: "my-agent:1" }),
 *   // Not loopback: the agent reaches this server from a container of its own.
 *   agentListen: { host: "0.0.0.0", port: 8081 },
 *   publicListen: { host: "0.0.0.0", port: 8080 },
 *   // The Signal Worker's, and nothing else's.
 *   logger: toConsole,
 *   extend: ({ db, worker, agentServer }) => ({
 *     // Stated again here, because a component built by hand takes its own.
 *     scheduler: createScheduler({ db, worker, agentServer, logger: toConsole }),
 *   }),
 *   handlers: () => ({}),
 * });
 *
 * await gateway.start();
 * ```
 *
 * @module
 */

export type { LogFields, Logger } from "./logging.ts";
export { defaultLogger } from "./logging.ts";
