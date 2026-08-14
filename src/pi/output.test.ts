/**
 * The Agent Implementation's JSONL output, and the three traps in reading it.
 *
 * The fixtures under `./fixtures/` are **real** `pi --mode json` output, captured
 * from `@earendil-works/pi-coding-agent` 0.83.0 driven against a local
 * OpenAI-compatible server that returned a scripted reply, an HTTP 400, and a
 * retryable HTTP 429 respectively. Nothing about them is hand-written except that
 * the session's `cwd` and id were rewritten to `/workspace` and `user_42`. That
 * matters: each of the three traps is a claim about what `pi` actually emits, and a
 * fixture invented from the documentation would pin our reading of the documentation
 * rather than the behaviour — `docs/json.md` does not even list `agent_settled`.
 *
 * Every case here is a pure function over one of those streams. No Docker, no
 * credentials, no network: that is the whole reason this ticket is separate from the
 * one that starts a container.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { RunOutcome } from "../signals/runtime.ts";
import { interpretPiOutput } from "./output.ts";

/**
 * The two characters `node:readline` splits on and JSON does not. Written as escapes
 * rather than literally, because a literal one looks like nothing at all in a source
 * file and would be lost to the next person who touched the line.
 */
const lineSeparator = "\u2028";
const paragraphSeparator = "\u2029";

/** A captured stream, as text. */
async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8");
}

/** The records of a captured stream, so a test can build a variant of it. */
async function recordsOf(name: string): Promise<Record<string, unknown>[]> {
  const text = await fixture(name);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Records back to a stream, the way `pi` writes it: one JSON object per LF. */
function asStream(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

/**
 * Every assistant message a record carries — `message` on the message and turn
 * records, and each entry of `messages` on `agent_end`.
 *
 * A test that changed only one of those places would be changing a stream `pi` never
 * writes, and would say nothing about which of them is read.
 */
function assistantMessagesIn(records: readonly unknown[]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const record of records) {
    const { message, messages } = record as { message?: unknown; messages?: unknown };
    for (const candidate of [message, ...(Array.isArray(messages) ? messages : [])]) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const fields = candidate as Record<string, unknown>;
      if (fields.role === "assistant") found.push(fields);
    }
  }
  assert.ok(found.length > 0, "the stream should carry at least one assistant message");
  return found;
}

/**
 * `text` as an async iterable of byte chunks of `size` bytes.
 *
 * Bytes rather than strings, and a size the test chooses, because that is the only
 * way to exercise what a pipe actually delivers: a chunk boundary falls wherever the
 * operating system puts it, including inside a multi-byte character.
 */
function chunks(text: string, size: number): AsyncIterable<Uint8Array> {
  const bytes = Buffer.from(text, "utf8");
  return (async function* () {
    for (let at = 0; at < bytes.length; at += size) {
      yield bytes.subarray(at, at + size);
    }
  })();
}

/**
 * The Session every case here reads as, since a reader is made per Run and named after
 * one. Which Session it is only ever shows in a failure, and `names the Session` below is
 * where that is the subject.
 */
const session = "user_42";

/** What a Run of that Session would report for this output. */
async function outcomeOf(text: string, chunkSize = 4096): Promise<RunOutcome> {
  return interpretPiOutput(chunks(text, chunkSize), session);
}

/** The failure message, with an assertion that there was a failure at all. */
async function failureOf(text: string, chunkSize = 4096): Promise<string> {
  const outcome = await outcomeOf(text, chunkSize);
  assert.equal(
    outcome.ok,
    false,
    `this output should fail the Run; it was ${JSON.stringify(outcome)}`,
  );
  return outcome.ok ? "" : outcome.error;
}

describe("a settled run", () => {
  it("is a successful Run", async () => {
    assert.deepEqual(await outcomeOf(await fixture("settled-ok")), { ok: true });
  });

  it("reads the same however the bytes arrive, one byte at a time included", async () => {
    const text = await fixture("settled-ok");
    for (const size of [1, 2, 3, 7, 64, 1_000_000]) {
      assert.deepEqual(await outcomeOf(text, size), { ok: true }, `chunks of ${size} bytes`);
    }
  });

  it("ignores whatever follows the settle, so the first one is terminal", async () => {
    const records = await recordsOf("settled-ok");
    // Whatever a later record says, it is not about this Run: the agent had already
    // settled, which is the one point at which the outcome is knowable.
    records.push({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "after the settle" },
    });

    assert.deepEqual(await outcomeOf(asStream(records)), { ok: true });
  });
});

/**
 * **Trap 1.** `--mode json` exits 0 on model and API errors — only `mode: "text"`
 * sets a non-zero exit, and it does so by inspecting the last assistant message
 * itself. So the outcome is read from that message's `stopReason` and never from the
 * exit code, and this function is not given one to be tempted by.
 */
describe("a model error while the process exits zero", () => {
  it("is a failed Run carrying the error", async () => {
    const error = await failureOf(await fixture("model-error-exit-zero"));

    assert.match(error, /mock provider rejected the request/);
    assert.match(error, /stopReason/);
  });

  it("is announced nowhere but inside the assistant message", async () => {
    const records = await recordsOf("model-error-exit-zero");

    // The stream ends exactly as a successful one does, and `pi` exited 0 for this
    // run: that is what makes reading the exit code a silent false success.
    assert.equal(records.at(-1)?.type, "agent_settled");
    const ended = records.find((record) => record.type === "agent_end");
    assert.equal((ended as { willRetry?: unknown }).willRetry, false);
    assert.deepEqual(
      records.filter((record) => String(record.type).startsWith("auto_retry")),
      [],
      "nothing in this stream reports a retry or a failure of its own",
    );
    const answer = assistantMessagesIn(records).at(-1);
    assert.equal(answer?.stopReason, "error");
    assert.match(String(answer?.errorMessage), /mock provider rejected the request/);
  });

  it("fails a Run that was aborted, too", async () => {
    assert.match(await failureOf(await settledWith("aborted", "Request aborted")), /aborted/);
  });

  /**
   * The reasons that are *not* failures in `pi`'s own text-mode rule and are not
   * answers either. Both are reachable — `pending` is what a streaming assistant
   * message carries, and `toolUse` means the agent stopped to call a tool and never
   * came back — and reading the outcome as "not one of the two failures" reports both
   * as successful Runs, which is a false success with a settle to point at.
   */
  it("fails a Run whose last message was not an answer at all", async () => {
    for (const stopReason of ["pending", "toolUse", "something-new"]) {
      assert.match(
        await failureOf(await settledWith(stopReason, undefined)),
        new RegExp(stopReason),
        `${stopReason} is not an answer`,
      );
    }
  });

  it("succeeds when the answer was cut short by the output-token limit", async () => {
    // Truncated rather than absent, and `pi` prints it and exits 0.
    assert.deepEqual(await outcomeOf(await settledWith("length", undefined)), { ok: true });
  });
});

/** The captured success stream, with every assistant message ending this way instead. */
async function settledWith(stopReason: string, errorMessage: string | undefined): Promise<string> {
  const records = await recordsOf("settled-ok");
  for (const message of assistantMessagesIn(records)) {
    message.stopReason = stopReason;
    if (errorMessage !== undefined) message.errorMessage = errorMessage;
  }
  return asStream(records);
}

/**
 * **Trap 2.** `agent_end` fires per low-level agent run and can be followed by an
 * automatic retry or a compaction, so the terminal record is `agent_settled`. The
 * captured stream is the case that matters: the first `agent_end` carries an
 * assistant message whose `stopReason` is `"error"`, and the Run then *succeeds*.
 */
describe("an agent_end followed by a retry", () => {
  it("is not the end: the Run is finished at the settle, and it succeeded", async () => {
    assert.deepEqual(await outcomeOf(await fixture("retry-then-settled")), { ok: true });
  });

  it("carries the opposite outcome at the first agent_end, which is not read as the end", async () => {
    const records = await recordsOf("retry-then-settled");
    const firstEnd = records.findIndex((record) => record.type === "agent_end");
    assert.notEqual(firstEnd, -1);

    // What the first `agent_end` holds is the opposite of the Run's outcome: a
    // `stopReason` of "error" carrying the provider's refusal.
    const upToFirstEnd = records.slice(0, firstEnd + 1);
    const answer = assistantMessagesIn(upToFirstEnd).at(-1);
    assert.equal(answer?.stopReason, "error");
    assert.match(String(answer?.errorMessage), /rate limited/);

    // And a stream that stops there is reported as unfinished rather than as that
    // error, because an `agent_end` says nothing about whether the Run is over.
    assert.match(await failureOf(asStream(upToFirstEnd)), /without an agent_settled record/);

    // What the stream itself says: this `agent_end` announces the retry, and the
    // retry follows it.
    assert.equal((records[firstEnd] as { willRetry?: unknown }).willRetry, true);
    assert.ok(
      records.slice(firstEnd).some((record) => record.type === "auto_retry_start"),
      "the retry should follow the agent_end that would have been mistaken for the end",
    );
    assert.equal(
      records.filter((record) => record.type === "agent_end").length,
      2,
      "there should be two agent_end records and one settle",
    );
    assert.equal(records.filter((record) => record.type === "agent_settled").length, 1);
  });
});

/**
 * **Trap 3.** Framing is strict LF-only. `JSON.stringify` emits U+2028 and U+2029
 * literally inside a string — they are legal there — and `node:readline` splits on
 * both, so a record containing either is torn into two malformed halves.
 */
describe("a record containing U+2028", () => {
  /** The captured success stream with the separators inside the assistant's text. */
  async function withSeparators(): Promise<{ text: string; records: unknown[] }> {
    const records = await recordsOf("settled-ok");
    let put = 0;
    for (const message of assistantMessagesIn(records)) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content as { type?: string; text?: string }[]) {
        if (part.type !== "text") continue;
        part.text = `before${lineSeparator}between${paragraphSeparator}after`;
        put += 1;
      }
    }
    assert.ok(put > 0, "the separators should have gone into the agent's own text");
    return { text: asStream(records), records };
  }

  it("parses as one record", async () => {
    const { text } = await withSeparators();

    // The stream has to actually carry the separators, or this pins nothing: it is
    // `JSON.stringify` leaving them literal that makes the trap reachable at all.
    assert.ok(text.includes(lineSeparator), "the stream should carry a literal U+2028");
    assert.ok(text.includes(paragraphSeparator), "the stream should carry a literal U+2029");

    assert.deepEqual(await outcomeOf(text), { ok: true });
    // Byte by byte too: U+2028 is three bytes, so a chunk boundary can fall inside it.
    assert.deepEqual(await outcomeOf(text, 1), { ok: true });
  });

  it("is torn in half by node:readline, which is why readline is not used", async () => {
    const { text, records } = await withSeparators();

    const lines: string[] = [];
    for await (const line of createInterface({ input: Readable.from([text]) })) {
      lines.push(line);
    }

    assert.ok(
      lines.length > records.length,
      `readline should produce more lines than there are records; it produced ${lines.length} for ${records.length}`,
    );
    assert.throws(() => {
      for (const line of lines) JSON.parse(line);
    });
  });
});

describe("output that cannot be read", () => {
  it("fails the Run when the stream ends without a settle", async () => {
    const records = await recordsOf("settled-ok");
    const withoutSettle = records.filter((record) => record.type !== "agent_settled");

    assert.match(await failureOf(asStream(withoutSettle)), /agent_settled/);
  });

  it("fails the Run when the stream is cut inside a record", async () => {
    const text = await fixture("settled-ok");

    assert.match(await failureOf(text.slice(0, text.length - 40)), /ended mid-record/);
  });

  it("fails the Run when a line is not a JSON object", async () => {
    const polluted = (await fixture("settled-ok")).replace(
      '{"type":"agent_start"}\n',
      '{"type":"agent_start"}\nEADDRINUSE: something else wrote to stdout\n',
    );

    assert.match(await failureOf(polluted), /EADDRINUSE/);
  });

  it("fails the Run when a record carries no type", async () => {
    const records = await recordsOf("settled-ok");
    records.splice(1, 0, { notAType: true });

    assert.match(await failureOf(asStream(records)), /type/);
  });

  it("fails the Run when there was no output at all", async () => {
    assert.match(await failureOf(""), /no output/);
  });

  it("fails the Run when it settled without the agent ever answering", async () => {
    const text = asStream([
      { type: "session", version: 3, id: "user_42", cwd: "/workspace" },
      { type: "agent_start" },
      { type: "agent_settled" },
    ]);

    assert.match(await failureOf(text), /no assistant message/);
  });

  it("reports a line it could not read even when the stream settled after it", async () => {
    // Precedence, and the reason it matters: a stream that could not be read
    // completely must not be reported as a success on the strength of the records
    // that did parse.
    assert.match(await failureOf(`not json at all\n${await fixture("settled-ok")}`), /not json/);
  });

  it("names the Session, which is what a reader produced per Run buys", async () => {
    // The Run's `error` column is the only thing an Operator has to go on, and until the
    // reader was made per Run it could not say which transcript to open. One
    // case rather than every one, because the name is prefixed in one place and a failure
    // that did not carry it would have to be written deliberately.
    assert.equal(
      await failureOf(""),
      `Session ${session} produced no output at all, so nothing says whether the Run happened`,
    );
  });
});
