/**
 * The Session-name grammar, checked directly as well as through the worker.
 *
 * It is here rather than only in `core.test.ts` because the interesting cases are
 * about the grammar itself and need no database, and because the colon case is the
 * one an Operator will get wrong: `user:42` is the obvious spelling of "this User's
 * Session" and the Agent Runtime rejects it (ADR-0024).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSessionName, isValidSessionName } from "./handlers.ts";

describe("a Session name", () => {
  it("accepts the shapes the Agent Runtime accepts", () => {
    for (const name of ["user_42", "a", "0", "a.b-c_d", "Session.1-2_3", "9z"]) {
      assert.equal(isValidSessionName(name), true, `${name} should be valid`);
    }
  });

  it("rejects a colon, which is the spelling everyone reaches for first", () => {
    assert.equal(isValidSessionName("user:42"), false);
  });

  it("rejects the other shapes outside the grammar", () => {
    for (const name of [
      "",
      "_user",
      "user_",
      ".user",
      "user.",
      "-user",
      "a b",
      "user/42",
      "üser",
    ]) {
      assert.equal(isValidSessionName(name), false, `${name} should be invalid`);
    }
  });
});

describe("assertSessionName", () => {
  it("passes a valid name and a fresh Session", () => {
    assertSessionName({ session: "user_42", text: "hello" });
    assertSessionName({ session: null, text: "hello" });
  });

  it("names the value it rejected, so the Operator can find it", () => {
    assert.throws(() => assertSessionName({ session: "user:42", text: "hello" }), /user:42/);
  });
});
