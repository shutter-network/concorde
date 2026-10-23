import { extractRoutes } from "./route-extraction.ts";

console.log(JSON.stringify(await extractRoutes(), null, 2));
