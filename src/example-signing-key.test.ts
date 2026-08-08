/**
 * The committed key material two examples ship parses the way those examples parse it.
 *
 * Both keys exist so that `docker compose up` comes up from a fresh clone with no generation
 * step, and the whole safety of each is that it is a decoy marked worthless at every point of
 * contact (ADR-0041). None of that marking may go *inside* the key in a way that stops it
 * parsing: a comment that breaks the loader is a worse outcome than no comment. So each case
 * below reads the committed bytes exactly as the example's `main.ts` reads them, and pins what
 * the deployment then depends on.
 *
 * Both cases are placed under `src/` rather than beside the key, because the framework's own test
 * runner (`npm run check`) is what must execute them, and each file is read by a relative path
 * from `import.meta.url`, which resolves to the checkout's copy whether the marking stays beside
 * the key or ever moves into it.
 */

import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const keyFile = new URL(
  "../examples/02_decisions/insecure-example-only-signing-key.pem",
  import.meta.url,
);

const nostrEnvFile = new URL("../examples/03_nostr/.env.example", import.meta.url);

/** One `NAME=value` out of a committed `.env.example`, read the way compose reads it. */
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
    // Ed25519 fixes `alg` to EdDSA with no choice to make, so the deployment passes no
    // `signingAlg` and Signatures derives it (ADR-0044). A different key type here would be a
    // silent change to what the README's offline verification has to do.
    assert.equal(key.asymmetricKeyType, "ed25519");
  });
});

describe("03_nostr's committed Nostr secret", () => {
  it("decodes to the 32 raw bytes the Channel is constructed with", () => {
    // Not a PEM and not loaded by `createPrivateKey`: the framework parses no key material, so
    // `main.ts` does `Buffer.from(hex, "hex")` itself and hands the Channel 32 raw bytes.
    //
    // That call is the silent failure this case exists for. `Buffer.from` with "hex" stops at
    // the first character that is not a hex digit and returns what it had, throwing nothing, so
    // one typo in the committed value yields a short key and a Channel that signs under a public
    // key nobody wrote to. The length is the assertion because the length is what nothing else
    // checks.
    const secret = Buffer.from(fromEnvExample(nostrEnvFile, "NOSTR_AGENT_SECRET_KEY"), "hex");
    assert.equal(secret.length, 32);
  });
});
