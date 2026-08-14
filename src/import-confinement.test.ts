/**
 * The libraries that belong to one component each, and the lint rule that says so — asked of
 * Biome rather than read out of `biome.json`.
 *
 * Three libraries are confined to the directories that own them: `pg` to the Db, `jose` to
 * Signatures, and the two Nostr libraries to the two parts that speak that protocol, the Nostr
 * Channel and Nostr Auth. The rule is the whole enforcement, and nothing else in the repository
 * notices a further part reaching for one, so a rule that quietly stopped firing would leave every
 * one of those decisions written down and unenforced.
 *
 * **A directory excluded here is excluded for all three libraries**, which is the recorded cost of
 * the single entry below: `src/nostr-auth/**` may import `pg` and `jose` too, and nothing but
 * review notices.
 *
 * **That is not hypothetical, and it is why this file exists rather than a comment.** Two ways of
 * silently disabling it were found while adding the third confinement, and neither says anything
 * on the console:
 *
 *  - **A second `overrides` entry.** Biome applies the *last* matching override for a rule and
 *    replaces the whole configuration rather than merging it, so `pg` in one override and `jose`
 *    in a second left only `jose` live. `pg` had been unenforced everywhere outside `src/db/**`
 *    since the day the second override landed.
 *  - **A comment in `biome.json`.** One `//` line anywhere in that file and the overrides stop
 *    taking effect, with no parse error and no warning.
 *
 * So the confinements are asserted the only way that can catch either: by running the real Biome
 * over a file at a real path and reading what it says. A probe is written into the tree, checked,
 * and removed again — `--stdin-file-path` was tried first and reports no lint diagnostics at all,
 * and the rule is path-dependent, so the path has to be real.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const biome = path.join(repoRoot, "node_modules", ".bin", "biome");

/** Where a probe is written: a directory of this file's own, so nothing real is disturbed. */
const probeDirectory = "confinement-probe";

/**
 * What each library is, and which directory is allowed to import it.
 *
 * The specifiers are the ones the framework actually writes, subpaths included: `nostr-tools`
 * ships forty of them and the component imports two, so a rule that only named the bare package
 * would let `nostr-tools/nip44` through.
 */
const confinements = [
  { library: "pg", specifier: "pg", owner: "db" },
  { library: "jose", specifier: "jose", owner: "signatures" },
  { library: "nostr-tools", specifier: "nostr-tools", owner: "nostr-channel" },
  { library: "nostr-tools/core", specifier: "nostr-tools/core", owner: "nostr-channel" },
  { library: "nostr-tools/pure", specifier: "nostr-tools/pure", owner: "nostr-channel" },
  { library: "nostr-tools/nip17", specifier: "nostr-tools/nip17", owner: "nostr-channel" },
  { library: "nostr-tools/nip44", specifier: "nostr-tools/nip44", owner: "nostr-channel" },
  { library: "@nostrify/nostrify", specifier: "@nostrify/nostrify", owner: "nostr-channel" },
  // The second component that speaks Nostr, and the reason the entry's message no longer says
  // the Channel's alone. `nip98` is imported by that component's own test and by nothing it
  // ships: the library's validator is what the by-hand checks are written against, and the test
  // asserts it accepts a credential the component refuses.
  { library: "nostr-tools/core", specifier: "nostr-tools/core", owner: "nostr-auth" },
  { library: "nostr-tools/pure", specifier: "nostr-tools/pure", owner: "nostr-auth" },
  { library: "nostr-tools/nip98", specifier: "nostr-tools/nip98", owner: "nostr-auth" },
] as const;

/**
 * Whether Biome refuses an import of `specifier` from a file at `directory`.
 *
 * The probe is a whole file at a real path, because `includes` matches on the path. It is removed
 * whether the check passed or threw; one left behind by a crash fails `npm run lint` loudly on
 * the next run, which is the right way round.
 */
function refusesImport(directory: string, specifier: string): boolean {
  const probe = path.join(repoRoot, directory, probeDirectory, "probe.ts");
  mkdirSync(path.dirname(probe), { recursive: true });
  writeFileSync(probe, `import * as library from "${specifier}";\nexport const used = library;\n`);
  try {
    // `biome lint` rather than `check`, so an unformatted probe cannot be mistaken for a refusal.
    // It exits non-zero when it finds anything and writes the diagnostics to **stderr**, keeping
    // stdout for the summary — so both streams are captured and both are read.
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
    // A fake Relay that a real client will talk to has to speak the real protocol, and proving it
    // is a Relay means driving it with the real client. So `src/test-support/**` is exempt too,
    // and this is what says that is deliberate rather than an accident of the glob.
    assert.equal(refusesImport(path.join("src", "test-support"), "@nostrify/nostrify"), false);
    assert.equal(refusesImport(path.join("src", "test-support"), "nostr-tools/pure"), false);
  });
});
