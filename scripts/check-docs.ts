/**
 * Verifies the two claims the committed API reference rests on:
 *
 *  - **the committed reference is what the doc comments say today.** `site/reference` is
 *    regenerated from `../src` and compared against what is in git. Any difference is a
 *    failure, and the files that differ are named: a change to the public API is meant to
 *    arrive as a readable diff in review, and it cannot do that if the rendered pages lag
 *    behind the declarations they were rendered from.
 *  - **the site still builds.** A broken VitePress configuration or a dead link between
 *    pages should fail here rather than in somebody's browser.
 *
 * Both failures are collected and reported together, because a stale reference and a broken
 * build are independent and finding one should not hide the other.
 *
 * Run with `npm run check:docs`. Deliberately not part of `npm run check`, for the same
 * reason `check:package` is not: regenerating needs TypeDoc and the TypeScript 6 it peers,
 * and a dependency tree of its own is exactly how `site/` keeps that second compiler out of
 * the inner loop (`site/README.md`). This installs that tree, so it needs the network and it
 * is slow. CI runs it as its own step.
 *
 * **TypeDoc's warnings fail this check**, through `treatWarningsAsErrors` in `typedoc.jsonc`,
 * which says why. They did not until `CursorWindow` reached the package root: one dangling
 * reference was known and tolerated, and an export map is not something a documentation check
 * gets to force at an unrelated moment. With none left to tolerate, the tolerance only hid the
 * next one, and the comparison below cannot see that one — a page rendering a type nobody can
 * import is not a *stale* page, so it is committed and matches and this check passes. A failing
 * generation stops the run before there is anything to compare against.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const siteRoot = path.join(repoRoot, "site");

/**
 * Runs a command with its output on our own stdio, so TypeDoc's warnings and VitePress's
 * build log are read by whoever is watching rather than swallowed and re-printed.
 *
 * **`cwd` is load-bearing for VitePress.** It takes its project root from the working
 * directory, so run from the repository root it treats every markdown file in the tree as a
 * page and fails compiling a decision record. `npm --prefix` does not help: it moves where
 * `npm` looks for the package, not where the command runs.
 *
 * Named as `check-package.ts` names its own: a `run` there answers with output and throws,
 * and this one answers with the exit status because a failing step here is a finding to
 * collect rather than the end of the run.
 *
 * @returns Whether it exited zero.
 */
function exitsZero(command: string, args: string[], cwd: string): boolean {
  try {
    execFileSync(command, args, { cwd, stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The generated pages that differ from what is committed, as git sees them.
 * `--untracked-files=all` is what makes a *new* page count: a ninth entry point, or a
 * directory TypeDoc copied in of its own accord, is a file nobody committed rather than a
 * modification to one.
 *
 * The status is compared against the working tree rather than against `HEAD` alone, so a
 * regenerated page that is staged and not yet committed is still a difference. That is the
 * question being asked: what is committed is what a reviewer reads.
 *
 * Porcelain v1 is parsed by dropping the two status columns and the space. Every path here is
 * a page named after an import specifier, so none of them is quoted or renamed, and the worst
 * a surprise could do is print an odd path beside a failure that is real anyway.
 *
 * `site/reference/typedoc-sidebar.json` is gitignored and so invisible here; `.gitignore` says
 * why. It is regenerated from the doc comments before every build, so nothing reads a stale
 * one. What that costs is a sidebar the pages do not reflect, which is a theme upgrade rather
 * than an API change, and no reviewer was going to read that file.
 *
 * @returns One relative path per differing file, in git's order.
 */
function differingFiles(): string[] {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", "site/reference"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return status
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim());
}

const failures: string[] = [];

console.log("\n> installing the site's own dependency tree\n");
if (!exitsZero("npm", ["ci", "--no-audit", "--no-fund"], siteRoot)) {
  console.error("\nInstalling site/node_modules failed. Nothing below could run.\n");
  process.exit(1);
}

console.log("\n> regenerating site/reference from the doc comments\n");
if (!exitsZero("npm", ["run", "generate"], siteRoot)) {
  console.error("\nTypeDoc failed. There is nothing to compare against.\n");
  process.exit(1);
}

const differing = differingFiles();
if (differing.length > 0) {
  failures.push(
    `The committed reference is not what your working tree's doc comments render to. ` +
      `These files differ:\n${differing.map((file) => `  ${file}`).join("\n")}\n\n` +
      `The regenerated pages are in your working tree now. Commit them with the change that ` +
      `moved them.`,
  );
}

// `site/`'s own `build`, and not `vitepress build` spelled again here, so that building the
// site has one definition. It generates first, which is a second TypeDoc run costing a few
// seconds: regeneration is byte-identical, so it cannot disturb the comparison just made, and
// paying for it is cheaper than a step added to that script and silently skipped by this one.
console.log("\n> building the site\n");
if (!exitsZero("npm", ["run", "build"], siteRoot)) {
  failures.push("The site did not build. The log is above.");
}

if (failures.length > 0) {
  console.error(`\n${failures.join("\n\n")}\n`);
  process.exit(1);
}

console.log("\nThe committed reference matches the doc comments, and the site builds.\n");
