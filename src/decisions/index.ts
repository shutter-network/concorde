/**
 * Decisions, from `shared-agent-framework/decisions`.
 *
 * A subpath of its own, like the User Manager's and the HTTP Messenger's, so that what a
 * deployment depends on is legible from its import statements: a deployment whose agent commits
 * to nothing imports nothing from here.
 *
 * `createDecisions` is the whole of it for an Operator: hand it the Db, Signatures, the User
 * Manager and both servers, and it registers `decisionsMigrations` with that Db and its two
 * route groups at `/decisions` on the two servers (ADR-0032). Then put it in the Gateway's
 * record like every other part: it is a Component whose `start` and `stop` do nothing, keyed
 * **before** the Signal Worker so that it is stopped after the drain, which is when a Signal
 * Handler's post phase may still publish (ADR-0037, ADR-0038).
 *
 * What it answers with is worth holding, and it is two methods: `publish`, which commits to a
 * Statement from inside the caller's own transaction, and `history`, which reads the whole log.
 * Those are what trusted code has that no request does: a write that commits with the
 * Operator's own record of why (ADR-0023), and a read a Signal Handler can build a Prompt from
 * with no Token and no route. Neither takes a User id, this log having no owner, and neither
 * takes an artifact: the signature is produced by the write path and is not an argument.
 *
 * **Construct it after Signatures**, which it holds: a Decision that was not signed is not a
 * Decision, so there is no degraded mode in which this part writes rows without artifacts. It
 * imposes **no** construction order on the User Manager, unlike the HTTP Messenger: there is no
 * foreign key here and nothing references a User at all, so this folder applies wherever it
 * lands in the migration order ([ADR-0043](../../docs/adr/0043-decisions-are-one-global-log.md)).
 *
 * `decisionsMigrations` is exported because a pre-deploy migration entry point should not have
 * to construct the part that owns the tables — and, for this part, should not have to load a
 * signing key to get at them.
 *
 * `DecisionRecord` is the one shape every surface of this part answers with, and the field on
 * it that matters is `jws`: the artifact is the Decision, and the log is where Decisions are
 * kept rather than what makes them real. A verifier holding a valid one cannot conclude that a
 * row exists and does not need to ([ADR-0042](../../docs/adr/0042-a-signature-is-a-compact-jws.md)).
 *
 * **No route plugin is exported and no prefix is configurable**, as with the HTTP Messenger and
 * for the same reason: these routes are half of a contract whose other half is the artifact
 * shape (ADR-0034).
 */

export type { DecisionRecord, Decisions, DecisionsOptions } from "./decisions.ts";
export { createDecisions } from "./decisions.ts";
export { decisionsMigrations } from "./migrations.ts";
