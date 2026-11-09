import type { Prompt } from "./handlers.ts";

/**
 * `usage` holds one report per model call that finished during the Run, in the order the calls
 * finished. It is present on failures too, because the provider charges for those calls.
 */
export type RunOutcome =
  | { readonly ok: true; readonly usage: readonly UsageReport[] }
  | {
      readonly ok: false;
      readonly error: string;
      readonly usage: readonly UsageReport[];
      /** The Run was stopped because it exceeded its `usageLimit`. */
      readonly limited?: boolean;
    };

export type RunPrompt = Omit<Prompt, "session" | "context" | "userId" | "resources" | "tag"> & {
  readonly session: string;
};

/** Usage for one model call, reported by the provider to the agent implementation. */
export type UsageReport = {
  /** `null` when the provider is unknown, such as for some summarization calls. */
  readonly provider: string | null;
  readonly model: string | null;
  /** Prompt tokens not served from the provider's cache. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** `input + output + cacheRead + cacheWrite`. */
  readonly totalTokens: number;
  /** Cost calculated by the agent implementation; 0 if the model price is unknown. */
  readonly cost: number;
};

/** Calls may overlap. Return Usage on success and failure; throwing loses Usage.
 * No timeout or cancellation is supplied. An unsettled call also blocks worker shutdown.
 */
export type Runtime = {
  run(prompt: RunPrompt): Promise<RunOutcome>;
};
