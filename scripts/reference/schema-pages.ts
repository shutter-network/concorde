import { type PageSet, pageLink, type ReferencePage } from "./pages.ts";
import type { ComponentTables, SchemaExtraction, TableSnapshot } from "./schema-extraction.ts";

const directory = "tables";

export function schemaPages(extraction: SchemaExtraction): PageSet {
  const owners = schemaOwners(extraction);
  const pages: ReferencePage[] = extraction.components.map((component) => ({
    file: `${component.subpath}.md`,
    markdown: page(component, owners),
  }));
  return {
    directory,
    pages,
    section: {
      text: "Tables",
      collapsed: true,
      items: extraction.components.map((component) => ({
        text: component.subpath,
        link: pageLink(directory, component.subpath),
      })),
    },
  };
}

function schemaOwners(extraction: SchemaExtraction): ReadonlyMap<string, string> {
  return new Map(extraction.components.map((component) => [component.schema, component.specifier]));
}

function page(component: ComponentTables, owners: ReadonlyMap<string, string>): string {
  const tables = sorted(component.snapshot.tables);
  assertNothingIsDropped(component, tables);

  return [
    "---",
    `title: ${JSON.stringify(`${component.specifier} tables`)}`,
    "---",
    "",
    `# ${component.specifier}`,
    "",
    `Tables defined by \`${component.specifier}\` in PostgreSQL schema \`${component.schema}\`. Your application applies these definitions; the component does not create tables.`,
    "",
    `Generated from \`src/${component.subpath}/schema/index.ts\` using drizzle-kit.`,
    ...crossSchemaWarning(component, tables, owners),
    ...tables.flatMap((table) => ["", ...tableSection(table)]),
    "",
  ].join("\n");
}

function crossSchemaWarning(
  component: ComponentTables,
  tables: readonly TableSnapshot[],
  owners: ReadonlyMap<string, string>,
): readonly string[] {
  const leaving = new Map<string, string[]>();
  for (const table of tables) {
    for (const key of sorted(table.foreignKeys)) {
      const target = key.schemaTo ?? "public";
      if (target === component.schema) continue;
      const from = key.columnsFrom.map((name) => `\`${table.name}.${name}\``);
      leaving.set(target, [...(leaving.get(target) ?? []), ...from]);
    }
  }
  if (leaving.size === 0) return [];

  const sentences = [...leaving].map(([schema, from]) => {
    const owner = owners.get(schema);
    const creator = owner ? `\`${owner}\`` : `the definitions for \`${schema}\``;
    const named = [...new Set(from)];
    return (
      `${list(named)} point${named.length === 1 ? "s" : ""} into ` +
      `\`${schema}\`, defined by ${creator}.`
    );
  });
  return [
    "",
    `**Required schemas:** ${sentences.join(" ")} Include these definitions alongside \`${component.specifier}\` when applying database changes.`,
  ];
}

function tableSection(table: TableSnapshot): readonly string[] {
  const lines = [`## ${table.schema}.${table.name}`, "", ...columnTable(table)];

  const primaryKey = [
    ...Object.values(table.columns)
      .filter((column) => column.primaryKey)
      .map((column) => column.name),
    ...sorted(table.compositePrimaryKeys).flatMap((key) => key.columns),
  ];
  if (primaryKey.length > 0) lines.push("", `**Primary key:** ${columns(primaryKey)}`);

  const uniques = sorted(table.uniqueConstraints);
  if (uniques.length > 0) {
    lines.push(
      "",
      "**Unique constraints**",
      "",
      ...rows(
        ["Name", "Columns", "Nulls not distinct"],
        uniques.map((constraint) => [
          `\`${constraint.name}\``,
          columns(constraint.columns),
          yesNo(constraint.nullsNotDistinct),
        ]),
      ),
    );
  }

  const indexes = sorted(table.indexes);
  if (indexes.length > 0) {
    lines.push(
      "",
      "**Indexes**",
      "",
      ...rows(
        ["Name", "Columns", "Method", "Unique"],
        indexes.map((index) => [
          `\`${index.name}\``,
          columns(index.columns.map((column) => column.expression)),
          index.method,
          yesNo(index.isUnique),
        ]),
      ),
    );
  }

  const checks = sorted(table.checkConstraints);
  if (checks.length > 0) {
    lines.push(
      "",
      "**Check constraints**",
      "",
      ...rows(
        ["Name", "Condition"],
        checks.map((check) => [`\`${check.name}\``, `\`${check.value}\``]),
      ),
    );
  }

  const keys = sorted(table.foreignKeys);
  if (keys.length > 0) {
    lines.push(
      "",
      "**Foreign keys**",
      "",
      ...rows(
        ["Columns", "References", "On delete", "On update"],
        keys.map((key) => [
          columns(key.columnsFrom),
          `\`${key.schemaTo ?? "public"}.${key.tableTo}\` (${columns(key.columnsTo)})`,
          key.onDelete ?? "no action",
          key.onUpdate ?? "no action",
        ]),
      ),
    );
  }

  return lines;
}

function columnTable(table: TableSnapshot): readonly string[] {
  return rows(
    ["Column", "Type", "Nullable", "Default"],
    Object.values(table.columns).map((column) => [
      `\`${column.name}\``,
      `\`${column.type}\``,
      yesNo(!column.notNull),
      columnDefault(column),
    ]),
  );
}

function columnDefault(column: TableSnapshot["columns"][string]): string {
  if (column === undefined) return "";
  if (column.identity !== undefined) {
    return `generated ${column.identity.type === "always" ? "always" : "by default"} as identity`;
  }
  if (column.generated !== undefined) {
    return `generated ${column.generated.type} as (\`${column.generated.as}\`)`;
  }
  return column.default === undefined ? "" : `\`${String(column.default)}\``;
}

function assertNothingIsDropped(
  component: ComponentTables,
  tables: readonly TableSnapshot[],
): void {
  const dropped: string[] = [];
  for (const [kind, held] of Object.entries({
    enums: component.snapshot.enums,
    sequences: component.snapshot.sequences,
    views: component.snapshot.views,
  })) {
    if (Object.keys(held).length > 0) dropped.push(`${kind}: ${Object.keys(held).join(", ")}`);
  }
  for (const table of tables) {
    const policies = Object.keys(table.policies);
    if (policies.length > 0) dropped.push(`policies on ${table.name}: ${policies.join(", ")}`);
    if (table.isRLSEnabled) dropped.push(`row level security on ${table.name}`);
  }
  if (dropped.length === 0) return;

  throw new Error(
    [
      `Unsupported schema features in src/${component.subpath}/schema/index.ts:`,
      ...dropped.map((entry) => `  ${entry}`),
      `Add rendering support in scripts/reference/schema-pages.ts.`,
    ].join("\n"),
  );
}

function sorted<T extends { name: string }>(held: Record<string, T>): readonly T[] {
  return Object.values(held).sort((left, right) => left.name.localeCompare(right.name));
}

function rows(header: readonly string[], body: readonly (readonly string[])[]): readonly string[] {
  return [
    row(header),
    row(header.map(() => "---")),
    ...body.map((cells) => row(cells.map(escapeCell))),
  ];
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function escapeCell(cell: string): string {
  return cell.replaceAll("|", "\\|");
}

function columns(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(", ");
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
