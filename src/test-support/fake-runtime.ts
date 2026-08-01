/**
 * A fake Runtime Adapter: records the Prompts it was handed and returns a scripted
 * outcome.
 *
 * The Runtime Adapter is the one thing in the framework that is faked in tests
 * (ADR-0022 keeps PostgreSQL real), because the alternative is a container, an
 * image, and credentials for every assertion about dispatch. The real one arrives
 * in tickets 07 and 08.
 *
 * It also watches for **overlap**. The worker is serial globally (ADR-0012) and a
 * shared Workspace is only safe because of it, so a second concurrent Run is the
 * failure that matters most and the only place it is observable is here.
 */

import type { Prompt } from "../core/handlers.ts";
import type { RunOutcome, RuntimeAdapter } from "../core/runtime.ts";

export type RecordedRun = {
  readonly prompt: Prompt;
  readonly runId: string;
};

/** What the adapter should do with one Prompt. Defaults to succeeding. */
export type RuntimeScript = (prompt: Prompt, runId: string) => RunOutcome | Promise<RunOutcome>;

export type FakeRuntime = RuntimeAdapter & {
  /** Every Run, in the order the worker started them. */
  readonly recorded: readonly RecordedRun[];
  /** Whether two Runs were ever in flight at once. Always expected to be false. */
  readonly overlapped: boolean;
  /** The Prompt texts, in order — the usual assertion, spelled once. */
  texts(): string[];
};

/**
 * How long each Run is held before its outcome is returned.
 *
 * Not padding: a Run that returned immediately could finish before a second one
 * the worker had started concurrently even got its first query back from the pool,
 * and the overlap would go unobserved. Comfortably longer than a round trip to a
 * local PostgreSQL, and short enough that the whole suite pays a few milliseconds
 * for it.
 */
const holdMs = 5;

export function fakeRuntime(script: RuntimeScript = () => ({ ok: true })): FakeRuntime {
  const recorded: RecordedRun[] = [];
  let inFlight = 0;
  let overlapped = false;

  return {
    recorded,
    get overlapped() {
      return overlapped;
    },
    texts() {
      return recorded.map((run) => run.prompt.text);
    },
    async run(prompt, runId) {
      recorded.push({ prompt, runId });
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      try {
        // Stay inside the call a while, so a worker which had started two Runs
        // concurrently has both of them in here at once rather than getting away
        // with it because the first happened to finish first.
        await new Promise((resume) => setTimeout(resume, holdMs));
        if (inFlight > 1) overlapped = true;
        return await script(prompt, runId);
      } finally {
        inFlight -= 1;
      }
    },
  };
}
