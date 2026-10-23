import { createInterface, type Interface } from "node:readline/promises";
import type { MessageRecord } from "../messenger/messages.ts";

const eraseLine = "\r\x1b[2K";

const promptText = "> ";

const speakers = { inbound: "you  ", outbound: "agent" } as const;

export function formatMessage(record: MessageRecord): string {
  return `${speakers[record.direction]} ${record.createdAt.slice(11, 16)}  ${record.text}`;
}

export type Terminal = {
  print(line: string): void;
  lines(): AsyncIterable<string>;
  prompt(): void;
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
