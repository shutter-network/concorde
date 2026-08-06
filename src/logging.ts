/**
 * The logging seam: a structural interface, and a `pino` default.
 *
 * Any object with the four methods satisfies `Logger`, so a deployment that logs through
 * something else passes that instead. The parameters are in `pino`'s order, fields first,
 * because `pino` is the default and must satisfy the interface unwrapped.
 */

import { pino } from "pino";

/** Structured context on one log line. */
export type LogFields = Record<string, unknown>;

/**
 * What every part of the Gateway accepts. Four levels and no more.
 *
 * `fatal` and `trace` exist in `pino`, and nothing here has a use for them. Leaving them out
 * keeps a hand-written logger short.
 */
export type Logger = {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
};

/**
 * The logger a part uses when the Operator supplies none: JSON lines on stdout at `info`.
 *
 * @returns A `pino` instance, typed as `Logger`, so `pino`'s own types stay out of the
 *   public API.
 *
 * @example
 * ```ts
 * import { defaultLogger, type Logger } from "shared-agent-framework";
 *
 * const log: Logger = defaultLogger();
 * log.info({ signalId: "abc" }, "Signal claimed");
 * ```
 */
export function defaultLogger(): Logger {
  return pino();
}
