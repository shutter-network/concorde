import { extractSchemas } from "./schema-extraction.ts";

process.stdout.write(`${JSON.stringify(extractSchemas(), null, 2)}\n`);
