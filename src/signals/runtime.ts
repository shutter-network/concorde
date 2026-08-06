/**
 * The Runtime seam: the part that drives one kind of Agent Implementation.
 *
 * Deliberately the narrowest interface in the framework, because it decides whether a second
 * Agent Implementation is possible. Everything specific to one agent belongs to that Runtime's
 * own constructor. That means the container, the mounts, the model and the configuration files.
 */

import type { Prompt } from "./handlers.ts";

/**
 * How a Run ended.
 *
 * It carries none of the agent's output. Nothing in the framework reads what the agent said. The
 * Agent Implementation persists its own Session files. The agent writes anything it wants
 * recorded through the Agent server or the Workspace.
 *
 * A failure carries a message, because that message is the Run's `error` column.
 */
export type RunOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * The Prompt as a Runtime receives it: the Prompt a Handler wrote, with its Session **resolved**.
 *
 * Two types rather than one nullable type. The `null` a Handler can write is a request for a
 * fresh Session, not a value. The Signal Worker answers it, and names that Session
 * after the Run it belongs to. So a Runtime never has a fresh-Session case to handle.
 */
export type RunPrompt = Omit<Prompt, "session"> & {
  /** The Session this Run happens in. Always a name, never a request for one. */
  readonly session: string;
};

/**
 * Starts one Run and reports how it ended.
 *
 * A Runtime that throws instead of returning a failure becomes a failed Run carrying the thrown
 * message. Neither form can take the Signal Worker down.
 *
 * There is no timeout and no cancellation, on this call or anywhere else. A Run that never
 * returns halts the Gateway.
 */
export type Runtime = {
  run(prompt: RunPrompt): Promise<RunOutcome>;
};
