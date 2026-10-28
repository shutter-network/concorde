import type { RunOutcome, RunPrompt, Runtime } from "../signals/runtime.ts";

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
