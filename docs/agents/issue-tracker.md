# Issue tracker: Local Markdown

Issues and specs (you may know a spec as a PRD) for this repo live as markdown
files in `.scratch/`. Issue management is local: there is no remote tracker, no
`gh`/`glab`, and no external contributors. Every issue is written by whoever runs
this repo.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` — never a
  single combined tickets file
- Every issue carries a `Status:` line near the top, set at creation:
  `ready-for-agent` or `needs-human` (see `triage-labels.md`)
- Comments and conversation history append to the bottom of the file under a
  `## Comments` heading

## Lifecycle

- **Open** — the file lives in `.scratch/<feature-slug>/issues/`
- **Done** — move the file to `.scratch/<feature-slug>/done/`, keeping its number
  and slug, so the numbering stays stable and the record survives
- **Rejected** — delete the file

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if
needed). Do not open a PR or call a tracker CLI.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the
issue number directly. Look in `issues/` first, then `done/`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.
Wayfinder children run their own state machine and stay in place — they are not
moved to `done/`.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`,
  with the question in the body. A `Type:` line records the ticket type
  (`research`/`prototype`/`grilling`/`task`); a `Status:` line records
  `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked
  when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open,
  unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set
  `Status: resolved`, then append a context pointer (gist + link) to the map's
  Decisions-so-far in `map.md`.
