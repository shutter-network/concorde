/**
 * The one part of the terminal with a decision in it. The escape sequences and the readline
 * plumbing beside it are driven by a person and observed by a person, and a test that asserted the
 * bytes would pin the implementation rather than the behaviour.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageRecord } from "../messenger/messages.ts";
import { formatMessage } from "./terminal.ts";

function record(fields: Partial<MessageRecord>): MessageRecord {
  return {
    id: "9c8b7a6d-5e4f-4a3b-8c1d-2e3f4a5b6c7d",
    userId: "0f4a1c2e-6b7d-4e8f-9a0b-1c2d3e4f5a6b",
    direction: "inbound",
    seq: 1,
    text: "the deploy finished",
    createdAt: "2030-06-01T09:07:00.000Z",
    ...fields,
  };
}

describe("formatting a Message", () => {
  it("names the speaker, the Gateway's own clock, and what was said", () => {
    assert.equal(formatMessage(record({})), "you   09:07  the deploy finished");
    assert.equal(
      formatMessage(record({ direction: "outbound", text: "it did" })),
      "agent 09:07  it did",
    );
  });

  it("lines the two speakers up, so the text starts in one column", () => {
    const [you, agent] = [
      formatMessage(record({})),
      formatMessage(record({ direction: "outbound" })),
    ];
    assert.equal(you.indexOf("the deploy"), agent.indexOf("the deploy"));
  });
});
