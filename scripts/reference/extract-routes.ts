/**
 * Prints every route every component serves as one JSON document, and chooses no file.
 *
 * Run with `npm run extract:routes`. It exists for the reader who wants to see what a page was
 * rendered from when the page looks wrong: `scripts/reference/route-pages.ts` reads the same
 * value in memory, so nothing in the pipeline reads this output.
 */

import { extractRoutes } from "./route-extraction.ts";

console.log(JSON.stringify(await extractRoutes(), null, 2));
