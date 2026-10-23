import type { Prompt } from "./handlers.ts";

export type RunOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type RunPrompt = Omit<Prompt, "session" | "context"> & {
  readonly session: string;
};

/**
 * The worker calls `run` serially. A thrown error is recorded as a failed run.
 * The framework supplies no timeout or cancellation; an unsettled call blocks subsequent signals.
 * Agent output is not delivered to users automatically. Use the messenger to send messages.
 */
export type Runtime = {
  run(prompt: RunPrompt): Promise<RunOutcome>;
};
