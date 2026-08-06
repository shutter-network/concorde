/**
 * The Signal Worker, from `shared-agent-framework/signals`.
 *
 * The Worker is the queue, the Signal Handler dispatch and the Run execution. It runs one
 * Run at a time, whatever Session that Run is in. `createGateway` builds one for you, so
 * reach for `createSignalWorker` only when you assemble a Gateway by hand.
 *
 * This subpath also carries the vocabulary a Signal Handler is written in: `Signal`,
 * `SignalHandler`, `Prompt` and `Runtime`. Its two tables are here as well, for the schema
 * an Operator generates.
 *
 * @example
 * A Signal Handler, and a Producer that emits into it.
 * ```ts
 * import type { Db } from "shared-agent-framework";
 * import type { Signal, SignalHandler, SignalWorker } from "shared-agent-framework/signals";
 *
 * const greet: SignalHandler<{ name: string }> = {
 *   handle: (signal: Signal<{ name: string }>) => [
 *     { session: `user_${signal.payload.name}`, text: `Say hello to ${signal.payload.name}.` },
 *   ],
 * };
 *
 * // A Producer emits in its own transaction, so the row and the wakeup commit together.
 * async function greetSomebody(db: Db, worker: SignalWorker, name: string): Promise<string> {
 *   return db.tx((tx) => worker.emit(tx, { kind: "greet", payload: { name } }));
 * }
 * ```
 *
 * @module
 */

export type {
  PostOutcome,
  Prompt,
  Signal,
  SignalHandler,
  SignalHandlers,
} from "./handlers.ts";
export type { RunRecord, SignalRecord } from "./routes.ts";
export type { RunOutcome, RunPrompt, Runtime } from "./runtime.ts";
// A star and not a list, so every table stays a top-level name an Operator's `drizzle-kit`
// can see. It never looks inside a wrapper object. `SignalRecord.state` and `RunRecord.state`
// take their two unions from here, and both are on the wire.
export * from "./schema.ts";
export type { EmittedSignal, SignalWorker, SignalWorkerOptions } from "./worker.ts";
export { createSignalWorker } from "./worker.ts";
