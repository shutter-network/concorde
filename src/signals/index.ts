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
 * {@link templateHandler} is a Handler most deployments start from rather than writing
 * {@link SignalHandler} by hand: it renders one Prompt per Signal from a Handlebars template, and
 * {@link TemplateHandlerOptions} is where the template source, the Session and the values it
 * substitutes are stated. It is an ordinary Handler built by an ordinary function, so a deployment
 * that outgrows it returns one of its own from the same place and unwires nothing.
 *
 * `createGateway` builds a Worker already, so reach for the constructor only when you assemble a
 * Gateway by hand. Either way the Handler map is a construction option, so a Handler that emits
 * back into the same Worker is built after the Worker and assigned in.
 *
 * The two tables are here beside the constructor, for the schema an Operator generates their
 * migrations from. They reference no other component's table, so that schema can carry them alone.
 *
 * @example
 * A Signal Handler, and a Producer that emits into it.
 * ```ts
 * import type { Db } from "shared-agent-framework/db";
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
// The tables are on `shared-agent-framework/signals/schema` and on nothing else. These two unions
// and the arrays they are derived from are the exception and are on both: a check constraint is
// compiled from the arrays, which is why they live in `schema.ts`, and `SignalRecord.state` and
// `RunRecord.state` are declared with the unions and are on the wire, so a reader of either record
// has to be able to name them (ADR-0055).
export type { RunState, SignalState } from "./schema.ts";
export { runStates, signalStates } from "./schema.ts";
export type { TemplateHandlerOptions } from "./template-handler.ts";
export { templateHandler } from "./template-handler.ts";
export type { EmittedSignal, SignalWorker, SignalWorkerOptions } from "./worker.ts";
export { createSignalWorker } from "./worker.ts";
