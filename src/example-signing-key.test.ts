import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const keyFile = new URL(
  "../examples/02_decisions/insecure-example-only-signing-key.pem",
  import.meta.url,
);

const nostrEnvFile = new URL("../examples/03_nostr/.env.example", import.meta.url);

function fromEnvExample(file: URL, name: string): string {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key?.trim() === name) return rest.join("=").trim();
  }
  assert.fail(`${name} is not in ${file.pathname}`);
}

describe("02_decisions' committed signing key", () => {
  it("loads through createPrivateKey the way the entry point loads it", () => {
    const key = createPrivateKey(readFileSync(keyFile));
    assert.equal(key.type, "private");
  });

  it("is the Ed25519 key the deployment derives its algorithm from", () => {
    const key = createPrivateKey(readFileSync(keyFile));
    assert.equal(key.asymmetricKeyType, "ed25519");
  });
});

describe("03_nostr's committed Nostr secret", () => {
  it("decodes to the 32 raw bytes the Channel is constructed with", () => {
    const secret = Buffer.from(fromEnvExample(nostrEnvFile, "NOSTR_AGENT_SECRET_KEY"), "hex");
    assert.equal(secret.length, 32);
  });
});
