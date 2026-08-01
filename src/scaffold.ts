import type { MigrationDescriptor } from "./store/index.ts";

/**
 * A shipped migration folder that exists only to be applied from inside an
 * installed package.
 *
 * Resolving a migration folder against `process.cwd()` rather than the module's
 * own location works in every test in this repository and breaks for every
 * Operator, so the property has to be proved from the far side of `npm install`.
 * `npm run check:package` packs the tarball, installs it into a scratch project
 * whose working directory holds no `migrations` folder at all, and applies this
 * descriptor to a real database from there.
 *
 * It is a placeholder. Ticket 03 ships `migrations/core` with the Core's
 * `signals` and `runs` tables and a descriptor of its own; this folder, this
 * module and this export go then, and the packaging check points at the Core's
 * descriptor instead.
 *
 * The relative `../migrations/scaffold` is what makes `dist` mirroring `src`
 * load-bearing: the same relative path has to reach the same folder from
 * `src/scaffold.ts` and from `dist/scaffold.js`.
 */
export const scaffoldMigrations: MigrationDescriptor = {
  folder: new URL("../migrations/scaffold", import.meta.url),
  schema: "saf_scaffold",
  table: "__migrations",
};
