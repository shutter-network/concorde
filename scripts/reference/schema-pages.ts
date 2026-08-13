/**
 * One page per component that owns tables, written from the extracted snapshots.
 *
 * The reader is the Operator who owns generation and application of the DDL
 * ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md)). They list the `/schema`
 * subpaths of the components they run in their own `drizzle.config.ts`
 * ([ADR-0055](../../docs/adr/0055-a-components-tables-are-a-subpath-of-their-own.md)), and this is
 * where they read what that will create: the PostgreSQL schema, every table, every column with its
 * SQL type, its nullability and its default, the keys, the indexes and the constraints.
 *
 * **The foreign keys that leave a schema get a sentence of their own at the top of the page.**
 * A list carrying the Messenger's, the Nostr Channel's, Password Auth's or Nostr Auth's subpath
 * without `shared-agent-framework/users/schema` generates a constraint onto a table nobody
 * creates, and that is the one mistake this page exists to make visible before it is made.
 *
 * **Nothing here is authored and no page is ever edited.** `site/reference` is emptied on every
 * generation, so a page that looked wrong and was fixed by hand would be gone on the next run.
 * A change to a page is a change to a `src/<component>/schema/index.ts`.
 *
 * **A snapshot holding something this file does not describe is a failure, not an omission.**
 * `assertNothingIsDropped` refuses enums, sequences, views, row policies and row level security,
 * because a page that quietly left one out would be complete, plausible and wrong about what an
 * Operator's database is going to hold. Adding the section is the way past it.
 */

import { type PageSet, pageLink, type ReferencePage } from "./pages.ts";
import type { ComponentTables, SchemaExtraction, TableSnapshot } from "./schema-extraction.ts";

/** The directory these pages live in under `site/reference`, and the first part of their URLs. */
const directory = "tables";

/** Every page, and the sidebar section that reaches them. */
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

/**
 * Which specifier creates which PostgreSQL schema, so a foreign key leaving one component can
 * name the specifier an Operator has to list beside it.
 */
function schemaOwners(extraction: SchemaExtraction): ReadonlyMap<string, string> {
  return new Map(extraction.components.map((component) => [component.schema, component.specifier]));
}

function page(component: ComponentTables, owners: ReadonlyMap<string, string>): string {
  const tables = sorted(component.snapshot.tables);
  assertNothingIsDropped(component, tables);

  return [
    // A title of its own, because the heading below is the specifier and the component's
    // TypeScript API page sits one line away from it in the sidebar. The heading is the specifier
    // an Operator lists; the browser tab says which of the two pages this is.
    "---",
    `title: ${component.specifier} tables`,
    "---",
    "",
    `# ${component.specifier}`,
    "",
    `The tables this component creates, and the PostgreSQL schema \`${component.schema}\` it ` +
      `creates them in. A configuration listing \`${component.specifier}\` creates all of them.`,
    "",
    `Generated from the snapshot \`drizzle-kit\` takes of \`src/${component.subpath}/schema/index.ts\`, ` +
      `which is the snapshot an Operator's own generation reads. Never edited by hand.`,
    ...crossSchemaWarning(component, tables, owners),
    ...tables.flatMap((table) => ["", ...tableSection(table)]),
    "",
  ].join("\n");
}

/**
 * The sentence about the foreign keys that leave this component's schema, or nothing.
 *
 * One sentence per schema they point into, naming the columns, so an Operator reads which
 * subpath has to be listed beside this one and why.
 */
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
    const creator = owner ? `\`${owner}\`` : `whatever creates \`${schema}\``;
    const named = [...new Set(from)];
    return (
      `${list(named)} point${named.length === 1 ? "s" : ""} into ` +
      `\`${schema}\`, which ${creator} creates.`
    );
  });
  return [
    "",
    `**Foreign keys leave this schema.** ${sentences.join(" ")} A configuration that lists ` +
      `\`${component.specifier}\` without it generates a constraint onto a table nobody creates.`,
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
        // Qualified with the target schema always, and not only when it differs, so that
        // reading one row never depends on remembering which schema the page is about.
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

/**
 * The columns, in the order the component declares them, which is the order a reader comparing
 * this against the schema module reads them in.
 */
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

/** What a column gets when nothing supplies a value, as an empty cell when that is nothing. */
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

/**
 * Refuses a snapshot holding something no section above writes.
 *
 * A page is read as the whole of what a component creates, so an undescribed feature is worse
 * than a failed generation: it is a complete-looking page an Operator plans a database from.
 */
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
      `src/${component.subpath}/schema/index.ts declares things the table pages do not describe, so ` +
        `its page would be complete-looking and wrong:`,
      ...dropped.map((entry) => `  ${entry}`),
      `Add the section to scripts/reference/schema-pages.ts.`,
    ].join("\n"),
  );
}

/** Sorted by name, so a page's bytes do not depend on the order drizzle happened to answer in. */
function sorted<T extends { name: string }>(held: Record<string, T>): readonly T[] {
  return Object.values(held).sort((left, right) => left.name.localeCompare(right.name));
}

/** A markdown table: the header, its rule, and one line per row. */
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

/** A pipe ends a cell, and a check constraint's condition is free to contain one. */
function escapeCell(cell: string): string {
  return cell.replaceAll("|", "\\|");
}

/**
 * Column names in a cell, comma separated and in the order they were declared.
 *
 * Not the `and` list below. The order of the columns in an index, in a composite key and on
 * either side of a foreign key is part of what is created, and `a and b` reads as a set.
 */
function columns(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(", ");
}

/** Names in a sentence, where the reader takes them as a set and `and` is what English wants. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
