/**
 * An Auth that answers what a test told it to, and records what it was asked.
 *
 * The aggregate's whole subject is the walk: the order the schemes are asked in, where it stops,
 * what the refusal looks like on the wire, and what happens with nothing registered. A real Auth
 * would drag scrypt or a NIP-98 signature through every one of those assertions and prove none of
 * them better. It exists for the reason `fake-runtime.ts` and `fake-container.ts` do.
 *
 * It does not register itself, where a real Auth registers at the end of its own constructor. A
 * test that calls `registerAuth` by hand is a test whose registration order is a line the reader
 * can see, which is the property most of these assertions are about.
 */

import type { FastifyRequest } from "fastify";
import type { Auth, AuthOutcome } from "../gateway/auth.ts";

/** What the Auth should answer about one request. A value, or a function of the request. */
export type AuthScript = AuthOutcome | ((request: FastifyRequest) => AuthOutcome);

export type FakeAuth = Auth & {
  /**
   * Every request it was asked about, in the order the walk reached it.
   *
   * Empty is the assertion that matters most: the walk stops at the first refusal, so the Auth
   * behind one was never asked.
   */
  readonly asked: readonly FastifyRequest[];
  /** What it answers from now on, so one Auth can refuse in one test and admit in the next. */
  answers(script: AuthScript): void;
};

export function fakeAuth(scheme: string, script: AuthScript = { kind: "absent" }): FakeAuth {
  const asked: FastifyRequest[] = [];
  let answer = script;

  return {
    scheme,
    asked,
    answers(next) {
      answer = next;
    },
    async authenticate(request) {
      // The whole request, kept as it arrived: an Auth is given one so that a credential anywhere
      // in it is expressible, and a test asserting that reads the headers back off this.
      asked.push(request);
      return typeof answer === "function" ? answer(request) : answer;
    },
    async start() {},
    async stop() {},
  };
}
