/**
 * The Signal Handler seam — the framework's primary extension point, in the way
 * an endpoint handler is a web framework's (ADR-0009).
 *
 * A Handler is a plain object and receives **only the Signal**. There is no
 * context object: everything else it needs — a logger, the Workspace path, the
 * Messenger, its prompt template — it closes over, supplied by its factory in the
 * Operator's entry point, which already holds every object in the Gateway
 * (ADR-0024). The consequence worth knowing is that testing a Handler needs no
 * harness from us: it is a function of a Signal and whatever its factory was
 * given.
 */

/**
 * What a Handler is given. The Signal's `state` and `error` are deliberately
 * absent: a Handler is running because the Signal is `processing`, and the
 * outcome is the framework's to record, not the Handler's to read.
 *
 * `TPayload` is a convenience for Handler authors — a Producer's payload shape is
 * that Producer's contract rather than the framework's ([`data-model.md`](../../docs/data-model.md)),
 * so the Signal Worker carries it as `unknown` and a Handler declares what it expects.
 */
export type Signal<TPayload = unknown> = {
  readonly id: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly emittedAt: Date;
};

/**
 * What a Handler produces, and the only form in which anything from outside
 * reaches the agent.
 *
 * `session` names the Session this Prompt continues; `null` requests a fresh one
 * (ADR-0006). A Session is the agent's own conversation state, kept by the Agent
 * Implementation and continued by naming it again — which is what makes one Prompt
 * remember an earlier one. The framework holds no opinion about the names: any
 * string reaches the Runtime unchanged, and what a name may contain is a property
 * of the Agent Implementation an Operator chose. One it will not accept fails that
 * Prompt's Run alone, with its own words in the Run's `error` and the name in its
 * `session`.
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
 * `handle` returns zero, one, or many Prompts — declining, answering, and fanning
 * out are the same mechanism, and an empty array is not a special case. `post`
 * runs once after every Run arising from the Signal has finished, whether they
 * succeeded, failed, or were never created because `handle` itself threw. It
 * cannot produce Prompts: it is the place for cleanup and notification, and the
 * whole of the framework's failure handling (ADR-0017).
 */
export type SignalHandler<TPayload = unknown> = {
  handle(signal: Signal<TPayload>): readonly Prompt[] | Promise<readonly Prompt[]>;
  post?(signal: Signal<TPayload>, outcome: PostOutcome): void | Promise<void>;
};

/**
 * The `kind`-to-Handler map `worker.start` takes. A Signal whose `kind` is absent
 * fails permanently (ADR-0017), which is why the map is a parameter of `start`
 * rather than something registered afterwards: starting with none registered is
 * unrepresentable (ADR-0021).
 */
export type SignalHandlers = Readonly<Record<string, SignalHandler>>;
