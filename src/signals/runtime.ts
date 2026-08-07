/**
 * The Runtime seam, and it is the narrowest interface in the framework on purpose: one method, one
 * argument, one outcome. What it decides is whether a second Agent Implementation is possible at
 * all (ADR-0033), so everything specific to one of them stays in that Runtime's own constructor:
 * the image, the mounts, the model, the configuration files the program reads on disk (ADR-0016).
 * Nothing that only `pi` needs may arrive here.
 *
 * Two things that look like omissions are decisions. There is no timeout, because a Run that is cut
 * short has already sent Messages and written the Workspace and is never retried, and the framework
 * cannot know the right number for a deployment it knows nothing about (ADR-0017). And there is no
 * Run id, because the Session name already traces a Run: the Worker resolves a fresh Session to
 * `run_<the Run's id>` before calling this.
 */

import type { Prompt } from "./handlers.ts";

/**
 * How a Run ended, and the whole of what a Runtime reports.
 *
 * It carries none of the agent's output. Nothing in the framework reads what the agent said: the
 * Agent Implementation keeps its own Session files, and the agent records anything it wants kept
 * through the Agent server or the Workspace.
 *
 * A failure carries a message because that message is what {@link RunRecord}'s `error` holds and
 * what every later read of the Run answers with. Nothing parses it, so it is written for a person.
 */
export type RunOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * The Prompt as a Runtime receives it: what a Handler wrote, with the Session resolved.
 *
 * Two types rather than one nullable one. The `null` a Handler may write is a request for a fresh
 * Session rather than a value, and the Signal Worker answers it before any Runtime is called,
 * naming that Session after the Run it belongs to. So there is no fresh-Session case to handle
 * here, no naming convention for a Runtime to invent, and every Run records the name it really ran
 * under.
 */
export type RunPrompt = Omit<Prompt, "session"> & {
  readonly session: string;
};

/**
 * Starts one Run and reports how it ended: the one method an Agent Implementation is driven
 * through.
 *
 * Called one Run at a time and never concurrently, whatever Session each is in. An implementation
 * therefore needs no locking of its own, and a Workspace shared with every Signal Handler is safe.
 *
 * Throwing instead of answering a failure comes to the same thing: the Run fails carrying the
 * thrown message. Neither form takes the Signal Worker down.
 *
 * There is no timeout and no cancellation, here or anywhere else in the framework. A call that
 * never settles halts the Gateway for every Party, so a Runtime that waits on something remote
 * brings its own bound.
 */
export type Runtime = {
  run(prompt: RunPrompt): Promise<RunOutcome>;
};
