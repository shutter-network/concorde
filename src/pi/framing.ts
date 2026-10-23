export type PiRecord = { readonly type: string } & Readonly<Record<string, unknown>>;

export type Framed =
  | { readonly kind: "record"; readonly record: PiRecord }
  | { readonly kind: "unreadable"; readonly line: string; readonly why: string }
  | { readonly kind: "truncated"; readonly line: string };

export async function* framedRecords(source: AsyncIterable<Uint8Array>): AsyncGenerator<Framed> {
  const decoder = new TextDecoder("utf-8");
  let pending = "";

  for await (const chunk of source) {
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const end = pending.indexOf("\n");
      if (end === -1) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const framed = readLine(line);
      if (framed !== undefined) yield framed;
    }
  }
  pending += decoder.decode();

  if (pending.trim() !== "") yield { kind: "truncated", line: pending };
}

function readLine(line: string): Framed | undefined {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (text.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable", line: text, why: "it is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unreadable", line: text, why: "JSON value is not an object" };
  }
  const fields = parsed as Record<string, unknown>;
  if (typeof fields.type !== "string") {
    return { kind: "unreadable", line: text, why: "Missing string field: type" };
  }
  return { kind: "record", record: fields as PiRecord };
}
