/**
 * The one place a byte ever becomes a record, and the reason it is one place.
 *
 * Framing is strictly LF, and **nothing in this package may reach for `node:readline`**. That
 * splits on U+2028 and U+2029 as well; both are legal inside a JSON string and `JSON.stringify`
 * emits them literally, so a record carrying either arrives as two malformed halves. `pi`'s own
 * `docs/rpc.md` says this about writing a client, in those words, and it is the kind of rule that
 * survives only by having a single module to live in: a second reader written next year would be
 * written with `createInterface`, because that is what a line looks like in Node.
 *
 * A trailing `\r` is stripped, which is the other half of the same page: the protocol is LF-framed
 * and a client should accept `\r\n` anyway. Nothing observed has written one, and accepting it
 * costs a line.
 *
 * Reading is total. A line that is not a record is **yielded** as one that could not be read rather
 * than thrown, because the caller is deciding the outcome of a Run and a throw there is a Run that
 * fails with a stack trace instead of a sentence. The three unreadable shapes are told apart for
 * the same reason: `it is not JSON` and `it has no type field` send an Operator to different
 * places, one of them being something else on the Agent Instance's stdout.
 */

/**
 * A record as the RPC channel writes it: a `type` and whatever else that type carries.
 *
 * Nothing here knows which types exist. `switch_session` responses, `agent_settled` and an
 * extension's UI request are all this shape, and what each one means is the caller's to decide.
 */
export type PiRecord = { readonly type: string } & Readonly<Record<string, unknown>>;

/**
 * One line of the channel, read.
 *
 * `truncated` is not `unreadable` with a different message: it says the stream **ended** inside a
 * record, which is a dropped connection rather than something wrong with what was written. The two
 * end a Run with different sentences and an Operator looks in different places for each.
 */
export type Framed =
  | { readonly kind: "record"; readonly record: PiRecord }
  | { readonly kind: "unreadable"; readonly line: string; readonly why: string }
  | { readonly kind: "truncated"; readonly line: string };

/**
 * Cuts a stream of bytes into records, on LF and on nothing else.
 *
 * The source is raw chunks rather than decoded text, a chunk boundary falling wherever the
 * operating system puts it, including inside a multi-byte character: `stream: true` is what makes
 * such a character survive, where a per-chunk `toString()` would produce U+FFFD and a record that
 * no longer parses.
 *
 * Lazy, and that is load-bearing rather than tidy. A Run is over at `agent_settled`, and the caller
 * stops pulling there; a reader that drained to the end of the stream instead would wait for the
 * Agent Instance to close a connection it has no reason to close.
 */
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
  // Whatever the decoder was holding back, which can only be the tail of a character that never
  // arrived whole. It cannot contain an LF, and the check below is what reports it.
  pending += decoder.decode();

  // A trailing LF leaves an empty remainder behind, and every well-formed stream ends with one.
  if (pending.trim() !== "") yield { kind: "truncated", line: pending };
}

/** One framed line as a record, or why it is not one, or nothing when it is blank. */
function readLine(line: string): Framed | undefined {
  // The protocol is LF-framed and a client accepts `\r\n`; see the file header.
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  // Nothing observed writes a blank line, but a reader that failed on one would fail on a stream
  // that merely ended politely.
  if (text.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable", line: text, why: "it is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unreadable", line: text, why: "it is JSON but not an object" };
  }
  const fields = parsed as Record<string, unknown>;
  if (typeof fields.type !== "string") {
    return { kind: "unreadable", line: text, why: "it has no type field" };
  }
  return { kind: "record", record: fields as PiRecord };
}
