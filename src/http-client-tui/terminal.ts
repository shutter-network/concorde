/**
 * Line-oriented and not full-screen, which is the whole shape of this file. There is no alternate
 * buffer, no scroll region and no resize handling, so the transcript is the terminal's own
 * scrollback and a pipe gets plain lines. Full-screen with no dependencies means hand-writing all
 * three for a client whose API surface is two routes.
 *
 * One escape sequence is used and it is used for one reason. A Message arriving while a line is
 * half typed would otherwise print into the middle of it and leave the prompt somewhere above the
 * cursor. So the input line is erased, the Message is printed, and readline redraws the prompt and
 * the buffer it still holds. `prompt(true)` is what redraws both: it keeps the cursor where the
 * typist left it, which writing the buffer back by hand would not.
 *
 * Nothing is written when the output is not a terminal. `interactive` is false when either stream
 * is redirected, and then this is a program that prints lines and reads lines, which is what makes
 * it survive being piped. The readline interface is built with the same flag, so it does not echo
 * into a file either.
 *
 * The clock in a line is UTC and comes out of the record's own `createdAt`, by slicing the ISO
 * string. The local-time alternative reads better and is a locale away from being untestable, and
 * a reader comparing two terminals against one Gateway wants the Gateway's clock anyway.
 */

import { createInterface, type Interface } from "node:readline/promises";
import type { MessageRecord } from "../messenger/messages.ts";

/** Erases the input line and returns the cursor to its start, so a Message can print over it. */
const eraseLine = "\r\x1b[2K";

/** What a typist sees when the client is waiting for them. */
const promptText = "> ";

/** Who said it. `you` is what this User submitted, and `agent` is what the shared agent answered. */
const speakers = { inbound: "you  ", outbound: "agent" } as const;

/** One Message as one line: who said it, when, and what. */
export function formatMessage(record: MessageRecord): string {
  return `${speakers[record.direction]} ${record.createdAt.slice(11, 16)}  ${record.text}`;
}

export type Terminal = {
  /**
   * Prints one line above the prompt, without disturbing a line being typed.
   *
   * Every line the client writes goes through this, including its own notices, so nothing can
   * print over the input by taking a different path.
   */
  print(line: string): void;
  /** The lines the person typed, one at a time, ending when they close the input. */
  lines(): AsyncIterable<string>;
  /** Draws the prompt. Call it after each line is handled, readline drawing it once per read. */
  prompt(): void;
  /** Runs when Ctrl-C is pressed, or when the input ends. */
  onClose(handler: () => void): void;
  close(): void;
};

export type TerminalOptions = {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
};

export function createTerminal(options: TerminalOptions): Terminal {
  const interactive = options.input.isTTY === true && options.output.isTTY === true;
  const readline: Interface = createInterface({
    input: options.input,
    output: options.output,
    prompt: promptText,
    terminal: interactive,
  });

  // Ctrl-C reaches an interface in terminal mode as this event rather than as a signal, and a
  // handler for it is what stops Node killing the process where it stands. Closing is the whole
  // of the shutdown: it ends the line iterator, which ends the caller's loop.
  readline.on("SIGINT", () => {
    if (interactive) options.output.write("\n");
    readline.close();
  });

  return {
    print(line) {
      if (!interactive) {
        options.output.write(`${line}\n`);
        return;
      }
      options.output.write(`${eraseLine}${line}\n`);
      readline.prompt(true);
    },
    lines: () => readline,
    prompt() {
      if (interactive) readline.prompt();
    },
    onClose(handler) {
      readline.on("close", handler);
    },
    close: () => readline.close(),
  };
}
