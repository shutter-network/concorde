import type { Prompt } from "./handlers.ts";

export type RunOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: string;
      /** The Run was stopped because it exceeded its `usageLimit`. */
      readonly limited?: boolean;
    };

export type RunPrompt = Omit<Prompt, "session" | "context" | "userId"> & {
  readonly session: string;
};

/** Usage for one model call, reported by the provider to the agent implementation. */
export type UsageReport = {
  /** `null` when the provider is unknown, such as for some summarization calls. */
  readonly provider: string | null;
  readonly model: string | null;
  /** Prompt tokens that were not read from the provider's cache. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** `input + output + cacheRead + cacheWrite`. */
  readonly totalTokens: number;
  /** Cost calculated by the agent implementation; 0 if the model price is unknown. */
  readonly cost: number;
};

/** The worker provides this observer to receive usage reports for one Run. */
export type RunObserver = {
  /**
   * The runtime calls this method once for each model call, in order, and waits for it to finish.
   * If it throws an error, the runtime must stop the Run and mark it as failed. The Run must
   * not keep using the model if its usage cannot be saved.
   */
  usage(report: UsageReport): void | Promise<void>;
};

/**
 * The worker calls `run` serially. A thrown error is recorded as a failed run.
 * The framework supplies no timeout or cancellation; an unsettled call blocks subsequent signals.
 * Agent output is not delivered to users automatically. Use the messenger to send messages.
 *
 * The worker always passes an `observer`. If a runtime never reports usage, no usage or cost
 * is recorded for its Runs.
 */
export type Runtime = {
  run(prompt: RunPrompt, observer?: RunObserver): Promise<RunOutcome>;
};
