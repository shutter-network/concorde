import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const siteRoot = path.join(repoRoot, "site");
const referenceRoot = path.join(siteRoot, "reference");

function run(command: string, args: string[], cwd: string, whenItFails: string): void {
  try {
    execFileSync(command, args, { cwd, stdio: "inherit" });
  } catch {
    console.error(`\n${whenItFails}\n`);
    process.exit(1);
  }
}

const PREFORMATTED_BLOCK = /<pre[^>]*>[\s\S]*?<\/pre>/g;

const HYPERLINK = /<a[\s>]/;

function generatedPages(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(referenceRoot);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".md") && name !== "index.md")
    .sort()
    .map((name) => path.join(referenceRoot, name));
}

function hasLinkedBlock(page: string): boolean {
  const markup = readFileSync(page, "utf8");
  return (markup.match(PREFORMATTED_BLOCK) ?? []).some((block) => HYPERLINK.test(block));
}

console.log("\n> installing the site's own dependency tree\n");
run("npm", ["ci", "--no-audit", "--no-fund"], siteRoot, "Could not install site dependencies.");

console.log("\n> regenerating site/reference from the doc comments\n");
run("npm", ["run", "generate"], siteRoot, "Reference generation failed.");

console.log("\n> checking that every page has a linked signature block\n");
const pages = generatedPages();
if (pages.length === 0) {
  console.error(`\nNo API pages generated in site/reference.\n`);
  process.exit(1);
}

const unlinked = pages.filter((page) => !hasLinkedBlock(page));
if (unlinked.length > 0) {
  console.error(
    `\nNo preformatted block on these pages contains a link:\n` +
      `${unlinked.map((page) => `  ${path.relative(repoRoot, page)}`).join("\n")}\n\n` +
      `Check the TypeDoc partial overrides in site/expanded-object-methods.mjs; an incompatible plugin version can disable signature links.\n`,
  );
  process.exit(1);
}
console.log(`${pages.length} pages, each with a linked signature block on it.`);

console.log("\n> building the site\n");
run("npm", ["run", "build"], siteRoot, "The site did not build. The log is above.");

console.log("\nEvery page in the reference has a linked signature block, and the site builds.\n");
