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
run(
  "npm",
  ["ci", "--no-audit", "--no-fund"],
  siteRoot,
  "Installing site/node_modules failed. Nothing below could run.",
);

console.log("\n> regenerating site/reference from the doc comments\n");
run("npm", ["run", "generate"], siteRoot, "TypeDoc failed. There are no pages to read.");

console.log("\n> checking that every page has a linked signature block\n");
const pages = generatedPages();
if (pages.length === 0) {
  console.error(
    `\nTypeDoc wrote no page into site/reference, so there is nothing to check and a pass ` +
      `here would mean nothing.\n`,
  );
  process.exit(1);
}

const unlinked = pages.filter((page) => !hasLinkedBlock(page));
if (unlinked.length > 0) {
  console.error(
    `\nNo preformatted block on these pages contains a link:\n` +
      `${unlinked.map((page) => `  ${path.relative(repoRoot, page)}`).join("\n")}\n\n` +
      `A page renders that way when the renderer in site/expanded-object-methods.mjs is no ` +
      `longer wired into the partials it overrides by name, so the plugin's own fenced blocks ` +
      `are written instead: correctly coloured, entirely unlinked, and impossible to click.\n`,
  );
  process.exit(1);
}
console.log(`${pages.length} pages, each with a linked signature block on it.`);

console.log("\n> building the site\n");
run("npm", ["run", "build"], siteRoot, "The site did not build. The log is above.");

console.log("\nEvery page in the reference has a linked signature block, and the site builds.\n");
