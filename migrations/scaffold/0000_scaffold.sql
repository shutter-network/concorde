-- Applied only by `npm run check:package`, which installs the packed tarball
-- into a scratch project and calls `store.migrate(scaffoldMigrations)` from
-- there. Creating a table rather than doing nothing is the point: a folder that
-- resolved to the wrong place, or whose `.sql` files did not ship, leaves
-- nothing to insert into and the check fails.
--
-- No `CREATE SCHEMA` here. `store.migrate` creates the descriptor's schema, and
-- the tracking table lives in it, so a generated `CREATE SCHEMA` line has to be
-- removed from every migration folder we ship or the first migration fails on a
-- schema that already exists.
--
-- Ticket 03 replaces this folder with `migrations/core`; see `src/scaffold.ts`.
CREATE TABLE "saf_scaffold"."applied" (
	"id" serial PRIMARY KEY NOT NULL
);
