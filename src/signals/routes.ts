/**
 * One plugin, registered by the Worker on the Agent server at no prefix, and exported on
 * `worker.agentRoutes` as well so that a deployment can place it itself.
 *
 * The routes themselves are not listed here. `scripts/reference/route-pages.ts` renders them into
 * the reference out of the declarations below, so a table beside them would be a second list to
 * keep true and nothing would compare the two.
 *
 * Unscoped by decision and not by omission: the agent reads every Signal and every Run whatever
 * Session it is in, because Session routing organises context and was never a confidentiality
 * mechanism. Do not add a `session` or a `user` parameter here. There is
 * nothing on a Signal to scope by in any case, the Worker holding no identity.
 *
 * All `GET`. Nothing here writes, a Signal being immutable but for the state the Worker gives it,
 * and a Run being the Worker's record of its own work. This is the agent's read and only the
 * agent's: a Signal Handler answers "has this arrived before?" for itself, and
 * what it has for that is a handle over `signalsTables` rather than a method on the Worker.
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
  type signalsTables,
} from "./schema/index.ts";

/** A handle typed to the Signal Worker's own tables, and to no other component's. */
export type WorkerHandle = Handle<typeof signalsTables>;

/**
 * A Signal as the agent reads it, and the JSON two of these routes answer with.
 *
 * The `payload` arrives as the Producer wrote it, and `emittedAt` as an ISO 8601 string, JSON
 * having no date.
 *
 * `state` and `error` are here, where {@link Signal} has neither: what there is to know about a
 * prior arrival is mostly how it ended, and since a failed Signal is failed for good, the reason
 * has to be readable by whoever finds it.
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
 * A Run as the agent reads it: one Prompt, in one Session, and how it went.
 *
 * `signalId` is the Signal whose Handler wrote the Prompt, and `prompt` is the text the agent was
 * given rather than the template it came from. `session` is a plain name and a reference to
 * nothing. Every Run the Worker records now carries one, and it stays nullable because rows written
 * before that still hold `null`.
 *
 * The timings are ISO 8601 strings, or `null` for a Run that has not reached that point, so a
 * `running` Run has a `startedAt` and no `endedAt`.
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
 * The sentence this whole surface turns on, and the one a reader is likeliest to assume the
 * opposite of.
 *
 * Written once and said in two places: it ends the refusal below and it is in all four route
 * descriptions. Somebody who believed a read here was scoped finds out at the first request rather
 * than never.
 */
const unscoped =
  "Reads are not scoped by Session or by User, so there is no such parameter to pass, and the Session your own Run is in changes nothing about what you get back.";

/** What a list route here says about its `limit`: the shared sentences, and the one it adds. */
const capped = `${cappedLimit} There is no cursor and no offset, so the records past the cap are reachable only by narrowing.`;

/** What the two single-record routes say. Each is one route with a different table behind it. */
const noParameters = `This route takes no query parameters at all. ${unknownParameter}`;
const malformedId = "The id in the path is not a uuid, or a query parameter was written.";

/** The refusal these routes answer an unknown query parameter with. */
const rejectUnknownQuery = unknownQueryRefusal(unscoped);

/**
 * `SignalRecord` on the wire, and the serializer every answer carrying one passes through.
 *
 * Fastify compiles a response schema with `fast-json-stringify`, which drops every field the schema
 * does not declare and says nothing about it. So a field added to the type above and forgotten here
 * is missing from the Agent server's answers, and the round trip in `gateway.test.ts` is what
 * catches that.
 *
 * A description goes only on a field whose name is not the whole story.
 */
const signalRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    // No `type` at all, which is an empty schema. It passes any JSON value through byte intact
    // and renders in the document as "any". Constraining it would be the Signal Worker having an
    // opinion about a payload it never interprets.
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
    signalId: {
      type: "string",
      description:
        "The Signal whose Signal Handler wrote this Prompt. Several Runs can carry the same one, a Handler being free to answer with several Prompts.",
    },
    session: {
      type: "string",
      description:
        "The Session this Run happened in, as a plain name that refers to nothing. A Handler that asked for a fresh Session gets `run_<this Run's id>`. It is `null` only on Runs recorded before the Worker named every Session.",
      nullable: true,
    },
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
 * A list answers in an envelope rather than as a bare array, as every component's does, and that is
 * where a cursor would go the day either of these is paged.
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
 * Builds the four read routes over a handle to the Worker's own two tables.
 *
 * The handle and not the Db, so this plugin can read those tables and reach nothing else, and so
 * that it cannot open a transaction of its own.
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
          // Newest first, because "what has arrived" is the question this answers. `id` breaks
          // the tie. A limit cannot then drop one of two Signals emitted in one transaction and
          // include the other.
          .orderBy(desc(signals.emittedAt), desc(signals.id))
          .limit(request.query.limit);
        return { signals: rows.map(asSignalRecord) };
      },
    );

    fastify.get<{ Params: { id: string } }>(
      "/signals/:id",
      // No query parameters at all on a single record, and one is refused rather than ignored.
      // A `?session=` that answers 200 reads as though it had been honoured.
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
          // A Run has no column for when it was recorded, only for when it started. So that is
          // what orders them. A descending sort puts nulls first in PostgreSQL, the right end
          // for a Run that has not run yet. Runs recorded together and not yet started share no
          // ordering key. They fall back to `id` rather than their Handler's order.
          .orderBy(desc(runs.startedAt), desc(runs.id))
          .limit(request.query.limit);
        return { runs: rows.map(asRunRecord) };
      },
    );

    fastify.get<{ Params: { id: string } }>(
      "/runs/:id",
      // No query parameters at all on a single record, and one is refused rather than ignored.
      // A `?session=` that answers 200 reads as though it had been honoured.
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
