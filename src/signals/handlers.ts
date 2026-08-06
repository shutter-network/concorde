/**
 * The Signal Handler seam: the framework's primary extension point.
 *
 * A Handler is a plain object, and it receives only the Signal. There is no context object.
 * It closes over everything else it needs: a logger, the Workspace path, the Messenger, its
 * prompt template. Its factory in the Operator's entry point supplies them.
 *
 * So testing a Handler needs no harness. It is a function of a Signal and whatever its factory
 * was given.
 */

/**
 * What a Handler is given.
 *
 * The Signal's `state` and `error` are absent. A Handler runs because the Signal is
 * `processing`, and the outcome is the framework's to record.
 *
 * @typeParam TPayload What this Handler expects in the payload. A Producer's payload shape is
 *   that Producer's contract, so the Signal Worker carries it as `unknown`.
 */
export type Signal<TPayload = unknown> = {
  readonly id: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly emittedAt: Date;
};

/**
 * What a Handler produces, and the only form in which anything reaches the agent.
 *
 * `session` names the Session this Prompt continues, and `null` requests a fresh one. A Session
 * is the agent's own conversation state, kept by the Agent Implementation and continued by
 * naming it again. That is what makes one Prompt remember an earlier one.
 *
 * The framework holds no opinion about the names. Any string reaches the Runtime unchanged, and
 * a name the Agent Implementation will not accept fails that Prompt's Run alone.
 */
export type Prompt = {
  readonly session: string | null;
  readonly text: string;
};

/** What the post phase is told. `failed` is true if any Run from the Signal failed. */
export type PostOutcome = {
  readonly failed: boolean;
};

/**
 * A Signal Handler: `handle`, and optionally `post`.
 *
 * `handle` returns zero, one, or many Prompts. Declining, answering, and fanning out are the
 * same mechanism, and an empty array is not a special case.
 *
 * `post` runs once, after every Run arising from the Signal has finished. It runs whether they
 * succeeded, failed, or were never created. It cannot produce Prompts. It is the place for
 * cleanup and notification, and the whole of the framework's failure handling.
 */
export type SignalHandler<TPayload = unknown> = {
  handle(signal: Signal<TPayload>): readonly Prompt[] | Promise<readonly Prompt[]>;
  post?(signal: Signal<TPayload>, outcome: PostOutcome): void | Promise<void>;
};

/**
 * The `kind`-to-Handler map: what a Gateway can act on, and the whole of it.
 *
 * A Signal whose `kind` is absent from the map fails permanently.
 */
export type SignalHandlers = Readonly<Record<string, SignalHandler>>;
