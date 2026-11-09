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

  started(text: string): Promise<void>;

  release(text: string): void;

  releaseAll(): void;
};

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
