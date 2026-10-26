import { randomInt } from "node:crypto";

// No backtick, so the fence line cannot be made longer.
const specials = "!#$%&*+=?@^~";
const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function pick(from: string, count: number): string {
  let picked = "";
  for (let i = 0; i < count; i++) picked += from[randomInt(from.length)];
  return picked;
}

/**
 * Returns a random fence line that does not appear in `text`: four backticks followed by six
 * special characters and six letters.
 */
export function fence(text: string): string {
  return fenceWith(text, () => pick(specials, 6) + pick(letters, 6));
}

/** Test seam for {@link fence}; not exported from the package. */
export function fenceWith(text: string, suffix: () => string): string {
  mustBeString("fence", text);
  for (;;) {
    const line = `\`\`\`\`${suffix()}`;
    if (!text.includes(line)) return line;
  }
}

/**
 * Wraps text from outside the gateway between two copies of a fence line from {@link fence}.
 * The prompt must state the fence line. As a template helper, `quote` reads it from the
 * template data's `fence` value. Fencing makes prompt injection harder, not impossible.
 */
export function quote(text: string, fenceLine?: string): string {
  // As a template helper, the last argument is Handlebars' options object, which holds the data.
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

// Templates are not type-checked, so a helper can be handed anything.
function mustBeString(name: string, value: unknown): void {
  if (typeof value !== "string") {
    throw new TypeError(`${name} takes a string, and was handed ${typeof value}`);
  }
}
