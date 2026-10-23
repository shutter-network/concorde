import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const biome = path.join(repoRoot, "node_modules", ".bin", "biome");

const probeDirectory = "confinement-probe";

const confinements = [
  { library: "pg", specifier: "pg", owner: "db" },
  { library: "jose", specifier: "jose", owner: "signatures" },
  { library: "nostr-tools", specifier: "nostr-tools", owner: "nostr-channel" },
  { library: "nostr-tools/core", specifier: "nostr-tools/core", owner: "nostr-channel" },
  { library: "nostr-tools/pure", specifier: "nostr-tools/pure", owner: "nostr-channel" },
  { library: "nostr-tools/nip17", specifier: "nostr-tools/nip17", owner: "nostr-channel" },
  { library: "nostr-tools/nip44", specifier: "nostr-tools/nip44", owner: "nostr-channel" },
  { library: "@nostrify/nostrify", specifier: "@nostrify/nostrify", owner: "nostr-channel" },
  { library: "nostr-tools/core", specifier: "nostr-tools/core", owner: "nostr-auth" },
  { library: "nostr-tools/pure", specifier: "nostr-tools/pure", owner: "nostr-auth" },
  { library: "nostr-tools/nip98", specifier: "nostr-tools/nip98", owner: "nostr-auth" },
] as const;

function refusesImport(directory: string, specifier: string): boolean {
  const probe = path.join(repoRoot, directory, probeDirectory, "probe.ts");
  mkdirSync(path.dirname(probe), { recursive: true });
  writeFileSync(probe, `import * as library from "${specifier}";\nexport const used = library;\n`);
  try {
    let output: string;
    try {
      output = execFileSync(biome, ["lint", probe], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error as { stdout?: unknown; stderr?: unknown };
      output = `${String(failure.stdout ?? "")}${String(failure.stderr ?? "")}`;
    }
    return output.includes("lint/style/noRestrictedImports");
  } finally {
    rmSync(path.dirname(probe), { recursive: true, force: true });
  }
}

describe("a library confined to the component that owns it", () => {
  for (const { library, specifier, owner } of confinements) {
    it(`is refused outside src/${owner}/, so nothing else can reach for ${library}`, () => {
      assert.equal(
        refusesImport("src", specifier),
        true,
        `importing ${specifier} from src/ should be refused; it is ${owner}'s alone`,
      );
    });

    it(`is allowed inside src/${owner}/, which is the component that needs ${library}`, () => {
      assert.equal(
        refusesImport(path.join("src", owner), specifier),
        false,
        `${owner} cannot do its job without ${specifier}`,
      );
    });
  }

  it("lets the test support import the Nostr libraries, because the fake Relay is one", () => {
    assert.equal(refusesImport(path.join("src", "test-support"), "@nostrify/nostrify"), false);
    assert.equal(refusesImport(path.join("src", "test-support"), "nostr-tools/pure"), false);
  });
});
