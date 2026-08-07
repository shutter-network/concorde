/**
 * The Signal Worker owns the Signal queue, Signal Handler dispatch and Run execution. A Signal is
 * something that arrived and may make the agent act, emitted by a Producer, which is anything
 * inside the Gateway trusted to write one. A Run is one execution of the agent over one Prompt. The
 * Worker claims Signals in the order they arrived and runs one Run at a time, whatever Session that
 * Run is in.
 *
 * Most deployments meet this subpath as a vocabulary rather than as a constructor.
 * {@link SignalHandler} is what an Operator writes, and it is the framework's primary extension
 * point in the way an endpoint handler is a web framework's: it takes a {@link Signal} and answers
 * with {@link Prompt}s, and {@link SignalHandlers} is the map from a `kind` to one of them.
 * {@link Runtime} is the other seam, the single method an Agent Implementation is driven through.
 * {@link createSignalWorker} builds the Worker itself, and {@link SignalWorker} is what comes back.
 * Its programmatic API is `emit`, which a Producer writes a Signal through.
 *
 * `createGateway` builds a Worker already, so reach for the constructor only when you assemble a
 * Gateway by hand. Either way the Handler map is a construction option, so a Handler that emits back
 * into the same Worker is built after the Worker and assigned in.
 *
 * None of this is on the package root. The Worker, its options and the whole Handler vocabulary are
 * reachable through `shared-agent-framework/signals` and nowhere else. The two tables are here too,
 * for the schema an Operator generates their migrations from. They reference no other component's
 * table, so that schema can carry them alone.
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
 *   // Runs once the Run above has finished, however it finished.
 *   post: (signal, outcome) => {
 *     if (outcome.failed) console.error(`nobody greeted ${signal.id}`);
 *   },
 * };
 *
 * // A Producer emits inside its own transaction, so the row and the wakeup commit together.
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
