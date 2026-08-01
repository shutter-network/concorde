/**
 * The logging seam.
 *
 * `Logger` is **structural**: any object with these four methods satisfies it, so
 * an Operator whose system logs through something else passes that instead
 * without either of us depending on `pino`'s types. The framework's own default
 * is a `pino` instance, which is why the parameters are in `pino`'s order —
 * fields first, message second. That order is not an aesthetic choice: reversing
 * it would mean `pino` no longer satisfies the interface it is the default for,
 * and every part would have to wrap it.
 */

import { pino } from "pino";

/** Structured context on one log line. */
export type LogFields = Record<string, unknown>;

/**
 * What every part of the Gateway accepts. Four levels and no more: `fatal` and
 * `trace` exist in `pino` but nothing here has a use for them, and adding them
 * would make a hand-written logger harder to supply for no gain.
 */
export type Logger = {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
};

/**
 * The logger a part uses when the Operator supplies none: JSON lines on stdout
 * at `info`.
 *
 * The return type is annotated `Logger` rather than inferred, so `pino`'s own
 * types stay out of the emitted declarations and out of the public API.
 */
export function defaultLogger(): Logger {
  return pino();
}
