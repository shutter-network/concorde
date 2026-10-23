import { readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDrizzleJson } from "drizzle-kit/api";
import * as decisions from "../../src/decisions/schema/index.ts";
import * as messenger from "../../src/messenger/schema/index.ts";
import * as nostrAuth from "../../src/nostr-auth/schema/index.ts";
import * as nostrChannel from "../../src/nostr-channel/schema/index.ts";
import * as passwordAuth from "../../src/password-auth/schema/index.ts";
import * as scheduler from "../../src/scheduler/schema/index.ts";
import * as signals from "../../src/signals/schema/index.ts";
import * as users from "../../src/users/schema/index.ts";

type ColumnSnapshot = {
  readonly name: string;
  readonly type: string;
  readonly primaryKey: boolean;
  readonly notNull: boolean;
  readonly default?: unknown;
  readonly generated?: { readonly type: string; readonly as: string };
  readonly identity?: { readonly type: "always" | "byDefault" };
};

export type TableSnapshot = {
  readonly name: string;
  readonly schema: string;
  readonly columns: Record<string, ColumnSnapshot>;
  readonly indexes: Record<
    string,
    {
      readonly name: string;
      readonly columns: readonly { readonly expression: string }[];
      readonly isUnique: boolean;
      readonly method: string;
    }
  >;
  readonly foreignKeys: Record<
    string,
    {
      readonly name: string;
      readonly columnsFrom: readonly string[];
      readonly tableTo: string;
      readonly columnsTo: readonly string[];
      readonly schemaTo?: string;
      readonly onUpdate?: string;
      readonly onDelete?: string;
    }
  >;
  readonly compositePrimaryKeys: Record<
    string,
    { readonly name: string; readonly columns: readonly string[] }
  >;
  readonly uniqueConstraints: Record<
    string,
    {
      readonly name: string;
      readonly columns: readonly string[];
      readonly nullsNotDistinct: boolean;
    }
  >;
  readonly checkConstraints: Record<string, { readonly name: string; readonly value: string }>;
  readonly policies: Record<string, { readonly name: string }>;
  readonly isRLSEnabled: boolean;
};

export type ReferenceSnapshot = {
  readonly schemas: Record<string, string>;
  readonly tables: Record<string, TableSnapshot>;
  readonly enums: Record<string, unknown>;
  readonly sequences: Record<string, unknown>;
  readonly views: Record<string, unknown>;
};

const keptFields = ["schemas", "tables", "enums", "sequences", "views"] as const;

export type ComponentTables = {
  readonly subpath: string;
  readonly specifier: string;
  readonly schema: string;
  readonly snapshot: ReferenceSnapshot;
};

export type SchemaExtraction = {
  readonly components: readonly ComponentTables[];
};

const schemaModules: Record<string, Record<string, unknown>> = {
  decisions,
  messenger,
  "nostr-auth": nostrAuth,
  "nostr-channel": nostrChannel,
  "password-auth": passwordAuth,
  scheduler,
  signals,
  users,
};

const packageName = "@shutter-network/concorde";

export function extractSchemas(): SchemaExtraction {
  assertListIsWhole();
  return {
    components: Object.entries(schemaModules).map(([subpath, module]) => {
      const snapshot = keptFieldsOf(generateDrizzleJson(module));
      const { schemas, tables } = snapshot;
      const declaredSchemas = Object.keys(schemas);
      if (Object.keys(tables).length === 0) {
        throw new Error(
          `src/${subpath}/schema/index.ts exports no table that drizzle-kit can see. A table reached ` +
            `only through the tables wrapper is dropped here exactly as it is dropped from a ` +
            `migration, so flat-export it.`,
        );
      }
      if (declaredSchemas.length !== 1) {
        throw new Error(
          `src/${subpath}/schema/index.ts declares ${declaredSchemas.length} PostgreSQL schemas ` +
            `(${declaredSchemas.join(", ") || "none"}). Every page states one schema name, and ` +
            `one schema per component is what keeps two components off one table ` +
            `(src/schemas.test.ts).`,
        );
      }
      return {
        subpath,
        specifier: `${packageName}/${subpath}/schema`,
        schema: declaredSchemas[0] ?? "",
        snapshot,
      };
    }),
  };
}

function keptFieldsOf(snapshot: unknown): ReferenceSnapshot {
  const held = snapshot as Record<string, unknown>;
  const missing = keptFields.filter((field) => held[field] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `drizzle-kit's snapshot no longer carries ${missing.join(", ")}. The pages are written ` +
        `from those fields, so a rename here empties them rather than failing. Update ` +
        `keptFields and the types beside it in scripts/reference/schema-extraction.ts.`,
    );
  }
  return {
    schemas: held.schemas as ReferenceSnapshot["schemas"],
    tables: held.tables as ReferenceSnapshot["tables"],
    enums: held.enums as ReferenceSnapshot["enums"],
    sequences: held.sequences as ReferenceSnapshot["sequences"],
    views: held.views as ReferenceSnapshot["views"],
  };
}

function assertListIsWhole(): void {
  const source = fileURLToPath(new URL("../../src/", import.meta.url));
  const inSource = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name === "schema")
    .map((entry) => relative(source, entry.parentPath));

  const listed = Object.keys(schemaModules);
  const unlisted = inSource.filter((subpath) => !listed.includes(subpath)).sort();
  const gone = listed.filter((subpath) => !inSource.includes(subpath)).sort();
  if (unlisted.length === 0 && gone.length === 0) return;

  throw new Error(
    [
      `The schema modules listed in scripts/reference/schema-extraction.ts disagree with src.`,
      ...unlisted.map((s) => `  src/${s}/schema/ is not listed, so ${s} has no page.`),
      ...gone.map((s) => `  ${s} is listed but src/${s}/schema/ is gone.`),
    ].join("\n"),
  );
}
