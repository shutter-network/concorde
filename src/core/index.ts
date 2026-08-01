export type { Core, CoreOptions, EmittedSignal } from "./core.ts";
export { createCore } from "./core.ts";
export type {
  PostOutcome,
  Prompt,
  Signal,
  SignalHandler,
  SignalHandlers,
} from "./handlers.ts";
export { coreMigrations } from "./migrations.ts";
export type { RunRecord, SignalRecord } from "./routes.ts";
export type { RunOutcome, RuntimeAdapter } from "./runtime.ts";
// The states are exported now that they are on the wire: `SignalRecord.state` and
// `RunRecord.state` are what the Agent server answers with, so a consumer reading
// one has something to name. The table objects they are defined beside stay
// unexported — the schema is not public API (ADR-0021, ADR-0022).
export type { RunState, SignalState } from "./schema.ts";
