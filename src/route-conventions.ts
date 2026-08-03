/**
 * The conventions every part's HTTP routes share, in one place rather than four
 * copied behaviours.
 *
 * Internal to the framework: no part of this is exported from the package. An
 * Operator writing routes of their own brings Fastify and writes them however they
 * like — these are the rules *our* parts hold each other to, so that a Gateway
 * assembled from several of them answers one way rather than one way per part:
 *
 * - an unknown query parameter is a **400**, not a request answered with everything;
 * - an id in a path is **pattern-validated** before it reaches PostgreSQL;
 * - a list takes a **capped limit** with a default, and answers in an **envelope**;
 * - a 404 body matches **Fastify's own error shape**, and every refusal is described
 *   with the one schema below rather than with a shape per part.
 *
 * Each has a reason, and the reason is written beside it below.
 */

import type { FastifyReply } from "fastify";

/**
 * How many records a list answers with by default, and the most it will.
 *
 * A cap rather than a cursor, and the limit that follows is worth stating plainly:
 * with no cursor and no offset, **the records past `maxLimit` are unreachable** except
 * by narrowing with whatever filter the route offers. Nothing is being refused — there
 * is simply no paging yet, because no caller has had a use for it. When one does, the
 * cursor goes in the envelope alongside the list, which is why a list is an envelope
 * rather than a bare array.
 */
const defaultLimit = 50;
const maxLimit = 200;

/** The `limit` query parameter: optional, defaulted, and capped. */
export const limitSchema = {
  type: "integer",
  minimum: 1,
  maximum: maxLimit,
  default: defaultLimit,
} as const;

/**
 * The two numbers above as the sentence a list route's description carries.
 *
 * Written from the schema rather than beside it, because the numbers are the thing that
 * moves: a part restating "capped at 200" in prose is a copy that goes stale the day
 * `maxLimit` changes, and a document that promises a cap the schema does not enforce is
 * worse than no sentence at all. What a part adds is what happens to the records *past*
 * the cap, which depends on what that route offers to narrow by and is therefore the
 * part's to say ([ADR-0040](../docs/adr/0040-the-gateway-describes-its-own-http-api.md)).
 */
export const cappedLimit = `\`limit\` defaults to ${limitSchema.default} and is capped at ${limitSchema.maximum}. A larger value is **refused with a 400** rather than quietly reduced.`;

/**
 * The shape of an id in a path or a query.
 *
 * Validated rather than passed through, because PostgreSQL refuses to cast a
 * malformed uuid and the caller would get a 500 out of a mistyped path instead of the
 * 400 it earned. Spelled as a pattern rather than `format: "uuid"`, which needs an
 * ajv plugin Fastify does not bundle.
 */
export const idSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
} as const;

/** The params of a route whose path ends in one id, `/:id`. */
export const idParams = {
  type: "object",
  properties: { id: idSchema },
  required: ["id"],
  additionalProperties: false,
} as const;

/**
 * Builds the hook that refuses a query parameter a route does not have, before
 * validation strips it.
 *
 * A hook rather than the schema, because Fastify's ajv is configured with
 * `removeAdditional`, so `additionalProperties: false` deletes an unknown parameter
 * and answers the request as though it had never been written. `?limt=5` quietly
 * returning fifty records is a misread nobody sees. A route's schema keeps
 * `additionalProperties: false` anyway — it is what documents the parameter list, and
 * this hook is what makes it a refusal.
 *
 * `explanation` is the sentence the refusal ends with, and it belongs to the caller
 * because the useful thing to say is about *that* surface: the Signal Worker's routes
 * explain that reads are not scoped by Session or by User, which is the right sentence there
 * and the wrong one anywhere else. Omit it and the message stops after the parameter
 * list.
 *
 * The result is applied per route with the parameters that route does take:
 * `const rejectUnknownQuery = unknownQueryRefusal("…"); rejectUnknownQuery("limit")`.
 *
 * The behaviour itself, as the sentence a description carries, is `unknownParameter`
 * below.
 */
export function unknownQueryRefusal(explanation?: string) {
  return (...allowed: readonly string[]) =>
    // `query` is `unknown` rather than a record, because a route with no `Querystring`
    // type is exactly where this hook matters most and Fastify types its query that
    // way. Narrowed rather than asserted: there is no shape to promise here.
    async (
      request: { readonly query: unknown },
      reply: FastifyReply,
    ): Promise<FastifyReply | undefined> => {
      const written =
        typeof request.query === "object" && request.query !== null
          ? Object.keys(request.query)
          : [];
      const unexpected = written.filter((parameter) => !allowed.includes(parameter));
      if (unexpected.length === 0) return undefined;
      const takes = allowed.length === 0 ? "no parameters" : allowed.join(", ");
      const named = unexpected.map((parameter) => JSON.stringify(parameter)).join(", ");
      const refusal = `${named} is not a parameter of this route, which takes ${takes}.`;
      return reply.code(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: explanation === undefined ? refusal : `${refusal} ${explanation}`,
      });
    };
}

/**
 * The 404 body, in the shape Fastify's own errors use, so a surface answers one error
 * shape rather than two.
 */
export function notFound(reply: FastifyReply, what: string, id: string): FastifyReply {
  return reply
    .code(404)
    .send({ statusCode: 404, error: "Not Found", message: `no ${what} ${id} exists` });
}

/**
 * That same body as a **response schema**: the one shape every refusal on either surface
 * is described with, so a client writes one error path rather than one per part
 * ([ADR-0040](../docs/adr/0040-the-gateway-describes-its-own-http-api.md)).
 *
 * It lives here because `notFound` above does, and for the reason this whole module
 * does: three parts inventing three error schemas would contradict a uniformity that was
 * already deliberate. Internal like everything else here, and reached through `refused`
 * below rather than named directly, since a described status is worth nothing without the
 * sentence saying what reaches it.
 *
 * **A response schema is a serializer**, so this one decides what a refusal may carry
 * and not merely what it is documented as carrying. The three properties are what the
 * framework's own refusals send; Fastify's *validation* failures send a fourth,
 * `code: "FST_ERR_VALIDATION"`, and a route declaring this for its 400 drops it. That is
 * the trade taken knowingly: the useful part of a validation refusal is its `message`,
 * which names the field, and one error shape across sixteen routes is worth more than a
 * machine-readable code no caller of ours branches on.
 *
 * It arrived with **no caller**, deliberately: the three parts declare their responses in
 * three tickets that would otherwise have chained behind whichever one invented this
 * first, and one shared shape invented three times is the thing this module exists to
 * prevent.
 */
export const errorSchema = {
  type: "object",
  properties: {
    statusCode: { type: "integer" },
    error: { type: "string" },
    message: { type: "string" },
  },
  required: ["statusCode", "error", "message"],
} as const;

/**
 * One refused status, in the shape above and with the sentence saying what reaches it
 * *here*.
 *
 * The shape is the same on all sixteen routes and the sentence never is, which is the
 * whole division of labour: a caller reading one route wants to know what it is about to
 * be refused for, not what a refusal looks like. So this is what a part reaches for
 * rather than `errorSchema` itself, and a status that cannot be described without saying
 * why is one fewer place for `"Default Response"` to end up in the document.
 */
export function refused(why: string) {
  return { ...errorSchema, description: why };
}

/**
 * What a route says about a query parameter it does not have, in the document.
 *
 * The first bullet at the top of this module, as prose rather than as a hook. It is the
 * same fact on every route of every part, since the refusal `unknownQueryRefusal` builds
 * is this convention and no part's own decision, so a part restating it in its own words
 * would be three parts describing one behaviour three ways, which is what this module
 * exists to stop. What *is* each part's own is the sentence the refusal ends with, which
 * is the argument to `unknownQueryRefusal` and belongs to the surface.
 */
export const unknownParameter =
  "An unknown query parameter is a **400**, not a filter that did nothing and a request answered with everything.";
