import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after } from "node:test";
import type { Logger } from "../logging/index.ts";
import { createOpenClawRuntime, type OpenClawDaemon } from "../openclaw/runtime.ts";
import type { RunOutcome, Runtime } from "../signals/runtime.ts";
import { type FakeDaemon, type FakeDaemonOptions, startFakeDaemon } from "./openclaw-daemon.ts";

export const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// The scripted daemon accepts any device key with a valid challenge signature.
export const deviceKey = generateKeyPairSync("ed25519").privateKey;

const running: FakeDaemon[] = [];

after(async () => {
  await Promise.all(running.map((daemon) => daemon.close()));
});

export async function daemonOf(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  const daemon = await startFakeDaemon(options);
  running.push(daemon);
  return daemon;
}

export function runtimeFor(daemon: FakeDaemon, extra: Partial<OpenClawDaemon> = {}): Runtime {
  return createOpenClawRuntime({
    url: daemon.url,
    token: daemon.token,
    deviceKey,
    logger: silent,
    ...extra,
  });
}

export function failure(outcome: RunOutcome): string {
  assert.equal(outcome.ok, false, `this Run should have failed; it was ${JSON.stringify(outcome)}`);
  return outcome.ok ? "" : outcome.error;
}
