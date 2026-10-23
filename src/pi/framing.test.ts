import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Framed, framedRecords } from "./framing.ts";

const lineSeparator = "\u2028";
const paragraphSeparator = "\u2029";

function chunks(text: string, size = 4096): AsyncIterable<Uint8Array> {
  const bytes = Buffer.from(text, "utf8");
  return (async function* () {
    for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
  })();
}

async function framingOf(text: string, size = 4096): Promise<Framed[]> {
  const found: Framed[] = [];
  for await (const framed of framedRecords(chunks(text, size))) found.push(framed);
  return found;
}

describe("what counts as a line", () => {
  it("is LF, however many records a chunk holds and however few", async () => {
    const text = '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n';

    for (const size of [1, 2, 5, 13, 4096]) {
      assert.deepEqual(
        (await framingOf(text, size)).map((framed) =>
          framed.kind === "record" ? framed.record.type : framed.kind,
        ),
        ["a", "b", "c"],
        `chunks of ${size} bytes`,
      );
    }
  });

  it("tolerates a CR before it, which is what pi asks a client to accept", async () => {
    assert.deepEqual(await framingOf('{"type":"a"}\r\n'), [
      { kind: "record", record: { type: "a" } },
    ]);
  });

  it("is not U+2028 or U+2029, which is the whole reason this module exists", async () => {
    const record = {
      type: "message_end",
      text: `before${lineSeparator}between${paragraphSeparator}after`,
    };

    assert.deepEqual(await framingOf(`${JSON.stringify(record)}\n`), [{ kind: "record", record }]);
  });

  it("is not a blank line, which every stream ending in an LF leaves behind", async () => {
    assert.deepEqual(await framingOf('\n\n{"type":"a"}\n\n'), [
      { kind: "record", record: { type: "a" } },
    ]);
  });

  it("survives a multi-byte character split across two chunks", async () => {
    const record = { type: "message_end", text: `\u{1f642} ok${lineSeparator}still ok` };

    assert.deepEqual(await framingOf(`${JSON.stringify(record)}\n`, 1), [
      { kind: "record", record },
    ]);
  });
});

describe("a line that is not a record", () => {
  it("is yielded rather than thrown, with which of the three it is", async () => {
    assert.deepEqual(await framingOf("EADDRINUSE: something else is on this port\n"), [
      {
        kind: "unreadable",
        line: "EADDRINUSE: something else is on this port",
        why: "it is not JSON",
      },
    ]);
    assert.deepEqual(await framingOf("[1,2,3]\n"), [
      { kind: "unreadable", line: "[1,2,3]", why: "JSON value is not an object" },
    ]);
    assert.deepEqual(await framingOf('{"notAType":true}\n'), [
      { kind: "unreadable", line: '{"notAType":true}', why: "Missing string field: type" },
    ]);
  });

  it("does not stop the ones after it, which is the caller's to decide about", async () => {
    const framed = await framingOf('nonsense\n{"type":"agent_settled"}\n');

    assert.deepEqual(
      framed.map((one) => one.kind),
      ["unreadable", "record"],
    );
  });
});

describe("a stream that ended inside a record", () => {
  it("says so, rather than reporting the half it got or nothing at all", async () => {
    const framed = await framingOf('{"type":"a"}\n{"type":"b"');

    assert.deepEqual(framed, [
      { kind: "record", record: { type: "a" } },
      { kind: "truncated", line: '{"type":"b"' },
    ]);
  });

  it("says nothing when the stream merely ended, however it was chunked", async () => {
    for (const size of [1, 3, 4096]) {
      assert.deepEqual(await framingOf('{"type":"a"}\n', size), [
        { kind: "record", record: { type: "a" } },
      ]);
    }
    assert.deepEqual(await framingOf(""), []);
  });
});
