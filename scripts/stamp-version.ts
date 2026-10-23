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
