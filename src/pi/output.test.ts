import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { RunOutcome } from "../signals/runtime.ts";
import { type Framed, framedRecords } from "./framing.ts";
import { readOutcome } from "./output.ts";

const lineSeparator = "\u2028";
const paragraphSeparator = "\u2029";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8");
}

async function recordsOf(name: string): Promise<Record<string, unknown>[]> {
  const text = await fixture(name);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function asStream(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

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

function chunks(text: string, size: number): AsyncIterable<Uint8Array> {
  const bytes = Buffer.from(text, "utf8");
  return (async function* () {
    for (let at = 0; at < bytes.length; at += size) {
      yield bytes.subarray(at, at + size);
    }
  })();
}

const session = "user_42";

async function outcomeOf(text: string, chunkSize = 4096): Promise<RunOutcome> {
  return readOutcome(framedRecords(chunks(text, chunkSize)), session);
}

async function failureOf(text: string, chunkSize = 4096): Promise<string> {
  const outcome = await outcomeOf(text, chunkSize);
  assert.equal(
    outcome.ok,
    false,
    `this output should fail the Run; it was ${JSON.stringify(outcome)}`,
  );
  return outcome.ok ? "" : outcome.error;
}

function withoutUsage({ usage: _, ...rest }: RunOutcome): Omit<RunOutcome, "usage"> {
  return rest;
}

describe("a settled run", () => {
  it("is a successful Run", async () => {
    assert.deepEqual(withoutUsage(await outcomeOf(await fixture("settled-ok"))), { ok: true });
  });

  it("reads the same however the bytes arrive, one byte at a time included", async () => {
    const text = await fixture("settled-ok");
    for (const size of [1, 2, 3, 7, 64, 1_000_000]) {
      assert.deepEqual(
        withoutUsage(await outcomeOf(text, size)),
        { ok: true },
        `chunks of ${size} bytes`,
      );
    }
  });

  it("ignores whatever follows the settle, so the first one is terminal", async () => {
    const records = await recordsOf("settled-ok");
    records.push({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "after the settle" },
    });

    assert.deepEqual(withoutUsage(await outcomeOf(asStream(records))), { ok: true });
  });

  it("returns at the settle rather than reading to the end of the stream", async () => {
    const records = await recordsOf("settled-ok");
    const settleAt = records.findIndex((record) => record.type === "agent_settled");
    assert.notEqual(settleAt, -1);
    const trailing = [{ type: "turn_start" }, { type: "turn_end" }, { type: "agent_start" }];

    let pulled = 0;
    const framed = framedRecords(chunks(asStream([...records, ...trailing]), 4096));
    const counted: AsyncIterator<Framed> = {
      next() {
        pulled += 1;
        return framed.next();
      },
    };

    assert.deepEqual(withoutUsage(await readOutcome(counted, session)), { ok: true });
    assert.equal(
      pulled,
      settleAt + 1,
      "the reader should have pulled the settle and stopped there",
    );
  });
});

describe("a model error the agent reports as an ordinary settle", () => {
  it("is a failed Run carrying the error", async () => {
    const error = await failureOf(await fixture("model-error-exit-zero"));

    assert.match(error, /mock provider rejected the request/);
    assert.match(error, /stopReason/);
  });

  it("is announced nowhere but inside the assistant message", async () => {
    const records = await recordsOf("model-error-exit-zero");

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
    assert.deepEqual(withoutUsage(await outcomeOf(await settledWith("length", undefined))), {
      ok: true,
    });
  });
});

async function settledWith(stopReason: string, errorMessage: string | undefined): Promise<string> {
  const records = await recordsOf("settled-ok");
  for (const message of assistantMessagesIn(records)) {
    message.stopReason = stopReason;
    if (errorMessage !== undefined) message.errorMessage = errorMessage;
  }
  return asStream(records);
}

describe("an agent_end followed by a retry", () => {
  it("is not the end: the Run is finished at the settle, and it succeeded", async () => {
    assert.deepEqual(withoutUsage(await outcomeOf(await fixture("retry-then-settled"))), {
      ok: true,
    });
  });

  it("carries the opposite outcome at the first agent_end, which is not read as the end", async () => {
    const records = await recordsOf("retry-then-settled");
    const firstEnd = records.findIndex((record) => record.type === "agent_end");
    assert.notEqual(firstEnd, -1);

    const upToFirstEnd = records.slice(0, firstEnd + 1);
    const answer = assistantMessagesIn(upToFirstEnd).at(-1);
    assert.equal(answer?.stopReason, "error");
    assert.match(String(answer?.errorMessage), /rate limited/);

    assert.match(await failureOf(asStream(upToFirstEnd)), /without agent_settled/);

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

describe("a record containing U+2028", () => {
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

    assert.ok(text.includes(lineSeparator), "the stream should carry a literal U+2028");
    assert.ok(text.includes(paragraphSeparator), "the stream should carry a literal U+2029");

    assert.deepEqual(withoutUsage(await outcomeOf(text)), { ok: true });
    assert.deepEqual(withoutUsage(await outcomeOf(text, 1)), { ok: true });
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

  it("fails the Run when the agent said nothing at all", async () => {
    assert.match(await failureOf(""), /No records received/);
  });

  it("fails the Run when it settled without the agent ever answering", async () => {
    const text = asStream([
      { type: "session", version: 3, id: "user_42", cwd: "/workspace" },
      { type: "agent_start" },
      { type: "agent_settled" },
    ]);

    assert.match(await failureOf(text), /without an assistant message/);
  });

  it("reports a line it could not read even when the stream settled after it", async () => {
    assert.match(await failureOf(`not json at all\n${await fixture("settled-ok")}`), /not json/);
  });

  it("names the Session, which is what a reader produced per Run buys", async () => {
    assert.equal(
      await failureOf(""),
      `Session ${session}: No records received after the prompt was accepted; completion is unknown`,
    );
  });
});

function assistantEnd(usage: Record<string, unknown>, stopReason = "toolUse"): unknown {
  return {
    type: "message_end",
    message: { role: "assistant", provider: "mock", model: "mock-1", stopReason, usage },
  };
}

const spent = {
  input: 100,
  output: 20,
  cacheRead: 300,
  cacheWrite: 5,
  totalTokens: 425,
  cost: { total: 0.25 },
};

describe("the usage a Run reports", () => {
  it("reports each model call once, a failed attempt before a retry included", async () => {
    const outcome = await outcomeOf(await fixture("retry-then-settled"));

    assert.equal(outcome.ok, true);
    assert.deepEqual(
      outcome.usage.map((report) => [report.provider, report.model, report.totalTokens]),
      [
        ["mock", "mock-1", 0],
        ["mock", "mock-1", 18],
      ],
      "two attempts, each reported once although turn_end and agent_end repeat them",
    );
    assert.deepEqual(outcome.usage[1], {
      provider: "mock",
      model: "mock-1",
      input: 11,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: 0,
    });
  });

  it("carries every category, the cost, and a total it sums itself", async () => {
    const { usage } = await outcomeOf(
      asStream([assistantEnd({ ...spent, totalTokens: 1 }, "stop"), { type: "agent_settled" }]),
    );

    assert.deepEqual(usage, [
      {
        provider: "mock",
        model: "mock-1",
        input: 100,
        output: 20,
        cacheRead: 300,
        cacheWrite: 5,
        totalTokens: 425,
        cost: 0.25,
      },
    ]);
  });

  it("reports a compaction, naming the model the Run last used", async () => {
    const { usage } = await outcomeOf(
      asStream([
        assistantEnd(spent),
        { type: "compaction_start", reason: "threshold" },
        {
          type: "compaction_end",
          reason: "threshold",
          result: { summary: "…", usage: { input: 900, output: 60, cacheRead: 0, cacheWrite: 0 } },
          aborted: false,
          willRetry: false,
        },
        assistantEnd(spent, "stop"),
        { type: "agent_settled" },
      ]),
    );

    assert.equal(usage.length, 3);
    assert.deepEqual(usage[1], {
      provider: "mock",
      model: "mock-1",
      input: 900,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 960,
      cost: 0,
    });
  });

  it("reports nothing for a user message, or a message with no usage", async () => {
    const { usage } = await outcomeOf(
      asStream([
        { type: "message_end", message: { role: "user", usage: spent } },
        { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
        { type: "agent_settled" },
      ]),
    );

    assert.deepEqual(usage, []);
  });

  it("counts a negative or fractional figure as nothing", async () => {
    const { usage } = await outcomeOf(
      asStream([
        assistantEnd({ input: -5, output: 2.5, cacheRead: "9", cacheWrite: 1 }, "stop"),
        { type: "agent_settled" },
      ]),
    );

    assert.equal(usage[0]?.totalTokens, 1);
  });

  it("returns the calls that finished before a Run failed", async () => {
    const settled = await outcomeOf(
      asStream([assistantEnd(spent), assistantEnd(spent, "error"), { type: "agent_settled" }]),
    );
    const cut = await outcomeOf(asStream([assistantEnd(spent), { type: "agent_start" }]));

    for (const outcome of [settled, cut]) {
      assert.equal(outcome.ok, false);
    }
    assert.equal(settled.usage.length, 2, "the failed call is charged too");
    assert.equal(cut.usage.length, 1, "a stream that ended early keeps what it reported");
  });
});

describe("a Run with a usage limit", () => {
  async function limitedTo(
    text: string,
    usageLimit: number,
  ): Promise<{ outcome: RunOutcome; aborts: number }> {
    let aborts = 0;
    const outcome = await readOutcome(framedRecords(chunks(text, 4096)), session, {
      abort: () => {
        aborts += 1;
      },
      usageLimit,
    });
    return { outcome, aborts };
  }

  const threeCalls = asStream([
    assistantEnd(spent),
    assistantEnd(spent),
    assistantEnd(spent, "aborted"),
    { type: "agent_settled" },
  ]);

  it("aborts once the call that crossed the limit ends, and fails as limited", async () => {
    const { outcome, aborts } = await limitedTo(threeCalls, 800);

    assert.equal(aborts, 1);
    assert.deepEqual(withoutUsage(outcome), {
      ok: false,
      error: `Session ${session}: Usage limit reached: 850 of 800 tokens`,
      limited: true,
    });
    assert.equal(outcome.usage.length, 3, "a call that finished after the abort is charged too");
  });

  it("lets a Run that reaches the limit exactly, or stays under it, finish as before", async () => {
    const stream = asStream([
      assistantEnd(spent),
      assistantEnd(spent, "stop"),
      { type: "agent_settled" },
    ]);
    for (const usageLimit of [850, 1_000_000]) {
      const { outcome, aborts } = await limitedTo(stream, usageLimit);
      assert.deepEqual(withoutUsage(outcome), { ok: true });
      assert.equal(aborts, 0);
    }
  });

  it("adds a failed attempt and its retry together", async () => {
    const { outcome, aborts } = await limitedTo(await fixture("retry-then-settled"), 17);

    assert.equal(aborts, 1);
    assert.match(failureIn(outcome), /Usage limit reached: 18 of 17 tokens/);
  });

  it("counts compaction toward the limit", async () => {
    const { outcome } = await limitedTo(
      asStream([
        assistantEnd(spent),
        {
          type: "compaction_end",
          result: { usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 } },
        },
        assistantEnd(spent, "stop"),
        { type: "agent_settled" },
      ]),
      900,
    );

    assert.match(failureIn(outcome), /925 of 900/);
  });

  it("stays limited when the stream ends before pi settles", async () => {
    const { outcome } = await limitedTo(asStream([assistantEnd(spent), assistantEnd(spent)]), 800);

    assert.match(failureIn(outcome), /without agent_settled/);
    assert.equal(outcome.ok === false && outcome.limited, true);
  });
});

function failureIn(outcome: RunOutcome): string {
  assert.equal(outcome.ok, false, `this Run should have failed; it was ${JSON.stringify(outcome)}`);
  return outcome.ok ? "" : outcome.error;
}
