/**
 * A stand-in for the container runtime, so the adapter's own plumbing is a fast test.
 *
 * `containerCommand` is public API — it exists so `podman` works — and pointing it at
 * this script is what lets everything between "compose the invocation" and "read the
 * outcome" be exercised with no Docker, no image and no credentials: that the Prompt
 * reaches stdin and the stream is closed, that the argv arrives as composed, that the
 * agent's configuration is on disk *before* the container starts, that the outcome
 * comes from the stream and not the exit code, and that stderr is not a verdict.
 *
 * What it deliberately cannot prove is anything about a real container: that mounts
 * resolve, that user ids match, that a Session resumes. Those need Docker, and they are
 * what the one opt-in test in `container.test.ts` is for.
 *
 * Run as a program — `node fake-container.ts '<script json>' <the args docker got>` —
 * and imported as a module for its two helpers. The main-module guard is what lets it
 * be both.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type FakeContainerScript = {
  /** Written to stdout in one write. */
  readonly stdout?: string;
  /**
   * Written to stdout as separate writes, so a reader that assumes one chunk per
   * record — or that a multi-byte character arrives whole — is caught.
   */
  readonly stdoutChunks?: readonly string[];
  /** Written to stderr. */
  readonly stderr?: string;
  /** The exit status. Defaults to 0. */
  readonly exitCode?: number;
  /** Where to write what this process was given, as `FakeContainerReport` JSON. */
  readonly reportTo?: string;
  /** Paths to test for existence at the moment this runs, for the report. */
  readonly checkExisting?: readonly string[];
};

/** What the fake container runtime saw. */
export type FakeContainerReport = {
  /** The arguments it was given, which are the ones the adapter composed. */
  readonly args: readonly string[];
  /** Everything written to its stdin, byte for byte. */
  readonly stdin: string;
  /** Which of `checkExisting` were there when it ran. */
  readonly existing: Readonly<Record<string, boolean>>;
};

const thisFile = fileURLToPath(import.meta.url);

/** A `containerCommand` that runs this script with `script` baked in. */
export function fakeContainerCommand(script: FakeContainerScript): readonly string[] {
  return [process.execPath, thisFile, JSON.stringify(script)];
}

/** What the fake wrote down about the invocation it was handed. */
export function fakeContainerReport(file: string): FakeContainerReport {
  return JSON.parse(readFileSync(file, "utf8")) as FakeContainerReport;
}

if (process.argv[1] === thisFile) {
  const script = JSON.parse(process.argv[2] ?? "{}") as FakeContainerScript;
  const args = process.argv.slice(3);

  // Read to the end first: the adapter writes the Prompt and closes the stream, and a
  // fake that answered before reading would let a missing `stdin.end()` pass.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

  if (script.reportTo !== undefined) {
    const report: FakeContainerReport = {
      args,
      stdin: Buffer.concat(chunks).toString("utf8"),
      existing: Object.fromEntries(
        (script.checkExisting ?? []).map((file) => [file, existsSync(file)]),
      ),
    };
    writeFileSync(script.reportTo, JSON.stringify(report), "utf8");
  }

  if (script.stderr !== undefined) process.stderr.write(script.stderr);
  if (script.stdout !== undefined) process.stdout.write(script.stdout);
  for (const chunk of script.stdoutChunks ?? []) {
    process.stdout.write(chunk);
    // A tick between writes, so they really do arrive as separate chunks.
    await new Promise((resume) => setImmediate(resume));
  }

  process.exitCode = script.exitCode ?? 0;
}
