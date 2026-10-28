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

export type WorkerHandle = Handle<typeof signalsTables>;

export type SignalRecord = {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly emittedAt: string;
  readonly state: SignalState;
  readonly error: string | null;
};

export type RunRecord = {
  readonly id: string;
  readonly signalId: string;
  readonly session: string | null;
  readonly prompt: string;
  readonly context: unknown;
  readonly state: RunState;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
};

const unscoped = "Reads are not restricted by user or session. Neither is an accepted filter.";

const capped = `${cappedLimit} There is no cursor or offset.`;

const noParameters = `${unknownParameter}`;
const malformedId = "The id must be a UUID. Query parameters are not accepted.";

const rejectUnknownQuery = unknownQueryRefusal(unscoped);

const signalRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    payload: {
      description: "Producer-defined JSON passed unchanged to the signal handler.",
    },
    emittedAt: {
      type: "string",
      description: "Emission time in ISO 8601. Pending signals are processed oldest first.",
    },
    state: {
      type: "string",
      enum: signalStates,
      description:
        "Processing state. Failed signals are not automatically retried; error records the reason.",
    },
    error: { type: "string", nullable: true },
  },
  required: ["id", "kind", "payload", "emittedAt", "state", "error"],
} as const;

const runRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    signalId: {
      type: "string",
      description: "The signal that produced this run. A signal handler can produce several runs.",
    },
    session: {
      type: "string",
      description:
        "Session name. Fresh sessions use `run_<run id>`. Null is retained for older records created before automatic session naming.",
      nullable: true,
    },
    prompt: { type: "string" },
    context: {
      description:
        "Application-defined Prompt.context, or null. Stored on the run and exposed on agent-server requests during execution. Built-in routes do not interpret it.",
    },
    state: {
      type: "string",
      enum: runStates,
      description:
        "Execution state. The worker imposes no timeout; the runtime stops a run after its own.",
    },
    error: { type: "string", nullable: true },
    startedAt: { type: "string", nullable: true },
    endedAt: { type: "string", nullable: true },
  },
  required: [
    "id",
    "signalId",
    "session",
    "prompt",
    "context",
    "state",
    "error",
    "startedAt",
    "endedAt",
  ],
} as const;

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

export function agentReadRoutes(handle: WorkerHandle): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Querystring: { limit: number; kind?: string } }>(
      "/signals",
      {
        schema: {
          tags: ["Signals"],
          summary: "List signals, newest first",
          description: `Lists signals from all producers, newest first. ${unscoped} ${capped} ${unknownParameter}`,
          querystring: {
            type: "object",
            properties: { limit: limitSchema, kind: { type: "string" } },
            additionalProperties: false,
          },
          response: {
            200: {
              ...signalListSchema,
              description: "Matching signals, newest first.",
            },
            400: refused("Invalid limit or an unknown query parameter."),
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
          .orderBy(desc(signals.emittedAt), desc(signals.id))
          .limit(request.query.limit);
        return { signals: rows.map(asSignalRecord) };
      },
    );

    fastify.get<{ Params: { id: string } }>(
      "/signals/:id",
      {
        schema: {
          tags: ["Signals"],
          summary: "Read a signal by id",
          description: `Returns the signal with this id. ${unscoped} ${noParameters}`,
          params: idParams,
          response: {
            200: { ...signalRecordSchema, description: "The Signal." },
            400: refused(malformedId),
            404: refused("No signal has this id."),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => {
        const [row] = await handle.select().from(signals).where(eq(signals.id, request.params.id));
        if (row === undefined) return notFound(reply, "signal", request.params.id);
        return asSignalRecord(row);
      },
    );

    fastify.get<{ Querystring: { limit: number; signalId?: string } }>(
      "/runs",
      {
        schema: {
          tags: ["Runs"],
          summary: "List runs, newest first",
          description: `Lists recorded runs. Use signalId to select runs produced by one signal. ${unscoped} ${capped} ${unknownParameter}`,
          querystring: {
            type: "object",
            properties: { limit: limitSchema, signalId: idSchema },
            additionalProperties: false,
          },
          response: {
            200: {
              ...runListSchema,
              description:
                "Matching runs, descending by startedAt. Runs that have not started appear first.",
            },
            400: refused("Invalid limit or signalId UUID, or an unknown query parameter."),
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
          .orderBy(desc(runs.startedAt), desc(runs.id))
          .limit(request.query.limit);
        return { runs: rows.map(asRunRecord) };
      },
    );

    fastify.get<{ Params: { id: string } }>(
      "/runs/:id",
      {
        schema: {
          tags: ["Runs"],
          summary: "Read a run by id",
          description: `Returns the run with this id. ${unscoped} ${noParameters}`,
          params: idParams,
          response: {
            200: { ...runRecordSchema, description: "The Run." },
            400: refused(malformedId),
            404: refused("No run has this id."),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => {
        const [row] = await handle.select().from(runs).where(eq(runs.id, request.params.id));
        if (row === undefined) return notFound(reply, "run", request.params.id);
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
    context: row.context,
    state: row.state,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}
