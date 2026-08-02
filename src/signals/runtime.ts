/**
 * The Runtime seam: the Part that drives one kind of Agent Implementation on the
 * Signal Worker's behalf.
 *
 * Deliberately the narrowest interface in the framework, because it is the one
 * that decides whether a second Agent Implementation is possible at all. Everything
 * `pi`-shaped — the container, the mounts, the model, the configuration files —
 * belongs to the Runtime's own constructor, not here (ADR-0016).
 */

import type { Prompt } from "./handlers.ts";

/**
 * How a Run ended.
 *
 * It carries **none of the agent's output**, and that is a decision rather than an
 * omission: nothing in the framework reads what the agent said, the Agent
 * Implementation persists its own Session files, and anything the agent wants
 * recorded it writes itself through the Agent server or the Workspace. A failure
 * carries a message because that message is the Run's `error` column and the only
 * thing an Operator has to go on.
 */
export type RunOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Starts one Run and reports how it ended.
 *
 * `runId` is the Run's id, already recorded, so a Runtime can name it in its own
 * logs and artifacts. A Runtime that throws instead of returning a failure is
 * treated as a failed Run carrying the thrown message, so neither form can take
 * the worker down.
 *
 * There is no timeout and no cancellation, on this call or anywhere else
 * (ADR-0017): a Run that never returns halts the Gateway, and that hole is
 * accepted rather than papered over with a number the framework cannot know.
 */
export type Runtime = {
  run(prompt: Prompt, runId: string): Promise<RunOutcome>;
};
