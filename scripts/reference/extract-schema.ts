/**
 * Writes the table extraction to stdout as one JSON document, and chooses no file.
 *
 * Where the JSON lands is the renderer's business, so this exists for the reader who wants to
 * look at the extracted structure when a page looks wrong and know which half to fix.
 * `scripts/reference/render.ts` calls `extractSchemas` directly rather than reading this.
 *
 * Run with `npm run extract:schema`. It needs no database, no Docker and no network.
 */

import { extractSchemas } from "./schema-extraction.ts";

process.stdout.write(`${JSON.stringify(extractSchemas(), null, 2)}\n`);
