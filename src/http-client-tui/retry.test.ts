/**
 * The waiting, with the wait taken out: `sleep` records what it was asked for and answers at once,
 * so a test states a backoff curve instead of living through it.
 *
 * What is worth pinning is which errors keep the loop going. A client that retried a 401 would ask
 * a Gateway the same wrong password until somebody stopped it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffFor, firstDelayMs, maxDelayMs, retrying } from "./retry.ts";

/** The only error this suite retries, standing in for "no answer arrived". */
class Refused extends Error {}

/** Fails `failures` times and then answers, counting the calls. */
function failing(failures: number, answer = "answered") {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    attempt: async () => {
      calls += 1;
      if (calls <= failures) throw new Refused(`refused ${calls}`);
      return answer;
    },
  };
}

/** A sleep that records and returns, so the delays are the assertion. */
function recording() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

const retryable = (error: unknown) => error instanceof Refused;

describe("backoff", () => {
  it("doubles from the first delay and stops at the cap", () => {
    assert.equal(backoffFor(1), firstDelayMs);
    assert.equal(backoffFor(2), firstDelayMs * 2);
    assert.equal(backoffFor(3), firstDelayMs * 4);
    assert.equal(backoffFor(40), maxDelayMs);
  });
});

describe("retrying", () => {
  it("makes one attempt when the first one answers", async () => {
    const { slept, sleep } = recording();
    const subject = failing(0);
    assert.equal(await retrying(subject.attempt, { retryable, sleep }), "answered");
    assert.equal(subject.calls, 1);
    assert.deepEqual(slept, []);
  });

  it("waits longer between each failure and answers when one succeeds", async () => {
    const { slept, sleep } = recording();
    const subject = failing(3);
    assert.equal(await retrying(subject.attempt, { retryable, sleep }), "answered");
    assert.equal(subject.calls, 4);
    assert.deepEqual(slept, [250, 500, 1000]);
  });

  it("has no attempt limit, the Gateway being what it is waiting for", async () => {
    const { slept, sleep } = recording();
    const subject = failing(200);
    await retrying(subject.attempt, { retryable, sleep });
    assert.equal(subject.calls, 201);
    assert.equal(slept.at(-1), maxDelayMs);
  });

  it("throws anything the predicate rejects, without waiting", async () => {
    const { slept, sleep } = recording();
    let calls = 0;
    await assert.rejects(
      retrying(
        async () => {
          calls += 1;
          throw new Error("401");
        },
        { retryable, sleep },
      ),
      /401/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
  });

  it("stops when the sleep refuses, which is how a shutdown ends a wait", async () => {
    const subject = failing(5);
    await assert.rejects(
      retrying(subject.attempt, {
        retryable,
        sleep: async () => {
          throw new Error("this client is shutting down");
        },
      }),
      /shutting down/,
    );
    assert.equal(subject.calls, 1);
  });

  it("says what it is about to wait for, once per failure", async () => {
    const { sleep } = recording();
    const announced: string[] = [];
    await retrying(failing(2).attempt, {
      retryable,
      sleep,
      waiting: (error, attempt, delayMs) =>
        void announced.push(`${(error as Error).message} ${attempt} ${delayMs}`),
    });
    assert.deepEqual(announced, ["refused 1 1 250", "refused 2 2 500"]);
  });
});
