import type { FastifyRequest } from "fastify";
import type { Auth, AuthOutcome } from "../gateway/auth.ts";

export type AuthScript = AuthOutcome | ((request: FastifyRequest) => AuthOutcome);

export type FakeAuth = Auth & {
  readonly asked: readonly FastifyRequest[];
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
      asked.push(request);
      return typeof answer === "function" ? answer(request) : answer;
    },
    async start() {},
    async stop() {},
  };
}
