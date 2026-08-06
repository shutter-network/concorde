export type {
  PostOutcome,
  Prompt,
  Signal,
  SignalHandler,
  SignalHandlers,
} from "./handlers.ts";
export type { RunRecord, SignalRecord } from "./routes.ts";
export type { RunOutcome, RunPrompt, Runtime } from "./runtime.ts";
// The tables, on this subpath and no other, a component being one door
// ([ADR-0047](../../docs/adr/0047-a-component-is-one-subpath.md)). A star rather than a
// list, because what an Operator's `drizzle-kit` collects is top-level names and it never
// looks inside a wrapper object
// ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md), reversing
// ADR-0021/0022's "the schema is not public API"). This is also where `SignalRecord.state`
// and `RunRecord.state` get their two unions from, which are on the wire.
export * from "./schema.ts";
export type { EmittedSignal, SignalWorker, SignalWorkerOptions } from "./worker.ts";
export { createSignalWorker } from "./worker.ts";
