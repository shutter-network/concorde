/**
 * Writes the version in `package.json` into the `describedVersion` literal in
 * `src/gateway/gateway.ts`, and stages the file.
 *
 * **npm's `version` lifecycle is what runs this, and the order it runs in is the whole design.**
 * `npm version patch` refuses a dirty tree, writes the new version into the manifest, runs this,
 * and only then commits the index and tags it. So reading the manifest here reads the new number,
 * and the `git add` below puts the source in the release commit rather than in a commit somebody
 * has to remember. `npm publish` builds after that, so `dist` announces what the tag announces.
 *
 * The two separated twice in three releases before this existed: `0.1.0` shipped announcing
 * `0.0.0` and `0.3.0` shipped announcing `0.2.0`. Each was corrected in `src` one commit later and
 * neither was corrected on npm, so both artifacts still serve the wrong number under ADR-0040,
 * where that document is the API documentation. `gateway.test.ts` holds the literal against the
 * manifest and is the backstop rather than the guard: `prepublishOnly` builds and does not test,
 * so what that test does is fail `npm run check` on `main` after the publish, which is what it did
 * both times.
 *
 * It reads `package.json` from disk rather than `npm_new_version`, so that it is also the answer
 * to a version edited into the manifest by hand: `node scripts/stamp-version.ts`.
 *
 * **The literal is matched by its whole declaration and anything but one match fails the run.**
 * Renamed or reformatted, the alternative is a stamp that writes nothing, says so to nobody, and
 * leaves the release announcing the version before it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = path.join(repoRoot, "package.json");
const sourcePath = path.join(repoRoot, "src", "gateway", "gateway.ts");

const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = (manifest as { version?: string }).version;
if (!version) {
  console.error(`\nNo version in ${manifestPath}.\n`);
  process.exit(1);
}

const declaration = /^export const describedVersion = "[^"]*";$/gm;
const source = readFileSync(sourcePath, "utf8");
const found = [...source.matchAll(declaration)];
if (found.length !== 1) {
  console.error(
    `\nExpected one \`export const describedVersion = "…";\` in ${sourcePath}, found ` +
      `${found.length}. Nothing was written. The declaration this stamps is matched whole, so a ` +
      `rename or a reformat has to be answered here.\n`,
  );
  process.exit(1);
}

writeFileSync(
  sourcePath,
  source.replace(declaration, `export const describedVersion = "${version}";`),
);
execFileSync("git", ["add", sourcePath], { cwd: repoRoot, stdio: "inherit" });
console.log(`describedVersion is "${version}", staged.`);
