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
    "Arbitrary JSON, echoed verbatim in the fired Signal's payload. The Scheduler never interprets it, so what a Schedule carries is the creator's convention and their Signal Handler is where it is read. Omitted, it is stored as null.",
} as const;

const onceSpecInSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["once"] },
    at: {
      type: "string",
      description:
        "The single absolute instant to fire at, ISO 8601. Refused as a 400 if malformed or already past.",
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
      description: "A cron expression, parsed by cron-parser. A malformed one is a 400.",
    },
    tz: {
      type: "string",
      description:
        "The IANA time zone the expression is evaluated in. Omitted, it is UTC. An unknown zone is a 400.",
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
        "A cron Schedule's optional end instant, ISO 8601: after its last occurrence at or before this, the Schedule is retired. Meaningless for a once, which bounds itself by firing once, so a once carrying one is a 400.",
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
      description:
        "The cron end instant if the Schedule has one, else null. Always null for a once.",
    },
    nextFireAt: {
      type: "string",
      description:
        "When the Schedule next fires, ISO 8601. Always present: reads answer only live Schedules, and a create that would resolve to no future fire is a 400 rather than a spent record.",
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
      `${named(topUnknown)} is not a field of a Schedule, which takes spec, data, and (for a cron) until.`,
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
          `${named(specUnknown)} is not a field of a ${kind} spec, which takes ${allowed.join(", ")}.`,
        );
      }
      if (kind === "once" && "until" in body) {
        return refuse(
          "until bounds a cron Schedule; a once fires a single instant and takes none.",
        );
      }
    }
  }
  return undefined;
}

const malformedName =
  "The name in the path is not a legible url-safe key of up to 128 letters, digits, dots, dashes or underscores, or a query parameter was written.";

export function scheduleRoutes(operations: ScheduleRouteOperations): FastifyPluginAsync {
  const rejectUnknownQuery = unknownQueryRefusal(
    "Schedules are not scoped by creator, so there is no such parameter to pass.",
  );
  return async (fastify) => {
    fastify.put<{ Params: { name: string }; Body: ScheduleBody }>(
      "/schedules/:name",
      {
        schema: {
          tags: ["Schedules"],
          summary: "Create or update a Schedule by name",
          description: `Create-or-update the Schedule this \`name\` addresses. An upsert, so a retry or a revised plan converges to one Schedule rather than a duplicate. Answers **201** when the name was new and **200** when it already existed, each with the resulting read model. There is no 404, since a \`PUT\` on an absent name creates it. The \`name\` is the sole identifier and comes from the path.\n\nA create that could never fire is a **400** rather than a stored Schedule that never fires. That covers a \`once\` already past, and a cron whose \`until\` sits at or before its next occurrence. This route takes no query parameters at all. ${unknownParameter}`,
          params: nameParams,
          body: scheduleBodySchema,
          response: {
            200: {
              ...scheduleRecordSchema,
              description: "The Schedule as it now stands, updated.",
            },
            201: { ...scheduleRecordSchema, description: "The Schedule as created." },
            400: refused(
              "The path `name` is malformed, a query parameter was written, an unknown field or an unknown `kind` was sent, a `once` carried a cron-only `until`, the cron `expr` is invalid or its `tz` unknown, or the `at`/`until` is malformed or the `once` instant already past.",
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
          summary: "List Schedules, soonest to fire first",
          description: `Every live Schedule, ascending by \`nextFireAt\` so the next to fire is first. \`name\` breaks a tie. A spent or cancelled Schedule is absent, because the row *is* the arming. ${cappedLimit} There is no cursor and no offset. The Schedules past the cap are reachable only by raising the limit or narrowing the arrangement. ${unknownParameter}`,
          querystring: {
            type: "object",
            properties: { limit: limitSchema },
            additionalProperties: false,
          },
          response: {
            200: { ...scheduleListSchema, description: "The live Schedules, soonest fire first." },
            400: refused(
              "The `limit` is out of range or not an integer, or a parameter this route does not take was written.",
            ),
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
          summary: "Read one Schedule by name",
          description: `The live Schedule this \`name\` addresses, or a 404 when none does. A Schedule that fired out or was cancelled is gone, so this answers only what is still arranged. This route takes no query parameters at all. ${unknownParameter}`,
          params: nameParams,
          response: {
            200: { ...scheduleRecordSchema, description: "The Schedule." },
            400: refused(malformedName),
            404: refused("No live Schedule has that name."),
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
          summary: "Cancel a Schedule by name",
          description: `Cancel the Schedule this \`name\` addresses, and stop every future fire. **204** on success, and **404** on a name that addresses none. An unknown name is refused rather than answered an idempotent 204. So a caller learns a Schedule was already gone rather than being told it stopped nothing. This route takes no query parameters at all. ${unknownParameter}`,
          params: nameParams,
          response: {
            204: noBody("The Schedule was cancelled; every future fire is stopped."),
            400: refused(malformedName),
            404: refused("No live Schedule has that name to cancel."),
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
