import assert from "node:assert/strict";
import { test } from "node:test";
import { scaffoldCheck } from "./index.ts";
import { piScaffoldCheck } from "./pi/index.ts";

// These exist to prove the runner is wired, not to test anything. They go when
// the placeholders they call go.
test("the root subpath is importable from a test", () => {
  assert.equal(scaffoldCheck(), "ok");
});

test("the /pi subpath is importable from a test", () => {
  assert.equal(piScaffoldCheck(), "ok");
});
