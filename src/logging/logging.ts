import { pino } from "pino";

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
};

export function defaultLogger(): Logger {
  return pino();
}
