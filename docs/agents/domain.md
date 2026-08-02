# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase. This repo is **single-context**: one `CONTEXT.md` at the
root, one `docs/adr/`.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary of domain terms
- **`docs/adr/`** — read the ADRs that touch the area you're about to work in.
  There are currently 36 (`0001`–`0036`), and most `CONTEXT.md` entries link to
  the ADR that decided them; follow those links rather than reading the whole set.

If any of these files don't exist, **proceed silently**. Don't flag their absence;
don't suggest creating them upfront. The `/domain-modeling` skill (reached via
`/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when
terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md          ← the glossary
├── docs/
│   ├── quickstart.md   ← the Operator's walkthrough, which mirrors example/
│   ├── architecture.md
│   ├── data-model.md
│   ├── adr/            ← 0001-…  numbered, kebab-case titles
│   └── agents/         ← this file, plus issue-tracker.md and triage-labels.md
├── src/                ← one directory per part of the Gateway
├── example/            ← the reference deployment the quickstart describes
└── .scratch/           ← issues and specs (see issue-tracker.md)
```

The whole of `src/` is one context: the glossary and `docs/adr/` above cover all of it. If
it ever grows into a multi-context repo, the signal is a root `CONTEXT-MAP.md` pointing at
per-context `CONTEXT.md` files under `src/<context>/`, each with its own `docs/adr/`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a
hypothesis, a test name), use the term as defined in `CONTEXT.md`. Each entry
carries an `_Avoid_:` line listing the synonyms this project has deliberately
rejected — treat those as banned in your output, not merely discouraged.

If the concept you need isn't in the glossary yet, that's a signal — either you're
inventing language the project doesn't use (reconsider) or there's a real gap
(note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than
silently overriding:

> _Contradicts ADR-0007 (messages carry arbitrary JSON payloads) — but worth
> reopening because…_
