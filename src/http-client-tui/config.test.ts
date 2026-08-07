/**
 * What the client decides before it opens a socket, which is the one part of it a reader gets
 * wrong from a shell. Every case here is an argument list and an environment in, and one of the
 * three invocations out.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ClientConfig,
  defaultGatewayUrl,
  gatewayUrlVariable,
  passwordVariable,
  readInvocation,
} from "./config.ts";

const user = "0f4a1c2e-6b7d-4e8f-9a0b-1c2d3e4f5a6b";
const password = "correct horse battery staple";

/** An environment with both variables set, which the cases below vary one field of. */
const filled = { [gatewayUrlVariable]: "http://gateway:8080", [passwordVariable]: password };

/** The configuration, or a failure naming what came back instead. */
function configFrom(argv: readonly string[], env: Record<string, string>): ClientConfig {
  const invocation = readInvocation(argv, env);
  if (invocation.kind !== "run") assert.fail(`expected a run, and got ${invocation.kind}`);
  return invocation.config;
}

/** The reason, or a failure naming what came back instead. */
function refusalFrom(argv: readonly string[], env: Record<string, string>): string {
  const invocation = readInvocation(argv, env);
  if (invocation.kind !== "refused") assert.fail(`expected a refusal, and got ${invocation.kind}`);
  return invocation.reason;
}

describe("reading an invocation", () => {
  it("takes the User id from the one argument and the rest from the environment", () => {
    assert.deepEqual(configFrom([user], filled), {
      baseUrl: "http://gateway:8080",
      user,
      password,
    });
  });

  it("falls back to the local Gateway when no URL is written", () => {
    assert.equal(configFrom([user], { [passwordVariable]: password }).baseUrl, defaultGatewayUrl);
  });

  it("treats an empty variable as unset, which is what an unfilled .env line writes", () => {
    const env = { [gatewayUrlVariable]: "", [passwordVariable]: password };
    assert.equal(configFrom([user], env).baseUrl, defaultGatewayUrl);
    assert.match(refusalFrom([user], { [passwordVariable]: "" }), /SAF_PASSWORD is unset/);
  });

  it("refuses a run with no password rather than asking for one", () => {
    assert.match(refusalFrom([user], {}), /SAF_PASSWORD is unset/);
  });

  it("refuses a URL that is not http", () => {
    const env = { [gatewayUrlVariable]: "ws://gateway:8080", [passwordVariable]: password };
    assert.match(refusalFrom([user], env), /not an http or https URL/);
    const nonsense = { [gatewayUrlVariable]: "gateway:8080", [passwordVariable]: password };
    assert.match(refusalFrom([user], nonsense), /not an http or https URL/);
  });

  it("keeps a path on the base URL, since a Gateway can be served under a prefix", () => {
    const env = { [gatewayUrlVariable]: "https://example.test/saf", [passwordVariable]: password };
    assert.equal(configFrom([user], env).baseUrl, "https://example.test/saf");
  });

  it("refuses no argument and refuses two, one client being one person", () => {
    assert.match(refusalFrom([], filled), /no User id was written/);
    assert.match(refusalFrom([user, user], filled), /one User id is the whole argument list/);
  });

  it("refuses an option it does not have rather than reading it as a User id", () => {
    assert.match(refusalFrom(["--follow"], filled), /not an option of this client/);
  });

  it("answers the usage before it looks at the environment", () => {
    assert.equal(readInvocation(["--help"], {}).kind, "help");
    assert.equal(readInvocation(["-h"], {}).kind, "help");
    assert.equal(readInvocation([user, "--help"], {}).kind, "help");
  });
});
