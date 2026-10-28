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
   * Add this Run's usage to this User's total. Take the id from data authenticated by the
   * Gateway, such as a Message's `userId`. Never take it from text written by a model or sender.
   * The agent does not receive this field. It is separate from the Session name and prompt text.
   * Omit this field to leave the Run's usage unassigned to any User.
   */
  readonly userId?: string;
};

export type PostOutcome = {
  readonly failed: boolean;
};

/**
 * Prompts run serially in array order. An empty array completes the signal without a run;
 * a failed run does not prevent later prompts from running.
 *
 * `post` runs after all runs, including when `handle` throws. `failed` covers failures in
 * `handle` or any run. A thrown `post` also fails the signal. No phase is automatically retried,
 * and the worker imposes no timeout.
 */
export type SignalHandler<TPayload = unknown> = {
  handle(signal: Signal<TPayload>): readonly Prompt[] | Promise<readonly Prompt[]>;
  post?(signal: Signal<TPayload>, outcome: PostOutcome): void | Promise<void>;
};

/** A signal with no matching kind fails permanently without invoking a handler. */
export type SignalHandlers = Readonly<Record<string, SignalHandler>>;
