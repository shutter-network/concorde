import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Converter, ReflectionKind } from "typedoc";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function specifiersByGenerator() {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const typedoc = new Map();
  const tables = new Map();
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
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

function componentsThatOwnTables() {
  const source = resolve(packageRoot, "src");
  return new Set(
    readdirSync(source, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name === "schema")
      .map((entry) => relative(source, entry.parentPath)),
  );
}

export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    const { typedoc, tables } = specifiersByGenerator();
    for (const module of context.project.getReflectionsByKind(ReflectionKind.Module)) {
      const specifier = typedoc.get(module.name);
      if (!specifier) {
        const documentedElsewhere = tables.get(module.name.replace(/\/schema$/, ""));
        if (module.name.endsWith("/schema") && documentedElsewhere) {
          throw new Error(
            `Duplicate documentation for ${documentedElsewhere}. Remove its entry from typedoc.jsonc; the table renderer already documents it.`,
          );
        }
        throw new Error(
          `Module ${module.name} is not exported by package.json. Only public entry points belong in the reference.`,
        );
      }
      typedoc.delete(module.name);
      module.name = specifier;
    }
    if (typedoc.size > 0) {
      throw new Error(
        `Missing API pages for ${[...typedoc.values()].join(", ")}. Add the entry points to typedoc.jsonc.`,
      );
    }

    const owners = componentsThatOwnTables();
    const unrendered = [...tables]
      .filter(([component]) => !owners.has(component))
      .map(([, specifier]) => specifier);
    if (unrendered.length > 0) {
      throw new Error(
        `Missing schema sources for ${unrendered.join(", ")}. Each schema export needs src/<component>/schema/.`,
      );
    }
    const unexported = [...owners].filter((component) => !tables.has(component));
    if (unexported.length > 0) {
      throw new Error(
        `Missing schema exports for ${unexported.join(", ")}. Add ./<component>/schema entries to package.json.`,
      );
    }
  });
}
