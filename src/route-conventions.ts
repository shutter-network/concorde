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
 * - a 404 body matches **Fastify's own error shape**.
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
