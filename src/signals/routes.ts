/**
 * The Signal Worker's contribution to the Agent server: reading prior Signals and Runs.
 *
 * A **Fastify plugin**, and not a monolithic API object handed the whole Gateway.
 * Whichever part owns the concern contributes the routes, through Fastify's own
 * plugin mechanism, because there is no plugin contract of ours for it to satisfy
 * (ADR-0021). The Signal Worker registers this on the Agent server it is constructed
 * with, at no prefix, and both halves of that are reversible by the Operator: passing
 * no server is how the endpoint group is switched off (ADR-0010), and holding the
 * plugin — it stays on `worker.agentRoutes` — is how the prefix, the encapsulation and
 * anything else Fastify offers stay theirs (ADR-0032).
 *
 * The surface, all `GET`, all JSON, and all deliberately **unscoped** — the agent may
 * read every Signal and every Run whatever Session its Run is executing in
 * (ADR-0011):
 *
 * | Route | Answers |
 * | --- | --- |
 * | `/signals?limit=&kind=` | `{ signals: SignalRecord[] }`, newest first |
 * | `/signals/:id` | `SignalRecord`, or 404 |
 * | `/runs?limit=&signalId=` | `{ runs: RunRecord[] }`, newest first |
 * | `/runs/:id` | `RunRecord`, or 404 |
 *
 * There is no Session parameter and no User parameter, on any of them, and an unknown
 * query parameter is a 400 rather than a request answered with everything — so a
 * deployment that believed it was scoping something finds out at the first request
 * instead of never. That refusal, the pattern-validated ids, the capped limit and the
 * envelope, and the 404 body are the conventions in `route-conventions.ts`, which
 * every part's routes share; only the sentence the refusal ends with is this part's.
 * The limit's cap has a consequence worth stating here: with no cursor and no offset,
 * the records past it are reachable only by narrowing with `kind` or `signalId`.
 * ADR-0011 says the agent may read every Signal, and it is not being refused any of
 * them — there is simply no paging yet, because no Run has had a use for it.
 *
 * Nothing here writes. The agent's writes belong to the parts that own what is
 * written — the Messenger for Messages, the Scheduler for schedules — and the Signal
 * Worker has nothing an agent may change: a Signal is immutable but for the state the
 * worker gives it, and a Run is the worker's record of its own work.
 */

import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Handle } from "../db/index.ts";
import {
  idParams,
  idSchema,
  limitSchema,
  notFound,
  unknownQueryRefusal,
} from "../route-conventions.ts";
import { type RunState, runs, type SignalState, signals, type workerTables } from "./schema.ts";

/** A handle typed to the Signal Worker's own tables, and to no other part's (ADR-0022). */
export type WorkerHandle = Handle<typeof workerTables>;

/**
 * A Signal as the agent reads it, and the JSON one route answers with.
 *
 * The Signal's own `payload` reaches the agent as the Producer wrote it — the Signal
 * Worker never interpreted it and does not start here. `emittedAt` is an ISO 8601 string
 * because JSON has no date, and the `state` and `error` are included because a
 * Signal's outcome is most of what there is to know about a prior arrival: a failed
 * one is failed permanently (ADR-0017), so the reason has to be readable by whoever
 * or whatever asks next.
 */
export type SignalRecord = {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly emittedAt: string;
  readonly state: SignalState;
  readonly error: string | null;
};

/**
 * A Run as the agent reads it.
 *
 * `signalId` is the Signal whose Handler produced this Prompt, and `session` is a
 * plain name rather than a reference to anything — `null` means the Prompt asked for
 * a fresh Session, whose generated name the Signal Worker never learns (ADR-0016). The
 * timings are ISO 8601 strings, or `null` for a Run that has not reached that point.
 */
export type RunRecord = {
  readonly id: string;
  readonly signalId: string;
  readonly session: string | null;
  readonly prompt: string;
  readonly state: RunState;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
};

/**
 * The refusal these routes answer an unknown query parameter with.
 *
 * The convention and its reasoning are in `route-conventions.ts`; what is this part's
 * own is the sentence the message ends with. `?session=user_a` quietly returning every
 * Session's Signals is the exact mistake ADR-0011 forbids designing for, so the
 * refusal says outright that there is no such parameter — a deployment that believed
 * it was scoping something finds out at the first request instead of never.
 */
const rejectUnknownQuery = unknownQueryRefusal(
  "Reads are not scoped by Session or by User, so there is no such parameter to pass.",
);

/**
 * The Signal Worker's read routes, over a handle to its own tables.
 *
 * Takes the handle rather than the Db, so this plugin can read the Signal Worker's
 * tables and nothing else.
 */
export function agentReadRoutes(handle: WorkerHandle): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Querystring: { limit: number; kind?: string } }>(
      "/signals",
      {
        schema: {
          querystring: {
            type: "object",
            properties: { limit: limitSchema, kind: { type: "string" } },
            additionalProperties: false,
          },
        },
        preValidation: rejectUnknownQuery("limit", "kind"),
      },
      async (request) => {
        const rows = await handle
          .select()
          .from(signals)
          .where(
            request.query.kind === undefined ? undefined : eq(signals.kind, request.query.kind),
          )
          // Newest first, because "what has arrived" is the question this answers.
          // `id` breaks the tie, so a limit never drops one of two Signals emitted in
          // the same transaction and includes the other.
          .orderBy(desc(signals.emittedAt), desc(signals.id))
          .limit(request.query.limit);
        return { signals: rows.map(asSignalRecord) };
      },
    );

    fastify.get<{ Params: { id: string } }>(
      "/signals/:id",
      // No query parameters at all on a single record, and asking for one is refused
      // rather than ignored — for the same reason the list routes refuse: a
      // `?session=` that answers 200 reads as though it had been honoured.
      { schema: { params: idParams }, preValidation: rejectUnknownQuery() },
      async (request, reply) => {
        const [row] = await handle.select().from(signals).where(eq(signals.id, request.params.id));
        if (row === undefined) return notFound(reply, "Signal", request.params.id);
        return asSignalRecord(row);
      },
    );

    fastify.get<{ Querystring: { limit: number; signalId?: string } }>(
      "/runs",
      {
        schema: {
          querystring: {
            type: "object",
            properties: { limit: limitSchema, signalId: idSchema },
            additionalProperties: false,
          },
        },
        preValidation: rejectUnknownQuery("limit", "signalId"),
      },
      async (request) => {
        const rows = await handle
          .select()
          .from(runs)
          .where(
            request.query.signalId === undefined
              ? undefined
              : eq(runs.signalId, request.query.signalId),
          )
          // A Run has no column for when it was recorded, only for when it started, so
          // that is what orders them — and in PostgreSQL a descending sort puts nulls
          // first, which is the right end for a Run that was recorded and has not run
          // yet. Runs recorded together and not yet started share no ordering key at
          // all, so they fall back to `id`, which is not the order their Handler
          // returned them in. Recording that here rather than adding a column
          // `data-model.md` does not have.
          .orderBy(desc(runs.startedAt), desc(runs.id))
          .limit(request.query.limit);
        return { runs: rows.map(asRunRecord) };
      },
    );

    fastify.get<{ Params: { id: string } }>(
      "/runs/:id",
      // No query parameters at all on a single record, and asking for one is refused
      // rather than ignored — for the same reason the list routes refuse: a
      // `?session=` that answers 200 reads as though it had been honoured.
      { schema: { params: idParams }, preValidation: rejectUnknownQuery() },
      async (request, reply) => {
        const [row] = await handle.select().from(runs).where(eq(runs.id, request.params.id));
        if (row === undefined) return notFound(reply, "Run", request.params.id);
        return asRunRecord(row);
      },
    );
  };
}

function asSignalRecord(row: typeof signals.$inferSelect): SignalRecord {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    emittedAt: row.emittedAt.toISOString(),
    state: row.state,
    error: row.error,
  };
}

function asRunRecord(row: typeof runs.$inferSelect): RunRecord {
  return {
    id: row.id,
    signalId: row.signalId,
    session: row.session,
    prompt: row.prompt,
    state: row.state,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}
