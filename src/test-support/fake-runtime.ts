import type { RunOutcome, RunPrompt, Runtime } from "../signals/runtime.ts";
import { waitUntil } from "./wait.ts";

export type RuntimeScript = (prompt: RunPrompt) => RunOutcome | Promise<RunOutcome>;

export type FakeRuntime = Runtime & {
  readonly recorded: readonly RunPrompt[];
  readonly overlapped: boolean;
  texts(): string[];
};

const holdMs = 5;

export function fakeRuntime(script: RuntimeScript = () => ({ ok: true, usage: [] })): FakeRuntime {
  const recorded: RunPrompt[] = [];
  let inFlight = 0;
  let overlapped = false;

  return {
    recorded,
    get overlapped() {
      return overlapped;
    },
    texts() {
      return recorded.map((prompt) => prompt.text);
    },
    async run(prompt) {
      recorded.push(prompt);
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      try {
        await new Promise((resume) => setTimeout(resume, holdMs));
        if (inFlight > 1) overlapped = true;
        return await script(prompt);
      } finally {
        inFlight -= 1;
      }
    },
  };
}

export type GatedRuntime = {
  readonly runtime: FakeRuntime;
  /** Resolves once the Runtime has been called with this text; fails after the usual timeout. */
  started(text: string): Promise<void>;
  /** Lets the Run with this text return. Harmless before the Run exists. */
  release(text: string): void;
  /** For a `finally`: a Run left at a gate would hold the Worker's `stop` forever. */
  releaseAll(): void;
};

/**
 * A Runtime whose every Run waits at a gate named after its text, so which Runs are in flight
 * together is the test's decision and never the clock's. A Run's outcome is the script's, which
 * is consulted after the gate opens.
 */
export function gatedRuntime(
  script: RuntimeScript = () => ({ ok: true, usage: [] }),
): GatedRuntime {
  const gates = new Map<string, PromiseWithResolvers<void>>();
  let open = false;
  const gate = (text: string): PromiseWithResolvers<void> => {
    let held = gates.get(text);
    if (held === undefined) {
      held = Promise.withResolvers<void>();
      if (open) held.resolve();
      gates.set(text, held);
    }
    return held;
  };
  const runtime = fakeRuntime(async (prompt) => {
    await gate(prompt.text).promise;
    return script(prompt);
  });
  return {
    runtime,
    started: (text) =>
      waitUntil(`the Run ${JSON.stringify(text)} has started`, async () =>
        runtime.texts().includes(text),
      ),
    release: (text) => gate(text).resolve(),
    releaseAll: () => {
      open = true;
      for (const held of gates.values()) held.resolve();
    },
  };
}
