import { randomInt } from "node:crypto";
import type Handlebars from "handlebars";

// Exclude backticks so each generated fence starts with exactly four.
const specials = "!#$%&*+=?@^~";
const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function pick(from: string, count: number): string {
  let picked = "";
  for (let i = 0; i < count; i++) picked += from[randomInt(from.length)];
  return picked;
}

/**
 * Returns a random delimiter absent from `text`:
 * four backticks, six special characters, and six letters.
 */
export function fence(text: string): string {
  return fenceWith(text, () => pick(specials, 6) + pick(letters, 6));
}

/** Lets tests supply the suffix for {@link fence}. Not exported from the package. */
export function fenceWith(text: string, suffix: () => string): string {
  for (;;) {
    const line = `\`\`\`\`${suffix()}`;
    if (!text.includes(line)) return line;
  }
}

/**
 * Wraps external text in a delimiter from {@link fence}, leaving the text unchanged.
 * The prompt must identify the exact delimiter. Use {@link quoteHelper} in templates.
 * Delimiters reduce the risk of prompt injection but do not prevent it.
 */
export function quote(text: string, fenceLine: string): string {
  if (text.includes(fenceLine)) {
    throw new TypeError("quote needs a fence line from fence(text) that the text does not contain");
  }
  return `${fenceLine}\n${text}\n${fenceLine}`;
}

/**
 * Handlebars helper for {@link quote}. Reads `fence` from the root template data.
 * Register it as `helpers: { quote: quoteHelper }` and call it as `quote` in the template.
 */
export function quoteHelper(text: unknown, options: Handlebars.HelperOptions): string {
  // Templates are not type-checked, so check arguments at runtime.
  if (typeof text !== "string") {
    throw new TypeError(`quote takes a string, and was handed ${typeof text}`);
  }
  const fenceLine: unknown = options.data?.root?.fence;
  if (typeof fenceLine !== "string") {
    throw new TypeError(
      "quote needs a fence line from fence(text): set `fence` in the template's data",
    );
  }
  return quote(text, fenceLine);
}
