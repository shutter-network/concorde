/**
 * Starting a container and reading what it wrote.
 *
 * The one place in the `pi` adapter that spawns anything, and it spawns one thing: a
 * Run, whose stdout is the Agent Runtime's JSONL event stream. Four things have to be
 * right — write stdin and close it, read stdout to the end, collect stderr without
 * letting it fill, and wait for the process to be gone — and getting any of them wrong
 * produces a hang rather than a failure.
 *
 * Three of those are less obvious than they look:
 *
 *  - **stdout is read to the end even once the answer is known.** A process whose
 *    stdout stops being read blocks as soon as the pipe fills, so abandoning it
 *    early turns a finished Run into a hang — and there are no timeouts anywhere
 *    ([ADR-0017](../../docs/adr/0017-failed-runs-are-not-retried.md)).
 *  - **stderr is drained for the same reason**, not because anything decides
 *    anything by it. `pi` warns on stderr about a Session it is creating and exits
 *    0, so stderr is diagnosis and never a verdict.
 *  - **a write to stdin can fail**, with `EPIPE`, when the container exits before
 *    reading the Prompt. Unhandled, that is an error event on a stream nobody is
 *    listening to, which takes the Gateway's process down; the Run's real outcome
 *    is in the stream and is reported from there instead.
 *
 * Nothing here knows about `pi`, and nothing here interprets an exit code.
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

/** Enough of a `PiInvocation` to start: a `PiInvocation` satisfies it. */
export type ContainerCommand = {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to the process's stdin, which is then closed. */
  readonly stdin: string;
};

/** What a finished container left behind. */
export type ContainerResult<T> = {
  /** Whatever the reader made of stdout. */
  readonly value: T;
  /**
   * The exit status, or `null` when a signal ended it.
   *
   * Reported, never interpreted: `pi --mode json` exits 0 on model and API errors,
   * so an exit code cannot say whether a Run succeeded (ADR-0025). It is worth
   * putting in the message of a failure that was decided elsewhere, and worth
   * nothing else.
   */
  readonly exitCode: number | null;
  /** The signal that ended it, if one did. */
  readonly signal: NodeJS.Signals | null;
  /** What it wrote to stderr, truncated. Diagnosis for a failure, never a verdict. */
  readonly stderr: string;
};

/**
 * How much stderr is kept.
 *
 * The beginning rather than the end, because the container runtime's own refusals —
 * an image it cannot find, a flag it does not know — come first, and a wall of the
 * agent's own progress output would otherwise push them out. Bounded because this
 * ends up in a Run's `error` column and in a log line.
 */
const stderrLimit = 4000;

/**
 * Runs one container to completion and hands its stdout to `read`.
 *
 * `read` is given the raw bytes rather than text, so a multi-byte character split
 * across two chunks is the reader's to reassemble — which is the whole point of
 * `interpretPiOutput` taking bytes.
 *
 * There is no timeout, here or anywhere (ADR-0017). A Run that never returns halts
 * the Gateway, and that hole is accepted rather than papered over with a number the
 * framework cannot know.
 */
export async function runContainer<T>(
  invocation: ContainerCommand,
  read: (stdout: AsyncIterable<Uint8Array>) => Promise<T>,
): Promise<ContainerResult<T>> {
  const child = spawn(invocation.command, [...invocation.args], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Node emits exactly one of these, so waiting for both settles the one question a
  // later stream error cannot answer: whether the container runtime is there at all.
  const failedToStart = await new Promise<Error | undefined>((settled) => {
    child.once("spawn", () => settled(undefined));
    child.once("error", (error) => settled(error));
  });
  if (failedToStart !== undefined) {
    throw new Error(
      `the container runtime ${JSON.stringify(invocation.command)} could not be started: ${failedToStart.message}. It is the command the pi adapter runs the agent with — check that it is installed and on this process's PATH, or set containerCommand.`,
      { cause: failedToStart },
    );
  }

  // Before anything is written, so a container that exits immediately cannot make
  // this an unhandled error event on the way past.
  child.stdin.on("error", () => {
    // Deliberately nothing. A broken pipe means the container is already gone, and
    // what it did or did not do is in the stream that is still being read.
  });
  child.stdin.end(invocation.stdin, "utf8");

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("close", (code, signal) => done({ code, signal }));
  });
  // Started before stdout is read rather than awaited after it, so stderr is
  // draining the whole time and a chatty container cannot block on a full pipe.
  const stderr = collect(child.stderr);

  let value: T;
  try {
    value = await read(child.stdout);
  } catch (error) {
    // Only a stream failure gets here — a reader is expected to report a bad stream as
    // a failed Run rather than throw. Whatever it was, the container must not outlive
    // the call that started it: `docker run` forwards the signal and `--rm` cleans up.
    child.kill();
    throw error;
  }
  const { code, signal } = await exited;
  return { value, exitCode: code, signal, stderr: await stderr };
}

/** Reads a stream as text, keeping at most `stderrLimit` characters of it. */
async function collect(stream: Readable): Promise<string> {
  let text = "";
  let truncated = false;
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    if (text.length >= stderrLimit) {
      truncated = true;
      continue;
    }
    text += String(chunk);
  }
  if (text.length > stderrLimit) {
    truncated = true;
    text = text.slice(0, stderrLimit);
  }
  return truncated ? `${text}… (truncated)` : text;
}
