/**
 * The Scheduler's contribution to the Agent server: creating, listing, reading, and cancelling
 * Schedules, each addressed by the `name` its creator chose.
 *
 * A **Fastify plugin**, like every other part's routes (ADR-0021). The Scheduler registers it on the
 * Agent server it is constructed with, at no prefix, and passing no server is how the whole surface
 * is switched off (ADR-0010) — the self-waking agent is a DoS on the single serial worker lane and a
 * prompt-injectable one is a hand on the Operator's own Schedules, so the switch does double duty
 * (ADR-0018).
 *
 * | Route | Answers |
 * | --- | --- |
 * | `PUT /schedules/:name` | Upsert. 201 with the read model on create, 200 on update, 400 on an invalid spec. |
 * | `GET /schedules` | Every live Schedule, ascending by `nextFireAt`, capped envelope, no cursor. 200. |
 * | `GET /schedules/:name` | 200 with the read model, or 404. |
 * | `DELETE /schedules/:name` | Cancel. 204, or 404 on an unknown name. |
 *
 * **Addressing is by name**, the sole identifier, which is the deliberate divergence from the
 * id-addressing every other Agent route uses: a Schedule's identity is a client-chosen key and `PUT`
 * on that key is the honest verb for its create-or-update (ADR-0018). `PUT` carries no 404 — it
 * creates when the name is absent — so the 201-versus-200 in its answer is the only signal of which
 * happened, read from the upsert itself. `GET` and `DELETE` carry the 404, and an unknown name on
 * `DELETE` is a 404 rather than an idempotent 204, matching the repo's honest-refusal bent.
 *
 * **The whole surface is unscoped**, like the Signal Worker's reads (ADR-0011): with the route
 * enabled the agent lists and cancels any Schedule, the Operator's included. The switch is the only
 * guard.
 *
 * **Validation is two layers**, and the split is the same one `route-conventions.ts` documents for
 * queries:
 *
 *  - **Schema layer**, a 400 before the handler. The body's `spec` is a `oneOf` on `kind`, so an
 *    unknown `kind` or a spec missing its `at`/`expr` is refused by ajv; the path `name` is
 *    pattern-checked by `nameParams`. But Fastify's ajv is configured with `removeAdditional`, which
 *    *strips* an unknown field rather than refusing it — the same hazard `unknownQueryRefusal` exists
 *    for — so `rejectUnknownScheduleBody` below is what turns an unknown body field, an unknown `spec`
 *    field, and a `once` carrying a cron-only `until` into the 400s the schema alone would silently
 *    swallow.
 *  - **Handler layer**, a 400 in the shared error shape. ajv checks none of the *values*: a cron
 *    `expr` `cron-parser` rejects, a `tz` luxon does not know, a malformed `at`/`until`, and — the one
 *    refusal that is the route's own rather than the programmatic core's — a `once` whose instant is
 *    already in the past. `assertCreatable` runs before anything is written, so a 400 never mutates a
 *    stored Schedule, and `schedule` is called only once a live fire is assured (ADR-0018).
 *
 * Every route **describes what it answers with** (ADR-0040): the record shape is a response schema
 * per status, and because that schema is the serializer `fast-json-stringify` compiles, a field of
 * the read model forgotten in it is dropped from the wire *and* the document with no warning — which
 * is what the round-trip assertions in `routes.test.ts` guard by comparing a produced record against
 * a type-checked literal.
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
 * What the routes need of the Scheduler, and no more: the clock the past-`at` refusal reads, the
 * upsert, a limited list, a read by name, and a cancel.
 *
 * A narrow object rather than the whole `Scheduler`, so the plugin reaches the part's tables through
 * these five operations and nothing else — the same reason the Signal Worker's routes take a handle
 * rather than the Db.
 */
export type ScheduleRouteOperations = {
  /** The Scheduler's own clock, so the route refuses a past `at` against the same `now` a fire uses. */
  readonly now: () => Date;
  /** Create-or-update by name, answering whether it created and with the resulting record. */
  schedule(input: ScheduleInput): Promise<ScheduleOutcome>;
  /** Every live Schedule, ascending by next fire then name, bounded by the capped `limit`. */
  list(limit: number): Promise<ScheduleRecord[]>;
  /** One live Schedule by name, or `undefined` when the name addresses none. */
  read(name: string): Promise<ScheduleRecord | undefined>;
  /** Cancel by name, answering whether one was there to cancel. */
  cancel(name: string): Promise<boolean>;
};

/**
 * The body of `PUT /schedules/:name`: the recurrence, the creator's opaque data, and a cron's
 * optional end instant. The `name` is the path and never the body, so a request cannot name one
 * Schedule in the path and another in the body.
 */
type ScheduleBody = {
  readonly spec: ScheduleSpec;
  readonly data?: unknown;
  readonly until?: string;
};

/**
 * A JSON value the Scheduler never interprets, as an empty schema — it passes any value through byte
 * intact and renders as "any" in the document, the same shape `signals.payload` uses. Constraining it
 * would be the Scheduler having an opinion about `data` it emits verbatim.
 */
const dataSchema = {
  description:
    "Arbitrary JSON, echoed verbatim in the fired Signal's payload. The Scheduler never interprets it, so what a Schedule carries is the creator's convention and their Signal Handler is where it is read. Omitted, it is stored as null.",
} as const;

/**
 * The `spec` a `once` create takes on the wire: a single absolute instant. `at` is a string here and
 * the handler is where it is parsed, because ajv cannot tell an ISO instant from any other string.
 */
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

/**
 * The `spec` a `cron` create takes on the wire: an expression and an optional zone. `tz` is optional
 * and defaults to UTC — never the server's local zone — and `expr` is validated by `cron-parser` in
 * the handler, not by ajv.
 */
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

/**
 * The body schema: `additionalProperties: false` for the shape it documents, though the refusal it
 * reads as is `rejectUnknownScheduleBody`'s and not this schema's, since `removeAdditional` strips
 * rather than refuses. `spec` is the `oneOf` on `kind` that makes an unknown `kind` a schema-layer
 * 400. `until` is a cron-only bound, and a `once` carrying one is refused by the hook.
 */
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

/**
 * The `spec` on the wire *out*: a `once` announces its instant, a `cron` its expression and the
 * resolved zone that is actually in force. `tz` is required here, unlike the request, because a
 * stored cron always has a resolved zone. The `enum` on `kind` is what lets `fast-json-stringify`
 * pick the arm to serialise a record through.
 */
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

/**
 * `ScheduleRecord` on the wire, and **the serializer every read answers through** rather than a
 * description of one.
 *
 * `fast-json-stringify` drops every field this does not declare with no warning, so a field added to
 * `ScheduleRecord` and forgotten here is silently missing from the Agent server's answers and from
 * the document both (ADR-0040) — the drift `routes.test.ts` compares a whole produced record to
 * catch. `nextFireAt` is a plain required string and not nullable: a read answers only **live**
 * Schedules and a create is refused unless it resolves to a fire, so every record this serialises has
 * one. `until` is nullable — null for a `once` and an unbounded cron — and `data` is the same
 * any-JSON shape as the body's.
 */
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

/** A list answers in an envelope rather than a bare array, the convention in `route-conventions.ts`. */
const scheduleListSchema = {
  type: "object",
  properties: { schedules: { type: "array", items: scheduleRecordSchema } },
  required: ["schedules"],
} as const;

/**
 * A response that carries no body — `type: "null"`, not an empty object — so Fastify's serializer
 * answers an empty 204 without a 500 and `@fastify/swagger` documents it with no `content` (the same
 * spelling and reason as the User Manager's `noBody`).
 */
function noBody(why: string) {
  return { type: "null", description: why } as const;
}

/** A handler-layer refusal in the shared error shape, carrying a `ScheduleSpecError`'s own message. */
function badSpec(reply: FastifyReply, error: ScheduleSpecError): FastifyReply {
  return reply.code(400).send({ statusCode: 400, error: "Bad Request", message: error.message });
}

/**
 * The keys each `spec` `kind` takes, so the body hook names the same allowed set the schema declares
 * — the one duplication `unknownQueryRefusal` also accepts, since `removeAdditional` means the schema
 * cannot be the refusal.
 */
const specKeys = {
  once: ["kind", "at"],
  cron: ["kind", "expr", "tz"],
} as const;

/**
 * Refuses an unknown field the body schema would otherwise strip silently — the body's counterpart of
 * `unknownQueryRefusal`, run in `preValidation` before `removeAdditional` deletes the evidence.
 *
 * Three things ajv strips rather than refuses under this repo's config are turned into 400s here: an
 * unknown top-level field, an unknown field inside a `spec` of a known `kind`, and a `once` carrying a
 * cron-only `until`. An unknown `kind` is left to the schema's `oneOf`, which refuses it with the
 * required fields it lacks, and a malformed shape (a non-object body, a `spec` that is not an object)
 * is left to the schema too — this hook narrows rather than asserts, refusing only what it can see is
 * a stray field on an otherwise well-formed request.
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

/** The name in the path is not the legible, url-safe key `nameSchema` requires, or a query was written. */
const malformedName =
  "The name in the path is not a legible url-safe key of up to 128 letters, digits, dots, dashes or underscores, or a query parameter was written.";

/** The Scheduler's Agent routes, over the five operations above. */
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
          description: `Create-or-update the Schedule this \`name\` addresses — an upsert, so a retry or a revised plan converges to one Schedule rather than a duplicate. Answers **201** when the name was new and **200** when it already existed, each with the resulting read model; there is no 404, since a \`PUT\` on an absent name creates it. The \`name\` is the sole identifier and comes from the path. A create that could never fire — a \`once\` already past, a cron whose \`until\` sits at or before its next occurrence — is a 400 rather than a stored Schedule that never fires. This route takes no query parameters at all. ${unknownParameter}`,
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
        // The body hook and the shared query refusal both run: a write is no less bound by the
        // convention that an unknown query parameter is a 400, not a request quietly answered anyway.
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
        // Validated before anything is written, so a 400 never mutates a stored Schedule, and only a
        // create with an assured live fire reaches the upsert — which is what keeps `nextFireAt`
        // non-null on the answer (ADR-0018).
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
          description: `Every live Schedule, ascending by \`nextFireAt\` so the next to fire is first, then by \`name\` to break a tie. A spent or cancelled Schedule is simply absent — the row *is* the arming. ${cappedLimit} There is no cursor and no offset, so the Schedules past the cap are reachable only by raising the limit or narrowing the arrangement. ${unknownParameter}`,
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
          description: `The live Schedule this \`name\` addresses, or a 404 when none does. A Schedule that has fired out or been cancelled is gone, so this answers only what is still arranged. This route takes no query parameters at all. ${unknownParameter}`,
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
          description: `Cancel the Schedule this \`name\` addresses, stopping every future fire. **204** on success, and **404** on a name that addresses none — an unknown name is refused rather than answered an idempotent 204, so a caller learns a Schedule was already gone rather than being told it stopped something that did not exist. This route takes no query parameters at all. ${unknownParameter}`,
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
