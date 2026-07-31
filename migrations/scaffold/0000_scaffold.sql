-- Not a real migration. This folder is the fixture that proves `files` ships
-- migration folders and their journals, which is checked against the packed
-- tarball by `npm run check:package`. Nothing applies it.
--
-- Ticket 02 adds the first real folder alongside it, at which point this one
-- can be deleted: the check walks every folder under `migrations/`.
SELECT 1;
