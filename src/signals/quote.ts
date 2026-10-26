import { randomInt } from "node:crypto";

// Exclude backticks so each generated fence starts with exactly four.
const specials = "!#$%&*+=?@^~";
const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function pick(from: string, count: number): string {
  let picked = "";
  for (let i = 0; i < count; i++) picked += from[randomInt(from.length)];
  return picked;
}

/**
 * Returns a random delimiter (fence line) that does not appear anywhere in `text`.
 * The delimiter contains four backticks, six special characters, and six letters.
 */
export function fence(text: string): string {
  return fenceWith(text, () => pick(specials, 6) + pick(letters, 6));
}

/** Allows tests to supply the random suffix for {@link fence}. Not exported from the package. */
export function fenceWith(text: string, suffix: () => string): string {
  mustBeString("fence", text);
  for (;;) {
    const line = `\`\`\`\`${suffix()}`;
    if (!text.includes(line)) return line;
  }
}

/**
 * Marks the start and end of text from outside the gateway with a delimiter from {@link fence}.
 * The prompt must tell the agent which delimiter marks the text boundaries.
 * When used as a template helper, `quote` reads the delimiter from `fence` in the template data.
 * Delimiters reduce the risk of prompt injection but do not prevent it.
 */
export function quote(text: string, fenceLine?: string): string {
  // Handlebars passes an options object containing the template data as the helper's last argument.
  const line = typeof fenceLine === "string" ? fenceLine : fenceFromData(fenceLine);
  mustBeString("quote", text);
  if (typeof line !== "string" || text.includes(line)) {
    throw new TypeError(
      "quote needs a fence line from fence(text): pass it, or set `fence` in the template's data",
    );
  }
  return `${line}\n${text}\n${line}`;
}

function fenceFromData(options: unknown): unknown {
  return (options as { data?: { root?: { fence?: unknown } } } | undefined)?.data?.root?.fence;
}

// Templates are not type-checked, so validate helper arguments at runtime.
function mustBeString(name: string, value: unknown): void {
  if (typeof value !== "string") {
    throw new TypeError(`${name} takes a string, and was handed ${typeof value}`);
  }
}
