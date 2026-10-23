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
    `\nMissing ${path.relative(repoRoot, referenceRoot)}. Run TypeDoc before the route and table renderers.\n`,
  );
  process.exit(1);
}

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

writeFileSync(
  path.join(referenceRoot, "generated-sidebar.json"),
  JSON.stringify(sections, null, 2),
);
