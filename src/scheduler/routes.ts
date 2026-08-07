/**
 * A Fastify plugin, like every other component's routes, registered at no prefix on the Agent
 * server the Scheduler is constructed with. Passing no server registers none of it, and that switch
 * does double duty: a self-waking agent is a load on the one serial worker lane, and a
 * prompt-injectable one is a hand on the Operator's own Schedules.
 *
 * | Route | Answers |
 * | --- | --- |
 * | `PUT /schedules/:name` | Upsert. 201 with the read model on create, 200 on update, 400 on a spec that will not fire. |
 * | `GET /schedules` | Every live Schedule, ascending by `nextFireAt`, capped envelope, no cursor. 200. |
 * | `GET /schedules/:name` | 200 with the read model, or 404. |
 * | `DELETE /schedules/:name` | Cancel. 204, or 404 on an unknown name. |
 *
 * Addressing is by name, and this is the one family in the framework that does it. A Schedule's
 * identity is a key its caller chose, so `PUT` on that key is the honest verb for create-or-update
 * and `nameParams` rather than `idParams` is what guards the path. `PUT` carries no 404, which
 * leaves 201-versus-200 as the only signal of which happened. Nothing here is scoped by creator.
 *
 * Validation is two layers, and it has to be. The schema layer refuses an unknown `kind` and a spec
 * missing its `at` or `expr`, and pattern-checks the path `name`. But Fastify's ajv runs with
 * `removeAdditional`, so `additionalProperties: false` deletes an unknown field instead of refusing
 * it, and `rejectUnknownScheduleBody` below is what turns three of those into 400s. The handler
 * layer then checks the values ajv never looks at: an `expr` `cron-parser` rejects, a `tz` luxon
 * does not know, a malformed `at` or `until`, and a `once` already past.
 *
 * Every route declares what it answers with. A response schema is the serializer
 * `fast-json-stringify` compiles, so a field of the read model forgotten in one is dropped from the
 * wire and from the document with no warning anywhere. The round-trip assertions in
 * `routes.test.ts` are what notice.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  cappedLimit,
  limitSchema,
  nameParams,
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
} from "./schedules.ts";

/**
 * What the routes need of the Scheduler, and no more.
 *
 * A narrow object rather than the whole Component, so this plugin reaches the table through these
 * five and nothing else. `now` is the Scheduler's own clock, so the past-instant refusal is judged
 * against the same instant a fire would be.
 */
export type ScheduleRouteOperations = {
  readonly now: () => Date;
  schedule(input: ScheduleInput): Promise<ScheduleOutcome>;
  list(limit: number): Promise<ScheduleRecord[]>;
  read(name: string): Promise<ScheduleRecord | undefined>;
  cancel(name: string): Promise<boolean>;
};

// No `name` here: it is the path and never the body, so a request cannot name one Schedule in the
// path and another beside it.
type ScheduleBody = {
  readonly spec: ScheduleSpec;
  readonly data?: unknown;
  readonly until?: string;
};

// An empty schema, which passes any JSON through intact and renders as "any" in the document. The
// same shape `signals.payload` uses. Constraining it would be the Scheduler having an opinion about
// bytes it copies verbatim.
const dataSchema = {
  description:
    "Arbitrary JSON, echoed verbatim in the fired Signal's payload. The Scheduler never interprets it, so what a Schedule carries is the creator's convention and their Signal Handler is where it is read. Omitted, it is stored as null.",
} as const;

// `at` is a plain string and the handler parses it, because ajv cannot tell an ISO instant from any
// other string.
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

// `expr` and `tz` are likewise validated in the handler, by `cron-parser` and luxon.
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

// This documents the shape rather than enforcing it: `additionalProperties: false` strips under
// `removeAdditional`, so the refusal a caller reads comes from the hook below. The `oneOf` on `kind`
// is the exception, and is what makes an unknown `kind` a schema-layer 400.
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

// `tz` is required on the way out and optional on the way in, a stored cron always having a
// resolved zone. The `enum` on `kind` is what lets `fast-json-stringify` pick the arm to serialise
// a record through.
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

// The read model on the wire, written as the fields that can be answered. A field added to
// `ScheduleRecord` and forgotten here goes missing from the answers and the document both, in
// silence; see the file header. `nextFireAt` is a required plain string and not nullable, because a
// read answers only live Schedules and a create that would arm nothing is refused first.
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

// An envelope rather than a bare array, as every component's list is.
const scheduleListSchema = {
  type: "object",
  properties: { schedules: { type: "array", items: scheduleRecordSchema } },
  required: ["schedules"],
} as const;

// `type: "null"` and not an empty object: that is the spelling Fastify's serializer answers an empty
// 204 against without a 500, and the one `@fastify/swagger` documents with no `content`. The same
// spelling and the same reason as the User Manager's.
function noBody(why: string) {
  return { type: "null", description: why } as const;
}

function badSpec(reply: FastifyReply, error: ScheduleSpecError): FastifyReply {
  return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: error.message });
}

// The keys each `kind` takes, so the hook below refuses against the same set the schema declares.
// The one duplication `unknownQueryRefusal` also accepts, `removeAdditional` meaning the schema
// cannot be the refusal.
const specKeys = {
  once: ["kind", "at"],
  cron: ["kind", "expr", "tz"],
} as const;

/**
 * The body's counterpart of `unknownQueryRefusal`, run in `preValidation` before
 * `removeAdditional` deletes the evidence. It turns three things into 400s: an unknown top-level
 * field, an unknown field inside a `spec` of a known `kind`, and a `once` carrying a cron-only
 * `until`.
 *
 * It narrows rather than asserts, and must stay that way. An unknown `kind` and a malformed shape
 * are the schema's `oneOf` to refuse, with the required fields it lacks. Widening this into a
 * validator would be a second, worse copy of the schema.
 */
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

// Said on the three routes that take a path name, and written once.
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
        // The body hook and the shared query refusal both run. A write is no less bound by the
        // convention that an unknown query parameter is a 400.
        preValidation: [rejectUnknownScheduleBody, rejectUnknownQuery()],
      },
      async (request, reply) => {
        const input: ScheduleInput = {
          name: request.params.name,
          spec: request.body.spec,
          data: request.body.data,
          // Spread only when present: `exactOptionalPropertyTypes` distinguishes an absent `until`
          // from one explicitly `undefined`, and the programmatic `until?` is the former.
          ...(request.body.until !== undefined ? { until: request.body.until } : {}),
        };
        // Validated before anything is written, so a 400 never mutates a stored Schedule. Only a
        // create with an assured live fire reaches the upsert, which keeps `nextFireAt` non-null.
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
