/**
 * The parameters are in `pino`'s order, fields first and message second, because `pino` is the
 * default and has to satisfy the interface unwrapped. Reversing them to read better would cost a
 * wrapper around the default and make every call site in the framework a translation.
 */

import { pino } from "pino";

export type LogFields = Record<string, unknown>;

/**
 * What every part of a Gateway logs through. Four levels, and any object carrying them satisfies
 * it, so a deployment that logs elsewhere passes its own object instead of adapting one.
 *
 * `fatal` and `trace` are `pino`'s and are left out. Nothing here has a use for either, and their
 * absence is what keeps a hand-written logger four methods long.
 */
export type Logger = {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
};

/**
 * What a part logs through when the Operator supplies nothing: `pino`, writing JSON lines to stdout
 * at `info`.
 *
 * Typed as {@link Logger} and not as a `pino` logger, so nothing in a deployment's own code ends up
 * holding `pino`'s types. Everything below `info` is dropped, and `debug` is where the parts write
 * what they are doing, so a deployment that wants those lines configures `pino` itself and passes
 * the result.
 */
export function defaultLogger(): Logger {
  return pino();
}
