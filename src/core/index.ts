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
export type { RunOutcome, RuntimeAdapter } from "./runtime.ts";
// `SignalState` and `RunState` are deliberately not re-exported: no public type
// carries a state yet — a Handler is given a Signal without one — so exporting
// them would be a promise with nothing behind it. Ticket 06 puts states on the
// wire and can export them then.
