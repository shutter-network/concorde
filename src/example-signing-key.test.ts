/**
 * The reference deployment's committed signing key loads as committed.
 *
 * `example/` ships a throwaway PKCS8 private key so that `docker compose up` comes up from a
 * fresh clone with no manual signing-key step, and the key's whole safety is that it is a decoy
 * marked worthless at every point of contact: its filename, `compose.yml`, `main.ts` and the
 * quickstart (07, ADR-0041). None of that marking may go *inside* the PEM in a way that stops it
 * parsing: a comment that breaks the loader is a worse outcome than no comment, and the entry
 * point loads this exact file with `createPrivateKey(readFileSync(path))`. So this test loads it
 * the same way and pins that it is a private key of the type the deployment expects. It is placed
 * under `src/` rather than in `example/` because the framework's own test runner (`npm run check`)
 * is what must execute it, and the file is read by a relative path from `import.meta.url`,
 * which resolves to the checkout's `example/` whether the marking stays beside the key or ever
 * moves into it.
 */

import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const keyFile = new URL("../example/insecure-example-only-signing-key.pem", import.meta.url);

describe("the committed example signing key", () => {
  it("loads through createPrivateKey the way the entry point loads it", () => {
    const key = createPrivateKey(readFileSync(keyFile));
    assert.equal(key.type, "private");
  });

  it("is the Ed25519 key the reference deployment derives its algorithm from", () => {
    const key = createPrivateKey(readFileSync(keyFile));
    // Ed25519 fixes `alg` to EdDSA with no choice to make, so the deployment passes no
    // `signingAlg` and Signatures derives it (ADR-0044). A different key type here would be a
    // silent change to what the quickstart's offline verification has to do.
    assert.equal(key.asymmetricKeyType, "ed25519");
  });
});
