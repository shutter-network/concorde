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
 *
 * Every route also **describes what it answers with**, which is how an Agent
 * Implementation learns the four paths, the two record shapes and the three surprising
 * behaviours above without an Operator transcribing them into its instructions
 * ([ADR-0040](../../docs/adr/0040-the-gateway-describes-its-own-http-api.md)). The
 * sentences below are therefore load-bearing prose rather than commentary: they are what
 * `/openapi.json` serves.
 */

import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Handle } from "../db/index.ts";
import {
  cappedLimit,
  idParams,
  idSchema,
  limitSchema,
  notFound,
  refused,
  unknownParameter,
  unknownQueryRefusal,
} from "../route-conventions.ts";
import {
  type RunState,
  runStates,
  runs,
  type SignalState,
  signalStates,
  signals,
  type workerTables,
} from "./schema.ts";

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
 * plain name rather than a reference to anything (ADR-0016). Every Run the Worker
 * records now has one, a fresh Session included, since the Worker names that one after
 * the Run itself (ADR-0033); it stays `string | null` here because rows written before
 * it did that are still readable, and the agent should meet the same `null` the column
 * holds rather than a name invented for it. The timings are ISO 8601 strings, or `null`
 * for a Run that has not reached that point.
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
 * The one sentence this whole surface turns on, and the one an agent is likeliest to
 * assume the opposite of.
 *
 * It is said in two places and written once: it is how the refusal below ends, and it is
 * in the description of all four routes here. `?session=user_a` quietly returning
 * every Session's Signals is the exact mistake ADR-0011 forbids designing for, so a
 * deployment that believed it was scoping something finds out at the first request
 * instead of never, and an agent that reads the document first never believes it at all.
 */
const unscoped =
  "Reads are not scoped by Session or by User, so there is no such parameter to pass.";

/**
 * What a list route here says about its `limit`: the shared two sentences, and the one
 * this surface adds.
 *
 * Both lists offer a filter, so the records past the cap are reachable by narrowing with
 * it rather than unreachable, which is the sentence the conventions module leaves to the
 * part.
 */
const capped = `${cappedLimit} There is no cursor and no offset, so the records past the cap are reachable only by narrowing.`;

/**
 * What the two single-record routes say, both of them being the same route with a
 * different table behind it.
 */
const noParameters = `This route takes no query parameters at all. ${unknownParameter}`;
const malformedId = "The id in the path is not a uuid, or a query parameter was written.";

/**
 * The refusal these routes answer an unknown query parameter with.
 *
 * The convention and its reasoning are in `route-conventions.ts`; what is this part's
 * own is the sentence the message ends with.
 */
const rejectUnknownQuery = unknownQueryRefusal(unscoped);

/**
 * `SignalRecord` on the wire, and **the serializer the routes answer through** rather
 * than a description of one.
 *
 * Fastify compiles a response schema with `fast-json-stringify`, which drops every field
 * the schema does not declare and says nothing about it, so a field added to the type
 * above and forgotten here is silently missing from the Agent server's answers
 * ([ADR-0040](../../docs/adr/0040-the-gateway-describes-its-own-http-api.md)). That is
 * why `gateway.test.ts` reads a Signal the Worker actually recorded and compares
 * the whole body: the drift this shape can cause is invisible from either side alone.
 *
 * The property descriptions are only on the fields whose name is not the whole story.
 * `id` and `kind` get none; `payload`, `emittedAt` and `state` are what an agent would
 * otherwise have to be told by hand.
 */
const signalRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    // No `type` at all, which is an empty schema: it passes any JSON value through byte
    // intact and renders in the document as "any". Constraining it would be the Signal
    // Worker having an opinion about a payload it never interprets.
    payload: {
      description:
        "Arbitrary JSON, exactly as the Producer wrote it. The Signal Worker never interprets a payload, so what a given `kind` carries is the Operator's convention and their Signal Handler is where it is stated.",
    },
    emittedAt: {
      type: "string",
      description:
        "When the Signal was written, ISO 8601, since JSON has no date. It is also the queue's order: the oldest pending Signal is claimed first.",
    },
    state: {
      type: "string",
      // From the same array the type is, so a state added to one is added to both.
      enum: signalStates,
      description:
        "How far the Signal got. One-way: nothing returns to `pending`, and a failed Signal is never re-run, so `error` is the whole of what happened to it.",
    },
    error: { type: "string", nullable: true },
  },
  required: ["id", "kind", "payload", "emittedAt", "state", "error"],
} as const;

/** `RunRecord` on the wire, with the same force and the same hazard as the shape above. */
const runRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    signalId: { type: "string" },
    session: { type: "string", nullable: true },
    prompt: { type: "string" },
    state: {
      type: "string",
      enum: runStates,
      description:
        "How the Run ended, or that it has not. One-way, and there is no `timed_out`, because the framework imposes no timeouts of any kind.",
    },
    error: { type: "string", nullable: true },
    startedAt: { type: "string", nullable: true },
    endedAt: { type: "string", nullable: true },
  },
  required: ["id", "signalId", "session", "prompt", "state", "error", "startedAt", "endedAt"],
} as const;

/**
 * A list answers in an envelope rather than as a bare array, which is the convention in
 * `route-conventions.ts` and the place a cursor would go if paging is ever wanted.
 */
const signalListSchema = {
  type: "object",
  properties: { signals: { type: "array", items: signalRecordSchema } },
  required: ["signals"],
} as const;

const runListSchema = {
  type: "object",
  properties: { runs: { type: "array", items: runRecordSchema } },
  required: ["runs"],
} as const;

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
          tags: ["Signals"],
          summary: "Read prior Signals, newest first",
          description: `Every Signal this Gateway has, in arrival order reversed, whichever Producer emitted it. ${unscoped} ${capped} ${unknownParameter}`,
          querystring: {
            type: "object",
            properties: { limit: limitSchema, kind: { type: "string" } },
            additionalProperties: false,
          },
          response: {
            200: {
              ...signalListSchema,
              description: "The Signals that matched, newest first.",
            },
            400: refused(
              "The `limit` is out of range or not an integer, or a parameter this route does not take was written.",
            ),
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
      {
        schema: {
          tags: ["Signals"],
          summary: "Read one Signal by id",
          description: `One Signal, whatever produced it and whatever Session the reader is in. ${unscoped} ${noParameters}`,
          params: idParams,
          response: {
            200: { ...signalRecordSchema, description: "The Signal." },
            400: refused(malformedId),
            404: refused("No Signal has that id."),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
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
          tags: ["Runs"],
          summary: "Read prior Runs, newest first",
          description: `Every Run this Gateway has recorded, newest first, in every Session. ${unscoped} \`signalId\` narrows to the Runs one Signal produced. ${capped} ${unknownParameter}`,
          querystring: {
            type: "object",
            properties: { limit: limitSchema, signalId: idSchema },
            additionalProperties: false,
          },
          response: {
            200: {
              ...runListSchema,
              description:
                "The Runs that matched, newest first by `startedAt`, which puts a Run that has not started yet at the front, since it has no start time to order by.",
            },
            400: refused(
              "The `limit` is out of range or not an integer, `signalId` is not a uuid, or a parameter this route does not take was written.",
            ),
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
      {
        schema: {
          tags: ["Runs"],
          summary: "Read one Run by id",
          description: `One Run, in whatever Session it executed. ${unscoped} ${noParameters}`,
          params: idParams,
          response: {
            200: { ...runRecordSchema, description: "The Run." },
            400: refused(malformedId),
            404: refused("No Run has that id."),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
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
