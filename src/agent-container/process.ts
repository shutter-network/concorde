/**
 * The one place in the framework that spawns anything, and it spawns one thing: a Run. Four
 * properties are load-bearing here, and undoing any of them buys a hang rather than a failure,
 * because there are no timeouts anywhere in this framework.
 *
 *  - **stdout is read to the end**, even after the answer is known. A process whose stdout stops
 *    being read blocks as soon as the pipe fills.
 *  - **stderr is drained from before stdout is read**, for the same reason, and never awaited
 *    after. A chatty container would otherwise block on a full pipe while stdout is being read.
 *  - **a write to stdin can fail** with `EPIPE`, when the container exits before reading the
 *    Prompt. Unhandled, an `error` event on a stream takes the Gateway's process down, so the
 *    handler is attached before anything is written.
 *  - **the process is waited for**, so that a Run is finished only when the container is gone.
 *
 * Both `spawn` outcomes are awaited before anything else, because a later stream error cannot
 * answer whether the container runtime is installed at all.
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

/** Enough of a composed command to start one: a `ComposedCommand` satisfies it. */
export type ContainerCommand = {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to the process's stdin, which is then closed. */
  readonly stdin: string;
};

/** What a finished container left behind. */
export type ContainerResult<T> = {
  /** Whatever the reader made of stdout, and the only thing that decides a Run. */
  readonly value: T;
  /**
   * The exit status, or `null` when a signal ended it. Reported and never interpreted: an agent in
   * machine-readable mode can exit 0 on a model error, so an exit code cannot say whether a Run
   * succeeded. It is worth adding to a failure that was decided elsewhere.
   */
  readonly exitCode: number | null;
  /** The signal that ended it, if one did. */
  readonly signal: NodeJS.Signals | null;
  /** What it wrote to stderr, truncated. Diagnosis for a failure, never a verdict. */
  readonly stderr: string;
};

/**
 * How much stderr is kept, and it is the beginning rather than the end. The container runtime's own
 * refusals come first, an image it cannot find or a flag it does not know, and a wall of the
 * agent's progress output would push them out. Bounded at all because this reaches a Run's `error`
 * column.
 */
const stderrLimit = 4000;

/**
 * Runs one container to completion and hands its stdout to `read`, which is given raw bytes rather
 * than text.
 *
 * There is no timeout, here or anywhere: a Run that never returns halts the Gateway.
 *
 * @throws If the container runtime cannot be started, or if `read` threw. A reader is expected to
 *   report a bad stream as a failed Run instead, so a throw is a stream failure, and the container
 *   is killed before it propagates.
 */
export async function runContainer<T>(
  invocation: ContainerCommand,
  read: (stdout: AsyncIterable<Uint8Array>) => Promise<T>,
): Promise<ContainerResult<T>> {
  const child = spawn(invocation.command, [...invocation.args], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Node emits exactly one of these two events; see the file header for why both are awaited.
  const failedToStart = await new Promise<Error | undefined>((settled) => {
    child.once("spawn", () => settled(undefined));
    child.once("error", (error) => settled(error));
  });
  if (failedToStart !== undefined) {
    throw new Error(
      `the container runtime ${JSON.stringify(invocation.command)} could not be started: ${failedToStart.message}. It is the command the agent's container is run with: check that it is installed and on this process's PATH, or set containerCommand.`,
      { cause: failedToStart },
    );
  }

  // Before anything is written. A container that exits immediately cannot then make this an
  // unhandled error event on the way past.
  child.stdin.on("error", () => {
    // Deliberately nothing. A broken pipe means the container is already gone. What it did or
    // did not do is in the stream that is still being read.
  });
  child.stdin.end(invocation.stdin, "utf8");

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("close", (code, signal) => done({ code, signal }));
  });
  // Started here and awaited at the end, so stderr drains while stdout is being read.
  const stderr = collect(child.stderr);

  let value: T;
  try {
    value = await read(child.stdout);
  } catch (error) {
    // Whatever it was, the container must not outlive the call that started it: `docker run`
    // forwards the signal and `--rm` cleans up.
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
