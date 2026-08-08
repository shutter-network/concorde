/**
 * What every component creates in an Operator's database, as one JSON document.
 *
 * The structure comes out of `generateDrizzleJson`, which is `drizzle-kit`'s own snapshot
 * generator and the same code path that generates the Operator's migration
 * ([ADR-0046](../../docs/adr/0046-the-operator-owns-migrations.md)). It reads a module exactly
 * as an Operator's barrel does, keeping the values that are tables and ignoring the rest, so the
 * `*Tables` wrapper beside them costs nothing and a page cannot disagree with the DDL that gets
 * applied. It connects to nothing: no database, no Docker, no network.
 *
 * **One call per schema module, not one call for all of them.** A page is about one component,
 * and a per-module call is what makes the answer per component. A cross-schema foreign key still
 * comes out whole, because the snapshot records `schemaTo` from the referenced column rather than
 * from the set of modules it was given.
 *
 * **Four fields of each snapshot are dropped**, because they say when it was taken rather than
 * what it holds: `id` and `prevId` are a fresh random pair on every call, and `version` and
 * `dialect` describe the format. Left in, `id` alone would make two extractions of an unchanged
 * tree differ from each other. What is kept is `schemas`, `tables`, `enums`, `sequences` and
 * `views`. The compiler cannot hold `drizzle-kit` to those five names, for the reason
 * `ReferenceSnapshot` gives below, so `keptFieldsOf` reads them off the raw object and refuses
 * one that has gone.
 *
 * **The modules are listed below and the list is held against the source tree**, which is the
 * one design decision here the spec left open. The spec declined a guard, on the reading that
 * the only candidate was a comparison against the export map: a component may legitimately own no
 * tables, so that comparison needs a hand-written list of the exempt ones and moves the drift one
 * file over rather than removing it. `src/<component>/schema.ts` needs no exemption, because
 * owning that file *is* owning tables. It is also not new machinery: `src/schemas.test.ts` already
 * scans for exactly these files to hold exactly this list, and the eight lines below are that scan
 * again. The cost the spec agreed to record was that a component absent from the list is silently
 * absent from the reference; that cost was priced against a committed reference where at least the
 * absence showed up once, as a deleted page in a review. The reference is not committed any more,
 * so nothing would have shown at all.
 */

import { readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDrizzleJson } from "drizzle-kit/api";
import * as decisions from "../../src/decisions/schema.ts";
import * as messenger from "../../src/messenger/schema.ts";
import * as nostrAuth from "../../src/nostr-auth/schema.ts";
import * as nostrChannel from "../../src/nostr-channel/schema.ts";
import * as passwordAuth from "../../src/password-auth/schema.ts";
import * as scheduler from "../../src/scheduler/schema.ts";
import * as signals from "../../src/signals/schema.ts";
import * as users from "../../src/users/schema.ts";

/**
 * The snapshot, written out here rather than taken from `drizzle-kit`.
 *
 * **Its own types do not survive the trip.** `generateDrizzleJson` is declared as returning
 * `TypeOf<typeof pgSchema>`, a zod inference, and the zod that resolves in this tree is not the
 * major version `drizzle-kit` was compiled against, so the whole return type collapses to `any`.
 * Deriving these with `Pick` therefore buys nothing: it would type-check against `any` and let the
 * renderer read a field that is not there. Written out, the renderer is checked against a shape,
 * and `keptFields` below is what holds that shape against the object `drizzle-kit` actually
 * answers with at the one point where `any` enters.
 *
 * Only what a page describes is written out. The renderer refuses a snapshot carrying anything
 * else, so a field left out here cannot become a page that quietly omits it.
 */
type ColumnSnapshot = {
  readonly name: string;
  readonly type: string;
  readonly primaryKey: boolean;
  readonly notNull: boolean;
  readonly default?: unknown;
  readonly generated?: { readonly type: string; readonly as: string };
  readonly identity?: { readonly type: "always" | "byDefault" };
};

/** One table in a snapshot: its columns, its keys, its indexes and its constraints. */
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

/** The part of a snapshot that describes the tables rather than the taking of it. */
export type ReferenceSnapshot = {
  readonly schemas: Record<string, string>;
  readonly tables: Record<string, TableSnapshot>;
  readonly enums: Record<string, unknown>;
  readonly sequences: Record<string, unknown>;
  readonly views: Record<string, unknown>;
};

/**
 * The five fields kept out of each snapshot, and the only place `any` becomes a shape.
 *
 * Dropped are `id` and `prevId`, a fresh random pair on every call, and `version` and `dialect`,
 * which describe the format. `id` alone would make two extractions of an unchanged tree differ.
 */
const keptFields = ["schemas", "tables", "enums", "sequences", "views"] as const;

/** One component's tables, keyed by the specifier a Developer imports the component from. */
export type ComponentTables = {
  /** The directory under `src`, which is also the subpath in the export map (ADR-0047). */
  readonly subpath: string;
  /** The full import specifier, which is what the page is titled with. */
  readonly specifier: string;
  /** The single PostgreSQL schema this component writes into, such as `saf_users`. */
  readonly schema: string;
  readonly snapshot: ReferenceSnapshot;
};

/** What `npm run extract:schema` writes to stdout. */
export type SchemaExtraction = {
  readonly components: readonly ComponentTables[];
};

/**
 * Every component that owns tables, keyed by the directory it lives in.
 *
 * Listed rather than discovered, because a static import is what makes the extraction
 * type-checked: `npm run typecheck` reads these eight paths, so a schema module that moved or was
 * renamed fails at a desk rather than producing a confidently short document. `assertListIsWhole`
 * below is what keeps the list equal to the source tree.
 */
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

const packageName = "shared-agent-framework";

/**
 * The tables of every component that owns any, in the order the list above is written.
 *
 * @throws if the list has drifted from the source tree, if a listed module exports no table at
 * all, or if it declares anything other than exactly one PostgreSQL schema.
 */
export function extractSchemas(): SchemaExtraction {
  assertListIsWhole();
  return {
    components: Object.entries(schemaModules).map(([subpath, module]) => {
      const snapshot = keptFieldsOf(generateDrizzleJson(module));
      const { schemas, tables } = snapshot;
      const declaredSchemas = Object.keys(schemas);
      // Both of these are the wrapper trap in the shape this feature would meet it
      // (ADR-0046): a table that retreated into a `*Tables` object is dropped by
      // `generateDrizzleJson` in silence, and the page for that component would render as
      // an honest, complete and empty page. A component with no tables has no page at all,
      // so the absence would look exactly like the intended thing.
      if (Object.keys(tables).length === 0) {
        throw new Error(
          `src/${subpath}/schema.ts exports no table that drizzle-kit can see. A table reached ` +
            `only through a *Tables wrapper is dropped here exactly as it is dropped from a ` +
            `migration (ADR-0046), so flat-export it.`,
        );
      }
      if (declaredSchemas.length !== 1) {
        throw new Error(
          `src/${subpath}/schema.ts declares ${declaredSchemas.length} PostgreSQL schemas ` +
            `(${declaredSchemas.join(", ") || "none"}). Every page states one schema name, and ` +
            `one schema per component is what keeps two components off one table ` +
            `(ADR-0022, src/schemas.test.ts).`,
        );
      }
      return {
        subpath,
        specifier: `${packageName}/${subpath}`,
        schema: declaredSchemas[0] ?? "",
        snapshot,
      };
    }),
  };
}

/**
 * The five kept fields of one snapshot, and the assertion that they are still called that.
 *
 * This is where `any` becomes `ReferenceSnapshot`, so it is the only place a `drizzle-kit`
 * rename could pass unnoticed: the compiler cannot object to reading any field off `any`. A
 * renamed `tables` would empty every page, and a renamed `enums` would silence the renderer's
 * refusal to describe one. Both are read here by name, so both are named here.
 */
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

/**
 * Holds the list above against `src`, both ways.
 *
 * The same scan `src/schemas.test.ts` runs, for the same reason and against the same list: a
 * component added later whose schema nobody lists is a component nothing covers.
 */
function assertListIsWhole(): void {
  const source = fileURLToPath(new URL("../../src/", import.meta.url));
  const inSource = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.name === "schema.ts")
    .map((entry) => relative(source, entry.parentPath));

  const listed = Object.keys(schemaModules);
  const unlisted = inSource.filter((subpath) => !listed.includes(subpath)).sort();
  const gone = listed.filter((subpath) => !inSource.includes(subpath)).sort();
  if (unlisted.length === 0 && gone.length === 0) return;

  throw new Error(
    [
      `The schema modules listed in scripts/reference/schema-extraction.ts disagree with src.`,
      ...unlisted.map((s) => `  src/${s}/schema.ts is not listed, so ${s} has no page.`),
      ...gone.map((s) => `  ${s} is listed but src/${s}/schema.ts is gone.`),
    ].join("\n"),
  );
}
