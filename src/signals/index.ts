export type {
  PostOutcome,
  Prompt,
  Signal,
  SignalHandler,
  SignalHandlers,
} from "./handlers.ts";
export type { RunRecord, SignalRecord } from "./routes.ts";
export type { RunOutcome, RunPrompt, Runtime } from "./runtime.ts";
// The states are exported now that they are on the wire: `SignalRecord.state` and
// `RunRecord.state` are what the Agent server answers with, so a consumer reading
// one has something to name. The table objects they are defined beside are not
// re-exported here, and that is organisation rather than encapsulation: they are
// public API on the `shared-agent-framework/signals/schema` subpath, which is the
// one door migration generation reads through
// ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md), reversing
// ADR-0021/0022's "the schema is not public API").
export type { RunState, SignalState } from "./schema.ts";
export type { EmittedSignal, SignalWorker, SignalWorkerOptions } from "./worker.ts";
export { createSignalWorker } from "./worker.ts";
