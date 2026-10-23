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
            `"${documentedElsewhere}" is documented by a generated table page and TypeDoc has ` +
              `rendered one for it too. An export entry gets exactly one generator. Take the ` +
              `entry point out of typedoc.jsonc: a rendered page would print every table as ` +
              `PgTableWithColumns<{}> and say nothing the table page does not.`,
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
          `nobody can import.`,
      );
    }
  });
}
