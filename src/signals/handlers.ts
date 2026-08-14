/**
 * The Handler seam, and the absence at the middle of it is the decision: a Handler is given the
 * Signal and nothing else. A full `ctx` was weighed first and lost, because carrying the
 * Messenger in it would put messaging back into the Signal Worker's Handler contract, which is what
 * keeping identity and messaging out of the Worker bought. A minimal `{ log, workspace,
 * signals }` lost too: it is a second way to obtain what the Operator's entry point already holds,
 * and a Handler's dependencies read better in its own factory than arriving ambiently. Do not add
 * one back.
 *
 * `post` cannot produce Prompts, and that is the same argument. A failure Signal was considered, so
 * that retry and notification could be written as ordinary Handlers, and rejected as indirection
 * over a phase that is already arbitrary code with store access.
 */

/**
 * What a Handler is given: the arrival record a Producer wrote, and the whole of it.
 *
 * The `payload` is whatever that Producer wrote and is never interpreted on the way here, so what a
 * given `kind` carries is the Producer's contract with this Handler rather than anything the
 * framework settles.
 *
 * The `state` and `error` that {@link SignalRecord} carries are absent. A Handler runs because the
 * Signal is being processed, and how it ends is the framework's to record.
 *
 * @typeParam TPayload What this Handler expects to find in the payload. The Signal Worker itself
 *   carries `unknown`, having no opinion about any of it, so the narrowing is the Handler's.
 */
export type Signal<TPayload = unknown> = {
  readonly id: string;
  readonly kind: string;
  readonly payload: TPayload;
  readonly emittedAt: Date;
};

/**
 * What a Handler produces from a Signal, and the only form in which anything reaches the agent.
 *
 * `session` names the Session this Prompt continues, and `null` asks for a fresh one. A Session is
 * the agent's own conversational state, kept by the Agent Implementation and continued by being
 * named again, so it is what makes one Prompt remember an earlier one. It organises context and
 * does not partition it: the agent reads every Signal, Run and Message over the Agent server
 * whatever Session it is in.
 *
 * The framework fixes no session topology and validates no name. One shared Session, one per User,
 * one per Run and any mixture of those are written here and nowhere else. Any string reaches the
 * Runtime as it was written, and a name the Agent Implementation refuses fails that one Prompt's
 * Run, carrying that program's own message, while the Prompts beside it still run.
 */
export type Prompt = {
  readonly session: string | null;
  readonly text: string;
};

/**
 * What the post phase is told about the Signal it is closing out.
 *
 * `failed` is true if any Run failed, and true as well if `handle` threw before there were any, so
 * it says the Signal came to nothing rather than that the agent ran and came back unhappy.
 */
export type PostOutcome = {
  readonly failed: boolean;
};

/**
 * A Signal Handler: `handle`, and optionally `post`.
 *
 * There is no context object and no second argument. A Handler closes over the logger, the
 * Workspace path, the Messenger and its prompt template, and its own factory in the entry point
 * supplies them, which is also why a Handler under test is a function of a Signal and needs no
 * harness. The one thing it cannot close over is the Signal Worker it runs under, that Worker being
 * constructed with the map this Handler is in.
 *
 * `handle` returns zero, one or many Prompts. Declining, answering and fanning out are one
 * mechanism, and an empty array is not a special case: the Signal is done with no Runs, and the
 * arrival record stays behind, which is what makes a refusal auditable. Fanning out runs every
 * Prompt in the order returned, and one that fails does not stop the rest. Throwing fails this
 * Signal alone, and the Worker carries on.
 *
 * `post` runs once, after every Run arising from the Signal has finished, whether they succeeded,
 * failed or were never created. It produces no Prompts, and it is the whole of the framework's
 * failure handling: notifying somebody, cleaning up, or emitting the work again is written here or
 * nowhere. Throwing here fails the Signal too, beside whatever else went wrong.
 *
 * Neither is given a timeout, and neither is ever run twice for one Signal.
 */
export type SignalHandler<TPayload = unknown> = {
  handle(signal: Signal<TPayload>): readonly Prompt[] | Promise<readonly Prompt[]>;
  post?(signal: Signal<TPayload>, outcome: PostOutcome): void | Promise<void>;
};

/**
 * The `kind`-to-Handler map: what a Gateway can act on, and the whole of it.
 *
 * A Signal whose `kind` is not a key here fails permanently. There is no Handler to run a post
 * phase, and nothing re-runs it, so a typo in a `kind` is loud and one-way rather than silent.
 */
export type SignalHandlers = Readonly<Record<string, SignalHandler>>;
