/**
 * The Core's contribution to the Agent server: reading prior Signals and Runs.
 *
 * A **Fastify plugin**, and not a monolithic API object handed the whole Gateway.
 * Whichever part owns the concern contributes the routes, through Fastify's own
 * plugin mechanism, because there is no plugin contract of ours for it to satisfy
 * (ADR-0021). Two consequences follow from that and are the reason it is shaped this
 * way rather than registered by the Core on a server it was constructed with:
 * switching an endpoint group off is *not registering the plugin* (ADR-0010), and the
 * prefix, the ordering, and anything else Fastify offers stay the Operator's.
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
 * instead of never. Lists are envelopes rather than bare arrays, so a later cursor or
 * count has somewhere to go.
 *
 * Nothing here writes. The agent's writes belong to the parts that own what is
 * written — the Messenger for Messages, the Scheduler for schedules — and the Core
 * has nothing an agent may change: a Signal is immutable but for the state the worker
 * gives it, and a Run is the worker's record of its own work.
 */

import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Db } from "../store/index.ts";
import { type coreTables, type RunState, runs, type SignalState, signals } from "./schema.ts";

/** A handle typed to the Core's own tables, and to no other part's (ADR-0022). */
export type CoreDb = Db<typeof coreTables>;

/**
 * A Signal as the agent reads it, and the JSON one route answers with.
 *
 * The Signal's own `payload` reaches the agent as the Producer wrote it — the Core
 * never interpreted it and does not start here. `emittedAt` is an ISO 8601 string
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
 * a fresh Session, whose generated name the Core never learns (ADR-0016). The
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
 * How many records a list answers with by default, and the most it will.
 *
 * A cap rather than a cursor, and the limit that follows is worth stating plainly:
 * with no cursor and no offset, **the records past `maxLimit` are unreachable** except
 * by narrowing with `kind` or `signalId`. ADR-0011 says the agent may read every
 * Signal, and it is not being refused any of them — there is simply no paging yet,
 * because no Run has had a use for it. When one does, the cursor goes in the envelope
 * alongside the list, which is why the list is an envelope.
 */
const defaultLimit = 50;
const maxLimit = 200;

const limitSchema = {
  type: "integer",
  minimum: 1,
  maximum: maxLimit,
  default: defaultLimit,
} as const;

/**
 * The shape of an id in a path or a query.
 *
 * Validated rather than passed through, because PostgreSQL refuses to cast a
 * malformed uuid and the agent would get a 500 out of a mistyped path instead of the
 * 400 it earned. Spelled as a pattern rather than `format: "uuid"`, which needs an
 * ajv plugin Fastify does not bundle.
 */
const idSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
} as const;

const idParams = {
  type: "object",
  properties: { id: idSchema },
  required: ["id"],
  additionalProperties: false,
} as const;

/**
 * The Core's read routes, over a handle to the Core's own tables.
 *
 * Takes the handle rather than the Store, so this plugin can read the Core's tables
 * and nothing else.
 */
export function agentReadRoutes(db: CoreDb): FastifyPluginAsync {
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
        const rows = await db
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
        const [row] = await db.select().from(signals).where(eq(signals.id, request.params.id));
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
        const rows = await db
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
        const [row] = await db.select().from(runs).where(eq(runs.id, request.params.id));
        if (row === undefined) return notFound(reply, "Run", request.params.id);
        return asRunRecord(row);
      },
    );
  };
}

/**
 * Refuses a query parameter this route does not have, before validation strips it.
 *
 * A hook rather than the schema, because Fastify's ajv is configured with
 * `removeAdditional`, so `additionalProperties: false` deletes an unknown parameter
 * and answers the request as though it had never been written. That default is wrong
 * for this surface twice over: `?limt=5` quietly returning fifty records is a misread
 * nobody sees, and `?session=user_a` quietly returning every Session's Signals is the
 * exact mistake ADR-0011 forbids designing for. The schema keeps
 * `additionalProperties: false` anyway — it is what documents the parameter list, and
 * this hook is what makes it a refusal.
 */
function rejectUnknownQuery(...allowed: readonly string[]) {
  // `query` is `unknown` rather than a record, because a route with no `Querystring`
  // type is exactly where this hook matters most and Fastify types its query that
  // way. Narrowed rather than asserted: there is no shape to promise here.
  return async (
    request: { readonly query: unknown },
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    const written =
      typeof request.query === "object" && request.query !== null ? Object.keys(request.query) : [];
    const unexpected = written.filter((parameter) => !allowed.includes(parameter));
    if (unexpected.length === 0) return undefined;
    const takes = allowed.length === 0 ? "no parameters" : allowed.join(", ");
    return reply.code(400).send({
      statusCode: 400,
      error: "Bad Request",
      message: `${unexpected.map((parameter) => JSON.stringify(parameter)).join(", ")} is not a parameter of this route, which takes ${takes}. Reads are not scoped by Session or by User, so there is no such parameter to pass.`,
    });
  };
}

/**
 * The 404 body, in the shape Fastify's own errors use, so the surface answers one
 * error shape rather than two.
 */
function notFound(reply: FastifyReply, what: string, id: string): FastifyReply {
  return reply
    .code(404)
    .send({ statusCode: 404, error: "Not Found", message: `no ${what} ${id} exists` });
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
