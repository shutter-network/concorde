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

  /** JSON stored on the Run and exposed through `request.concordeRun.context`; omitted means null. */
  readonly context?: unknown;

  /** Fresh random tag. Include it in `text` and instruct the agent to send it as `concorde-run-tag`.
   * Used only while the Run is active; omitted or unknown tags give no request attribution.
   * Tags are visible in Session files and are not an authorization boundary.
   */
  readonly tag?: string;
  /**
   * Add this Run's usage to this User's total. Take the id from data authenticated by the
   * Gateway, such as a Message's `userId`. Never take it from text written by a model or sender.
   * The agent does not receive this field. It is separate from the Session name and prompt text.
   * Omit this field to leave the Run's usage unassigned to any User.
   */
  readonly userId?: string;
  /**
   * The token limit for this Run, measured by `totalTokens`. This includes model calls that
   * summarize the Session's history. If usage goes over the limit, the runtime stops the agent.
   * The Run fails with `limited: true`, and the Session keeps its history so far.
   *
   * Usage is reported after each model call finishes, so the Run can go over the limit by at
   * most one call. Use a positive whole number, or omit this field for no limit. To enforce a
   * budget, pass the number of tokens left in that budget. A Prompt with no limit is never
   * stopped for usage, so every Prompt run for a User with a budget needs one.
   */
  readonly usageLimit?: number;

  /** Exclusive resource names. Runs sharing a Session or resource execute in emission order.
   * Resources are separate from Session names and are neither stored nor passed to the Runtime.
   */
  readonly resources?: readonly string[];
};

export type PostOutcome = {
  readonly failed: boolean;
  /** True if any Run stopped because it exceeded its `usageLimit`. That Run also failed. */
  readonly limited: boolean;
};

/** Prompts run in array order where Sessions or resources conflict; other Runs may overlap.
 * `post` runs after all Runs, including when `handle` throws; where a Handler has one, its Runs'
 * Sessions and resources stay held until it returns. `handle` of a later Signal runs while
 * earlier Signals' Runs and `post` are still in flight. No phase is retried automatically.
 */
export type SignalHandler<TPayload = unknown> = {
  handle(signal: Signal<TPayload>): readonly Prompt[] | Promise<readonly Prompt[]>;
  post?(signal: Signal<TPayload>, outcome: PostOutcome): void | Promise<void>;
};

/** A signal with no matching kind fails permanently without invoking a handler. */
export type SignalHandlers = Readonly<Record<string, SignalHandler>>;
