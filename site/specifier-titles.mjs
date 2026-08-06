// A module's title is the specifier a Developer imports from.
//
// TypeDoc names a module after its entry file's path, so `../src/users/index.ts` arrives as
// `users` and `../src/index.ts` as `index` — neither of which is a thing anyone can type into
// an import. This renames each module to its specifier in the root package.json `exports`, so
// the page a Developer lands on is headed with the line they copy (ADR-0047).
//
// The mapping is derived from the export map rather than listed here, and it is checked both
// ways: a module that is not an entry point, or an entry point that produced no module, fails
// the generation. So `typedoc.jsonc`'s entry point list and the export map cannot drift apart
// without someone hearing about it.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Converter, ReflectionKind } from "typedoc";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The export map, keyed by the name TypeDoc gives the module: the entry file's path under
 * `src`, without its `/index.ts`. `dist` mirrors `src` exactly, which is what makes the dist
 * path in `exports` readable as a source path.
 *
 * @returns {Map<string, string>} TypeDoc module name → import specifier.
 */
function specifiersByModuleName() {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const specifiers = new Map();
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    // A subpath mapped to `null` is deliberately unreachable and has no module to document —
    // `"./messenger"` was one until ADR-0047 retired it — so it is skipped rather than an error.
    if (typeof conditions?.default !== "string") continue;
    const moduleName = conditions.default
      .replace(/^\.\/dist\//, "")
      .replace(/\.js$/, "")
      .replace(/(?<=.)\/index$/, "");
    const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    specifiers.set(moduleName, specifier);
  }
  return specifiers;
}

/** @param {import("typedoc").Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    const specifiers = specifiersByModuleName();
    for (const module of context.project.getReflectionsByKind(ReflectionKind.Module)) {
      const specifier = specifiers.get(module.name);
      if (!specifier) {
        throw new Error(
          `The rendered module "${module.name}" is not an entry point in package.json exports. ` +
            `Every page in the reference must be a specifier a Developer can import.`,
        );
      }
      specifiers.delete(module.name);
      module.name = specifier;
    }
    if (specifiers.size > 0) {
      throw new Error(
        `These entry points are in package.json exports but rendered no page: ` +
          `${[...specifiers.values()].join(", ")}. Add them to typedoc.jsonc.`,
      );
    }
  });
}
