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
   * JSON stored on the run and carried as `request.concordeRun.context` on every agent server
   * request attributed to the Run by its `tag`. Omission becomes `null`. The runtime does not
   * receive it; put agent instructions in `text`.
   */
  readonly context?: unknown;
  /**
   * The Run tag: a random string the Signal Handler mints for this Prompt and writes into
   * `text`, where the agent instructions tell the agent to send it back as the
   * `concorde-run-tag` header (`runTagHeader`) on every agent server request. The worker holds
   * the tag from Run start to Run end, however the Run ends. A request whose header names a
   * held tag is attributed to that Run and `request.concordeRun` carries its id, Signal id,
   * Session and Context; a request with no header, an unknown tag or the tag of a Run that has
   * ended is attributed to no Run, even when exactly one Run is in flight. There is no fallback,
   * because a heuristic kept beside an exact mechanism is what gets relied on by accident. A
   * Run whose tag is already live on another Run fails without the runtime being called, and
   * the first Run keeps its attribution.
   *
   * The Handler mints it because a Prompt's text is complete when the Handler returns it and
   * the worker edits no text; the Handler is also the only one that knows where in its text
   * the instruction belongs. Use `crypto.randomUUID()` or random bytes; text injected into a
   * Message cannot guess it, which is what closes forgery of another Run's identity.
   *
   * The one limit: the tag travels in the Prompt text and so in the Session file. Runs share
   * the Agent Instance's filesystem and Sessions do not restrict access, so a Run with a shell
   * can read another Session's tag. It defeats injected text, not an agent that goes looking.
   *
   * Omit this field to produce a Run no request can be attributed to. The runtime does not
   * receive this field, and nothing is stored.
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
 * `handle` or any run. `limited` is true if any run exceeded its usage limit. A thrown `post`
 * also fails the signal. No phase is automatically retried, and the worker imposes no timeout.
 */
export type SignalHandler<TPayload = unknown> = {
  handle(signal: Signal<TPayload>): readonly Prompt[] | Promise<readonly Prompt[]>;
  post?(signal: Signal<TPayload>, outcome: PostOutcome): void | Promise<void>;
};

/** A signal with no matching kind fails permanently without invoking a handler. */
export type SignalHandlers = Readonly<Record<string, SignalHandler>>;
