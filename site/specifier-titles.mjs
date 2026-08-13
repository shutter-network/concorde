// A module's title is the specifier a Developer imports from, and every export entry is
// documented by exactly one generator.
//
// TypeDoc names a module after its entry file's path, so `../src/users/index.ts` arrives as
// `users` and `../src/index.ts` as `index` — neither of which is a thing anyone can type into
// an import. This renames each module to its specifier in the root package.json `exports`, so
// the page a Developer lands on is headed with the line they copy (ADR-0047).
//
// The mapping is derived from the export map rather than listed here, and the whole map is
// accounted for. Two generators write the reference: TypeDoc, whose pages are the component and
// infrastructure subpaths, and `scripts/reference/render.ts`, whose table pages are the eight
// `/schema` subpaths (ADR-0055). Every entry belongs to exactly one of them, and this fails the
// generation on any disagreement in either direction: a TypeDoc module that is not an entry point,
// an entry point that produced no module, a `/schema` entry with no `schema/` directory behind it
// to render a table page from, a `schema/` directory with no `/schema` entry, and a `/schema` entry
// that TypeDoc rendered a page for as well.
//
// A `/schema` entry must not become a TypeDoc entry point, which is why it is documented by the
// other generator rather than exempted here: `excludeExternals` empties drizzle's type parameter,
// so such a page would print `PgTableWithColumns<{}>` for every table and duplicate the table page
// badly.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Converter, ReflectionKind } from "typedoc";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The export map, split by the generator that documents each entry.
 *
 * TypeDoc's are keyed by the name TypeDoc gives the module: the entry file's path under `src`,
 * without its `/index.ts`. `dist` mirrors `src` exactly, which is what makes the dist path in
 * `exports` readable as a source path. The table pages' are keyed by the component directory,
 * which is what `scripts/reference/render.ts` names a page after.
 *
 * @returns {{ typedoc: Map<string, string>, tables: Map<string, string> }} module name or
 * component directory → import specifier.
 */
function specifiersByGenerator() {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const typedoc = new Map();
  const tables = new Map();
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    // A subpath mapped to `null` is deliberately unreachable and has no module to document —
    // `"./messenger"` was one until ADR-0047 retired it — so it is skipped rather than an error.
    if (typeof conditions?.default !== "string") continue;
    const moduleName = conditions.default
      .replace(/^\.\/dist\//, "")
      .replace(/\.js$/, "")
      .replace(/(?<=.)\/index$/, "");
    const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    const owner = moduleName.endsWith("/schema") ? tables : typedoc;
    owner.set(moduleName.replace(/\/schema$/, ""), specifier);
  }
  return { typedoc, tables };
}

/**
 * The components that own tables, which is the set of pages the table renderer writes.
 *
 * Owning a `src/<component>/schema/` is what owning tables is, so the scan needs no exemption
 * list for the components that legitimately own none. It is the same scan
 * `scripts/reference/schema-extraction.ts` holds its own module list against, and the same one
 * `src/schemas.test.ts` runs.
 *
 * @returns {Set<string>} component directory under `src`.
 */
function componentsThatOwnTables() {
  const source = resolve(packageRoot, "src");
  return new Set(
    readdirSync(source, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name === "schema")
      .map((entry) => relative(source, entry.parentPath)),
  );
}

/** @param {import("typedoc").Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    const { typedoc, tables } = specifiersByGenerator();
    for (const module of context.project.getReflectionsByKind(ReflectionKind.Module)) {
      const specifier = typedoc.get(module.name);
      if (!specifier) {
        const documentedElsewhere = tables.get(module.name.replace(/\/schema$/, ""));
        if (module.name.endsWith("/schema") && documentedElsewhere) {
          throw new Error(
            `"${documentedElsewhere}" is documented by a generated table page and TypeDoc has ` +
              `rendered one for it too. An export entry gets exactly one generator. Take the ` +
              `entry point out of typedoc.jsonc: a rendered page would print every table as ` +
              `PgTableWithColumns<{}> and say nothing the table page does not (ADR-0055).`,
          );
        }
        throw new Error(
          `The rendered module "${module.name}" is not an entry point in package.json exports. ` +
            `Every page in the reference must be a specifier a Developer can import.`,
        );
      }
      typedoc.delete(module.name);
      module.name = specifier;
    }
    if (typedoc.size > 0) {
      throw new Error(
        `These entry points are in package.json exports but rendered no page: ` +
          `${[...typedoc.values()].join(", ")}. Add them to typedoc.jsonc.`,
      );
    }

    const owners = componentsThatOwnTables();
    const unrendered = [...tables]
      .filter(([component]) => !owners.has(component))
      .map(([, specifier]) => specifier);
    if (unrendered.length > 0) {
      throw new Error(
        `These entry points are in package.json exports and no generator documents them: ` +
          `${unrendered.join(", ")}. A table page is written for every src/<component>/schema/, ` +
          `and these have none.`,
      );
    }
    const unexported = [...owners].filter((component) => !tables.has(component));
    if (unexported.length > 0) {
      throw new Error(
        `These components own tables and have no "./<component>/schema" entry in package.json ` +
          `exports: ${unexported.join(", ")}. Their table page would document a specifier ` +
          `nobody can import (ADR-0055).`,
      );
    }
  });
}
