export type Signal<TPayload = unknown> = {
  readonly id: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly emittedAt: Date;
};

export type Prompt = {
  /**
   * Reuse a name to continue a session; `null` creates one named `run_<Run id>`.
   * Sessions retain agent context and do not restrict access to gateway data.
   */
  readonly session: string | null;
  readonly text: string;
  /**
   * JSON stored on the run and exposed as `request.concordeRun.context` during execution.
   * Omission becomes `null`. The runtime does not receive it; put agent instructions in `text`.
   */
  readonly context?: unknown;
  /**
   * The User whose usage totals include this Run. Use data authenticated by the Gateway, such
   * as a Message's `userId`. Never use text written by a model or sender. The agent does not
   * receive this field. It is separate from the Session name and prompt text. If omitted,
   * the Run's usage is not assigned to any User.
   */
  readonly userId?: string;
  /**
   * The maximum `totalTokens` for this Run, including compaction. If the total exceeds this
   * limit, the runtime stops the agent and marks the Run as failed and limited. The Session
   * keeps its history up to that point. Usage is reported after each model call finishes, so
   * the Run can exceed the limit by at most one call. Must be a positive whole number. Omit
   * this field for no limit. To enforce a budget, pass the remaining token allowance.
   */
  readonly usageLimit?: number;
};

export type PostOutcome = {
  readonly failed: boolean;
  /** True if any Run stopped because it exceeded its `usageLimit`. That Run also failed. */
  readonly limited: boolean;
};

/**
 * Prompts run serially in array order. An empty array completes the signal without a run;
 * a failed run does not prevent later prompts from running.
 *
 * `post` runs after all runs, including when `handle` throws. `failed` covers failures in
 * `handle` or any run. `limited` is true if any run exceeded its usage limit. If `post` throws,
 * the signal also fails. No phase is automatically retried, and the worker imposes no timeout.
 */
export type SignalHandler<TPayload = unknown> = {
  handle(signal: Signal<TPayload>): readonly Prompt[] | Promise<readonly Prompt[]>;
  post?(signal: Signal<TPayload>, outcome: PostOutcome): void | Promise<void>;
};

/** A signal with no matching kind fails permanently without invoking a handler. */
export type SignalHandlers = Readonly<Record<string, SignalHandler>>;
