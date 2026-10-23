#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";
import { createClient, UnreachableError } from "./client.ts";
import { readInvocation, usage } from "./config.ts";
import { type RetryOptions, retrying } from "./retry.ts";
import { createTerminal, formatMessage } from "./terminal.ts";

const pollIntervalMs = 1000;

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
  process.on("SIGINT", () => terminal.close());

  const client = createClient({ baseUrl: config.baseUrl, signal });

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
        if (!signal.aborted) terminal.print(error instanceof Error ? error.message : String(error));
      }
    }
    terminal.prompt();
  }

  shutdown.abort();
  return await polling;
}

process.exitCode = await main();
