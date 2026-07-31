# Triage Labels

The skills speak in terms of five canonical triage roles. This repo uses two.
This file maps the canonical roles onto what we actually write.

| Label in mattpocock/skills | In this repo       | Meaning                                             |
| -------------------------- | ------------------ | --------------------------------------------------- |
| `needs-triage`             | _(does not exist)_ | We have no untriaged state — see below              |
| `needs-info`               | `needs-human`      | Something is unspecified; a human has to fill it in  |
| `ready-for-agent`          | `ready-for-agent`  | Fully specified, ready for an AFK agent              |
| `ready-for-human`          | `needs-human`      | Requires human implementation or judgement           |
| `wontfix`                  | _(does not exist)_ | We delete rejected issues instead                    |

Written as a `Status:` line near the top of each issue file. When a skill mentions
a role, use the corresponding string from this table.

## No untriaged state

Every issue is written locally by whoever runs this repo, not filed by an outside
reporter. Whoever writes it already knows whether it is agent-ready, so it gets a
`Status:` at creation. A skill should never leave an issue without one, and should
never look for a triage queue — there isn't one.

## No wontfix

A rejected issue is deleted, not labelled. If the reasoning is worth keeping,
record it as an ADR under `docs/adr/` instead.
