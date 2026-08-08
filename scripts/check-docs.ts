/**
 * Verifies the two claims the generated API reference rests on:
 *
 *  - **every page still has a linked signature block in it.** `site/reference` is regenerated
 *    from `../src`, and every page it wrote is read back and asked for one preformatted block
 *    with a hyperlink inside it. The reference is not committed, so nothing else looks at these
 *    pages between one generation and the next.
 *  - **the site still builds.** A broken VitePress configuration or a dead link between pages
 *    should fail here rather than in somebody's browser.
 *
 * Every step below is terminal: it reports and exits. Nothing is collected, because the drift
 * comparison that used to be the second independent finding is gone with the committed pages.
 *
 * Run with `npm run check:docs`. Deliberately not part of `npm run check`, for the same
 * reason `check:package` is not: regenerating needs TypeDoc and the TypeScript 6 it peers,
 * and a dependency tree of its own is exactly how `site/` keeps that second compiler out of
 * the inner loop (`site/README.md`). This installs that tree, so it needs the network and it
 * is slow. CI runs it as its own step.
 *
 * **TypeDoc's warnings fail this check**, through `treatWarningsAsErrors` in `typedoc.jsonc`,
 * which is where the argument for that is written. What matters here is only the consequence: a
 * failing generation stops the run before there is anything to read, and the assertion below
 * would not have caught what the warning does. A page rendering a type nobody can import is
 * honestly rendered rather than unlinked, so every block on it still carries links and this
 * check passes.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const siteRoot = path.join(repoRoot, "site");
const referenceRoot = path.join(siteRoot, "reference");

/**
 * Runs a command with its output on our own stdio, so TypeDoc's warnings and VitePress's
 * build log are read by whoever is watching rather than swallowed and re-printed. A non-zero
 * exit ends the run with `whenItFails` printed after the log that explains it.
 *
 * **`cwd` is load-bearing for VitePress.** It takes its project root from the working
 * directory, so run from the repository root it treats every markdown file in the tree as a
 * page and fails compiling a decision record. `npm --prefix` does not help: it moves where
 * `npm` looks for the package, not where the command runs.
 */
function run(command: string, args: string[], cwd: string, whenItFails: string): void {
  try {
    execFileSync(command, args, { cwd, stdio: "inherit" });
  } catch {
    console.error(`\n${whenItFails}\n`);
    process.exit(1);
  }
}

/**
 * One preformatted block, however many attributes it carries. `<pre>` does not nest, so the
 * lazy body is the whole of one block and never runs into the next.
 */
const PREFORMATTED_BLOCK = /<pre[^>]*>[\s\S]*?<\/pre>/g;

/** An opening anchor tag, which is the only thing a hyperlink can be written as here. */
const HYPERLINK = /<a[\s>]/;

/**
 * The pages the generation above wrote, as absolute paths.
 *
 * TypeDoc removes `out` before it writes (`cleanOutputDir` is on by default), so a page read
 * here is a page this run produced and there is no stale directory to pass against. A missing
 * directory answers with nothing rather than throwing, because the caller treats an empty
 * answer as the failure it is.
 *
 * `index.md` is excluded and is the only exclusion: it is the generated list of the other
 * pages, it carries no declaration, and it therefore has no block for a link to be in.
 */
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

/**
 * Whether a page has at least one preformatted block with a hyperlink in it.
 *
 * This is the one thing about these pages that can stop being true without looking wrong.
 * `site/expanded-object-methods.mjs` writes a signature block by overriding partials it reads
 * off another package's render context by name, and an upgrade that renamed one leaves the
 * override uncalled: the plugin's own wrapper runs, and the page renders as a fenced code
 * block that is correctly coloured, entirely unlinked, and indistinguishable from the
 * reference before that renderer existed. Every other way the design breaks is loud. A bad
 * character range throws during generation, broken escaping is visible on sight, and a type
 * reference resolving to nothing already fails through TypeDoc's warnings.
 */
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

// `site/`'s own `build`, and not `vitepress build` spelled again here, so that building the
// site has one definition. It generates first, which is a second TypeDoc run costing a few
// seconds: regeneration is byte-identical, so it cannot disturb the pages just read, and
// paying for it is cheaper than a step added to that script and silently skipped by this one.
console.log("\n> building the site\n");
run("npm", ["run", "build"], siteRoot, "The site did not build. The log is above.");

console.log("\nEvery page in the reference has a linked signature block, and the site builds.\n");
