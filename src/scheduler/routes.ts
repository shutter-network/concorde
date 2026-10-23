import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  cappedLimit,
  limitSchema,
  notFound,
  refused,
  unknownParameter,
  unknownQueryRefusal,
} from "../route-conventions.ts";
import {
  assertCreatable,
  type ScheduleInput,
  type ScheduleOutcome,
  type ScheduleRecord,
  type ScheduleSpec,
  ScheduleSpecError,
  scheduleNamePattern,
} from "./schedules.ts";

const nameParams = {
  type: "object",
  properties: { name: { type: "string", pattern: scheduleNamePattern } },
  required: ["name"],
  additionalProperties: false,
} as const;

export type ScheduleRouteOperations = {
  readonly now: () => Date;
  schedule(input: ScheduleInput): Promise<ScheduleOutcome>;
  list(limit: number): Promise<ScheduleRecord[]>;
  read(name: string): Promise<ScheduleRecord | undefined>;
  cancel(name: string): Promise<boolean>;
};

type ScheduleBody = {
  readonly spec: ScheduleSpec;
  readonly data?: unknown;
  readonly until?: string;
};

const dataSchema = {
  description:
    "Application-defined JSON copied into the schedule-fired signal payload. Defaults to null.",
} as const;

const onceSpecInSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["once"] },
    at: {
      type: "string",
      description: "One-shot fire time in ISO 8601. Must be valid and in the future.",
    },
  },
  required: ["kind", "at"],
  additionalProperties: false,
} as const;

const cronSpecInSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["cron"] },
    expr: {
      type: "string",
      description: "Cron expression. Invalid expressions return 400.",
    },
    tz: {
      type: "string",
      description:
        "IANA time zone for the cron expression. Defaults to UTC; unknown zones return 400.",
    },
  },
  required: ["kind", "expr"],
  additionalProperties: false,
} as const;

const scheduleBodySchema = {
  type: "object",
  properties: {
    spec: { oneOf: [onceSpecInSchema, cronSpecInSchema] },
    data: dataSchema,
    until: {
      type: "string",
      description:
        "Inclusive end time for a recurring schedule, in ISO 8601. Not accepted for one-shot schedules.",
    },
  },
  required: ["spec"],
  additionalProperties: false,
} as const;

const onceSpecOutSchema = {
  type: "object",
  properties: { kind: { type: "string", enum: ["once"] }, at: { type: "string" } },
  required: ["kind", "at"],
  additionalProperties: false,
} as const;

const cronSpecOutSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["cron"] },
    expr: { type: "string" },
    tz: { type: "string" },
  },
  required: ["kind", "expr", "tz"],
  additionalProperties: false,
} as const;

const scheduleRecordSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    spec: { oneOf: [onceSpecOutSchema, cronSpecOutSchema] },
    data: dataSchema,
    until: {
      type: "string",
      nullable: true,
      description: "Recurring schedule end time, or null. Always null for one-shot schedules.",
    },
    nextFireAt: {
      type: "string",
      description:
        "Next fire time in ISO 8601. Only schedules with a future occurrence can be created through this route.",
    },
  },
  required: ["name", "spec", "data", "until", "nextFireAt"],
} as const;

const scheduleListSchema = {
  type: "object",
  properties: { schedules: { type: "array", items: scheduleRecordSchema } },
  required: ["schedules"],
} as const;

function noBody(why: string) {
  return { type: "null", description: why } as const;
}

function badSpec(reply: FastifyReply, error: ScheduleSpecError): FastifyReply {
  return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: error.message });
}

const specKeys = {
  once: ["kind", "at"],
  cron: ["kind", "expr", "tz"],
} as const;

async function rejectUnknownScheduleBody(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  const body = request.body;
  if (typeof body !== "object" || body === null) return undefined;
  const refuse = (message: string) =>
    reply.code(400).send({ statusCode: 400, error: "Bad Request", message });
  const named = (keys: readonly string[]) => keys.map((key) => JSON.stringify(key)).join(", ");

  const topUnknown = Object.keys(body).filter((key) => !["spec", "data", "until"].includes(key));
  if (topUnknown.length > 0) {
    return refuse(
      `Unknown schedule field(s): ${named(topUnknown)}. Accepted: spec, data, and until for recurring schedules.`,
    );
  }

  const spec = (body as { spec?: unknown }).spec;
  if (typeof spec === "object" && spec !== null) {
    const kind = (spec as { kind?: unknown }).kind;
    if (kind === "once" || kind === "cron") {
      const allowed = specKeys[kind];
      const specUnknown = Object.keys(spec).filter((key) => !allowed.includes(key as never));
      if (specUnknown.length > 0) {
        return refuse(
          `Unknown ${kind} spec field(s): ${named(specUnknown)}. Accepted: ${allowed.join(", ")}.`,
        );
      }
      if (kind === "once" && "until" in body) {
        return refuse("until is only supported for recurring schedules.");
      }
    }
  }
  return undefined;
}

const malformedName =
  "The name must contain 1–128 letters, digits, dots, dashes, or underscores. Query parameters are not accepted.";

export function scheduleRoutes(operations: ScheduleRouteOperations): FastifyPluginAsync {
  const rejectUnknownQuery = unknownQueryRefusal(
    "Schedules are shared; there is no creator filter.",
  );
  return async (fastify) => {
    fastify.put<{ Params: { name: string }; Body: ScheduleBody }>(
      "/schedules/:name",
      {
        schema: {
          tags: ["Schedules"],
          summary: "Create or replace a schedule",
          description: `Creates a schedule or replaces the one with this name. Returns 201 for a new name and 200 for an update. Rejects schedules with no future occurrence, including past one-shot times or recurring schedules whose next occurrence is after until. ${unknownParameter}`,
          params: nameParams,
          body: scheduleBodySchema,
          response: {
            200: {
              ...scheduleRecordSchema,
              description: "The updated schedule.",
            },
            201: { ...scheduleRecordSchema, description: "The created schedule." },
            400: refused(
              "Invalid name, spec, time zone, or timestamp; no future occurrence; an unknown field or kind; until on a one-shot schedule; or a query parameter.",
            ),
          },
        },
        preValidation: [rejectUnknownScheduleBody, rejectUnknownQuery()],
      },
      async (request, reply) => {
        const input: ScheduleInput = {
          name: request.params.name,
          spec: request.body.spec,
          data: request.body.data,
          ...(request.body.until !== undefined ? { until: request.body.until } : {}),
        };
        try {
          assertCreatable(input, operations.now());
        } catch (error) {
          if (error instanceof ScheduleSpecError) return badSpec(reply, error);
          throw error;
        }
        const outcome = await operations.schedule(input);
        return reply.code(outcome.created ? 201 : 200).send(outcome.schedule);
      },
    );

    fastify.get<{ Querystring: { limit: number } }>(
      "/schedules",
      {
        schema: {
          tags: ["Schedules"],
          summary: "List schedules by next fire time",
          description: `Lists active schedules by nextFireAt, then name. Completed and cancelled schedules are removed. ${cappedLimit} There is no paging or filtering; schedules beyond the maximum list size require a lookup by name. ${unknownParameter}`,
          querystring: {
            type: "object",
            properties: { limit: limitSchema },
            additionalProperties: false,
          },
          response: {
            200: { ...scheduleListSchema, description: "Active schedules in next-fire order." },
            400: refused("Invalid limit or an unknown query parameter."),
          },
        },
        preValidation: rejectUnknownQuery("limit"),
      },
      async (request) => ({ schedules: await operations.list(request.query.limit) }),
    );

    fastify.get<{ Params: { name: string } }>(
      "/schedules/:name",
      {
        schema: {
          tags: ["Schedules"],
          summary: "Read a schedule by name",
          description: `Returns an active schedule. Completed, cancelled, and unknown names return 404. ${unknownParameter}`,
          params: nameParams,
          response: {
            200: { ...scheduleRecordSchema, description: "The Schedule." },
            400: refused(malformedName),
            404: refused("No active schedule has this name."),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => {
        const record = await operations.read(request.params.name);
        if (record === undefined) return notFound(reply, "Schedule", request.params.name);
        return record;
      },
    );

    fastify.delete<{ Params: { name: string } }>(
      "/schedules/:name",
      {
        schema: {
          tags: ["Schedules"],
          summary: "Cancel a schedule",
          description: `Removes the schedule and prevents future occurrences. Returns 204 on success or 404 if the name is not active. ${unknownParameter}`,
          params: nameParams,
          response: {
            204: noBody("Schedule cancelled. No response body."),
            400: refused(malformedName),
            404: refused("No active schedule has this name."),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => {
        const removed = await operations.cancel(request.params.name);
        if (!removed) return notFound(reply, "Schedule", request.params.name);
        return reply.code(204).send();
      },
    );
  };
}
