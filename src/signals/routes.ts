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

const unscoped =
  "Reads are not scoped by Session or by User, so there is no such parameter to pass, and the Session your own Run is in changes nothing about what you get back.";

const capped = `${cappedLimit} There is no cursor and no offset, so the records past the cap are reachable only by narrowing.`;

const noParameters = `This route takes no query parameters at all. ${unknownParameter}`;
const malformedId = "The id in the path is not a uuid, or a query parameter was written.";

const rejectUnknownQuery = unknownQueryRefusal(unscoped);

const signalRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
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
      enum: signalStates,
      description:
        "How far the Signal got. One-way: nothing returns to `pending`, and a failed Signal is never re-run, so `error` is the whole of what happened to it.",
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
    context: {
      description:
        "What this Run's Signal Handler wrote beside the Prompt, exactly as written, or `null` if it wrote none. Operator-defined JSON that the framework stores and hands to the Agent server while the Run is in flight, and reads none of: a refusal you met from a hook on this server is explained by this field, and by the Operator's hook, rather than by anything the framework decided.",
    },
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
    context: row.context,
    state: row.state,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}
