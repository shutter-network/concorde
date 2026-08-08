/**
 * Writes the generated pages TypeDoc does not write, and the sidebar sections that reach them.
 *
 * **This runs after TypeDoc and in the same command**, `npm run generate` inside `site/`, so
 * every command that produces the reference produces the whole of it: `npm run docs:dev`,
 * `npm run docs:build` and `npm run check:docs` all go through that one script. TypeDoc empties
 * `site/reference` before it writes, which is what makes the order load-bearing rather than
 * tidy: run first, these pages would be deleted a moment later.
 *
 * That emptying is also the reason nothing here needs a staleness check. A page and its sidebar
 * entry come out of one loop over one extraction, so they cannot disagree; and a run of this
 * script is the only thing that can put `generated-sidebar.json` into a directory TypeDoc has
 * just emptied, so a pipeline that skipped this step fails at `site/.vitepress/config.ts`, which
 * imports that file statically.
 *
 * The pages are gitignored with the rest of `site/reference` and are never edited. A page is
 * changed by changing the `schema.ts` or the `routes.ts` it came from and regenerating.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PageSet, SidebarSection } from "./pages.ts";
import { extractRoutes } from "./route-extraction.ts";
import { routePages } from "./route-pages.ts";
import { extractSchemas } from "./schema-extraction.ts";
import { schemaPages } from "./schema-pages.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const referenceRoot = path.join(repoRoot, "site", "reference");

if (!existsSync(referenceRoot)) {
  console.error(
    `\n${path.relative(repoRoot, referenceRoot)} does not exist, so TypeDoc has not run. ` +
      `These pages go into the directory TypeDoc empties, so they are written after it.\n`,
  );
  process.exit(1);
}

/** Every renderer. A third one is a third entry here and changes nothing below it. */
const pageSets: readonly PageSet[] = [
  routePages(await extractRoutes()),
  schemaPages(extractSchemas()),
];

const sections: SidebarSection[] = [];
for (const { directory, pages, section } of pageSets) {
  const target = path.join(referenceRoot, directory);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const { file, markdown } of pages) {
    writeFileSync(path.join(target, file), markdown);
  }
  sections.push(section);
  console.log(`${pages.length} pages in site/reference/${directory}`);
}

// Read by `site/.vitepress/config.ts` and composed with the sidebar TypeDoc writes. Gitignored
// along with everything else under `site/reference`, so Biome never formats it.
writeFileSync(
  path.join(referenceRoot, "generated-sidebar.json"),
  JSON.stringify(sections, null, 2),
);
