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
 * so the Core carries it as `unknown` and a Handler declares what it expects.
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
 * (ADR-0006). The name is validated against the Agent Runtime's grammar at this
 * seam rather than mid-Run, and that grammar **rejects colons** — the convention
 * is `user_<id>`, never `user:<id>`.
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
 * The `kind`-to-Handler map `core.start` takes. A Signal whose `kind` is absent
 * fails permanently (ADR-0017), which is why the map is a parameter of `start`
 * rather than something registered afterwards: starting with none registered is
 * unrepresentable (ADR-0021).
 */
export type SignalHandlers = Readonly<Record<string, SignalHandler>>;

/**
 * The Agent Runtime's session-id grammar. Alphanumeric at both ends, dots,
 * hyphens and underscores inside, and **no colons** — which is the whole reason
 * this is checked rather than assumed, since `user:42` is the obvious spelling and
 * it is invalid.
 */
const sessionNamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Whether `name` is a Session name the Agent Runtime will accept. */
export function isValidSessionName(name: string): boolean {
  return sessionNamePattern.test(name);
}

/**
 * Rejects a Prompt whose Session name the Agent Runtime would not accept, before
 * any Run exists.
 *
 * Checked here, where the Handler returned it, rather than when the Runtime
 * Adapter is handed it: the Operator learns the naming rules from a failed Signal
 * naming the value they wrote, instead of from a Run that got partway.
 */
export function assertSessionName(prompt: Prompt): void {
  if (prompt.session === null || isValidSessionName(prompt.session)) return;
  throw new Error(
    `the Session name ${JSON.stringify(prompt.session)} is not valid: the Agent Runtime accepts ${String(sessionNamePattern)}, which allows dots, hyphens and underscores inside the name but no colons — use user_42 rather than user:42. Pass null to request a fresh Session.`,
  );
}
