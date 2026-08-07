#!/usr/bin/env node
/**
 * The `bin` of this package, and the only module here with side effects: everything it needs is
 * built in one function and nothing imports it, so the modules beside it stay drivable from a test.
 *
 * Two loops run at once. The input loop reads a line and submits it; the poll loop asks for what
 * arrived and prints it. They share one `AbortController`, which is what makes Ctrl-C immediate
 * rather than noticed at the end of the next wait: the same signal aborts a request in flight and
 * the sleep between polls.
 *
 * A refused submission is printed and the session carries on, because the reader can type the line
 * again. A refused poll ends the session, because it would otherwise be refused once a second
 * until somebody noticed.
 *
 * Nothing here is tested. What it holds is the wiring, the two loops and the exit codes, and every
 * decision under it is in a module that a test drives directly.
 */

import { setTimeout as delay } from "node:timers/promises";
import { createClient, UnreachableError } from "./client.ts";
import { readInvocation, usage } from "./config.ts";
import { type RetryOptions, retrying } from "./retry.ts";
import { createTerminal, formatMessage } from "./terminal.ts";

/** How often the log is asked for more. */
const pollIntervalMs = 1000;

/** The command line was wrong, which is neither a failure of the Gateway nor of the session. */
const usageExitCode = 2;

async function main(): Promise<number> {
  const invocation = readInvocation(process.argv.slice(2), process.env);
  if (invocation.kind === "help") {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (invocation.kind === "refused") {
    process.stderr.write(`${invocation.reason}\n\n${usage}\n`);
    return usageExitCode;
  }

  const config = invocation.config;
  const shutdown = new AbortController();
  const signal = shutdown.signal;

  const terminal = createTerminal({ input: process.stdin, output: process.stdout });
  terminal.onClose(() => shutdown.abort());
  // Ctrl-C reaches the interface itself while the input is a terminal, and the process only when
  // it is not. Closing the interface is the same shutdown either way.
  process.on("SIGINT", () => terminal.close());

  const client = createClient({ baseUrl: config.baseUrl, signal });

  // Said once however long the wait lasts. A line per attempt would push the transcript off the
  // screen of anybody who started the client before their Gateway.
  let announced = false;
  const connect: RetryOptions = {
    retryable: (error) => error instanceof UnreachableError,
    sleep: (ms) => delay(ms, undefined, { signal }),
    waiting: () => {
      if (announced) return;
      announced = true;
      terminal.print(`no answer from ${config.baseUrl} yet, still asking`);
    },
  };

  /** Prints what went wrong, unless the answer is that the reader stopped the client. */
  function report(error: unknown): number {
    if (signal.aborted) return 0;
    terminal.print(error instanceof Error ? error.message : String(error));
    return 1;
  }

  try {
    const issued = await retrying(
      () => client.logIn({ user: config.user, password: config.password }),
      connect,
    );
    terminal.print(`${config.baseUrl} as ${issued.user.id}, until ${issued.expiresAt}`);
    for (const record of await client.open()) terminal.print(formatMessage(record));
  } catch (error) {
    terminal.close();
    return report(error);
  }

  async function pollForever(): Promise<number> {
    while (!signal.aborted) {
      try {
        await delay(pollIntervalMs, undefined, { signal });
        for (const record of await retrying(() => client.poll(), connect)) {
          terminal.print(formatMessage(record));
        }
      } catch (error) {
        const code = report(error);
        terminal.close();
        return code;
      }
    }
    return 0;
  }

  const polling = pollForever();
  terminal.prompt();
  for await (const line of terminal.lines()) {
    const text = line.trim();
    if (text.length > 0) {
      try {
        await retrying(() => client.say(text), connect);
      } catch (error) {
        // The line is the reader's to send again, so this is a notice and not the end.
        if (!signal.aborted) terminal.print(error instanceof Error ? error.message : String(error));
      }
    }
    terminal.prompt();
  }

  // The input loop ends when the interface closes, which aborts the signal the poll loop waits on.
  shutdown.abort();
  return await polling;
}

process.exitCode = await main();
