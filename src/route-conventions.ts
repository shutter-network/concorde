/**
 * The rules the framework's own components hold each other to, so that a Gateway answers one way
 * whichever component was asked:
 *
 * - an unknown query parameter is a **400**, not a request answered with everything;
 * - an id in a path is **pattern-validated** before it reaches PostgreSQL;
 * - a list takes a **capped limit** with a default, and answers in an **envelope**;
 * - a log is paged by **one cursor pair**, `after` or `before` and never both;
 * - a refusal matches **Fastify's own error shape**, described with one schema.
 *
 * Internal, with one exception: `CursorWindow` is a parameter of two components' `history`
 * methods, so it is exported from the package root, where what belongs to no single component
 * lives (ADR-0047). Nothing else here reaches a specifier, and an Operator writing routes of
 * their own brings Fastify and writes them however they like.
 *
 * The `description` strings are the other thing that leaves this file. They are interpolated into
 * several components' route descriptions and rendered in the OpenAPI document, so the wording is
 * public even where the name is not, and three of them are pinned word for word by
 * `gateway.test.ts`.
 */

import type { FastifyReply } from "fastify";

/**
 * How many records a list answers with by default, and the most it will.
 *
 * The cap is on every list. The cursor below is not. On a list with no cursor, the records past
 * `maxLimit` are reachable only by narrowing with a filter. Every list answers in an envelope
 * rather than as a bare array.
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
 * Interpolated from the schema, because the numbers are what moves. A component adds what becomes
 * of the records past the cap, which depends on what its own route offers to narrow by.
 */
export const cappedLimit = `\`limit\` defaults to ${limitSchema.default} and is capped at ${limitSchema.maximum}. A larger value is **refused with a 400** rather than quietly reduced.`;

/**
 * Which stretch of a log a read asks for: one cursor, the other, or neither, and a limit.
 *
 * No cursor at all answers the newest page, which is what a client opening a log wants. `before`
 * answers the newest page strictly below that `seq`, which is scrolling back, and `after` walks
 * forwards from it, which is polling. `after: 0` reads a log from its beginning, nothing being
 * numbered 0. All three answer ascending by `seq`, so pages concatenate without anything being
 * reversed.
 *
 * Both cursors together describe two windows rather than one. An HTTP route given both answers
 * 400; a `history` method given both refuses nothing and reads between them.
 *
 * It carries no User id. Which log is read is settled elsewhere, by the Token on the Public server
 * and by a query parameter on the Agent server, so one shape serves wherever a log is paged. The
 * two `history` methods take `Partial` of it, every field optional, so a caller wanting the newest
 * page passes nothing at all.
 */
export type CursorWindow = {
  readonly after?: number;
  readonly before?: number;
  readonly limit: number;
};

/**
 * A cursor: one `seq`, or the 0 no record has.
 *
 * Validated as an integer, so `?after=abc` is a 400 rather than a query PostgreSQL refuses to run.
 * `0` is allowed: `after=0` is how a client asks for a log from its beginning, oldest first.
 *
 * The `maximum` is the column type. Every `seq` is a PostgreSQL `integer`, so a cursor above
 * `2147483647` names no record. Capped here, it is a 400 naming the parameter.
 */
const cursorSchema = { type: "integer", minimum: 0, maximum: 2147483647 } as const;

/**
 * The same cursor twice, described as the two different motions it is. One schema for the
 * validation, and two descriptions over it: `after` and `before` share their shape and nothing
 * else.
 */
export const afterCursor = {
  ...cursorSchema,
  description:
    "Walk **forwards** from this `seq`, exclusive: the poll. `after=0` reads the log from its beginning, oldest first, which no other spelling expresses.",
} as const;

export const beforeCursor = {
  ...cursorSchema,
  description:
    "The newest page strictly **below** this `seq`: scrolling back. Answers ascending like every other case, so the page before the one in hand arrives the same way up.",
} as const;

/**
 * The three cursor cases and the one order they all answer in, for a cursored read's description.
 *
 * No schema conveys any of this. `after` and `before` are two optional integers, and that shape
 * says nothing about which of them is the newest page. A client that guesses wrong renders a log
 * backwards, and nothing reports it.
 */
export const cursorCases =
  "**Three cursor cases, one order.** No cursor answers the newest page, which is what a client opening a conversation wants. `before=N` answers the newest page strictly below `N`, which is scrolling back. `after=N` walks forwards from `N`, which is polling, and `after=0` is how a log is read from its beginning, since nothing is numbered 0 and no cursor at all means the newest page instead. All three answer **ascending by `seq`**, so a client concatenates pages without reversing anything. Passing `after` and `before` together is a **400**, because it describes two windows rather than one.";

/**
 * Refuses both cursors at once, in the same body shape as `notFound`.
 *
 * A read given both would have to pick a window, and no caller can predict which. So it is a
 * refusal rather than a resolution.
 *
 * `whichLog` is a noun phrase naming the records the caller asked for. It goes into the message, so
 * a refusal shared between components cannot name the wrong log.
 */
export function bothCursors(reply: FastifyReply, whichLog: string): FastifyReply {
  return reply.code(400).send({
    statusCode: 400,
    error: "Bad Request",
    message: `after and before describe two different windows of ${whichLog}: pass after to walk forwards, before to walk backwards, or neither for the newest page.`,
  });
}

/**
 * The shape of an id in a path or a query.
 *
 * Validated rather than passed through: PostgreSQL refuses to cast a malformed uuid, so a mistyped
 * path would answer 500 instead of the 400 it earned. Spelled as a pattern rather than
 * `format: "uuid"`, which needs an ajv plugin Fastify does not bundle.
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
 * The shape of a **name** in a path, for a record addressed by a key its caller chose.
 *
 * PostgreSQL stores any text as a primary key without complaint, so an unbounded or
 * control-character name would be accepted rather than refused. The pattern bounds the length and
 * holds the name to a url-safe charset: letters, digits, and three separators.
 *
 * The Scheduler's Agent routes are the one family that addresses by name, a Schedule's identity
 * being a client-chosen key.
 */
export const nameSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9._-]{1,128}$",
} as const;

/** The params of a route whose path ends in one name, `/:name`. */
export const nameParams = {
  type: "object",
  properties: { name: nameSchema },
  required: ["name"],
  additionalProperties: false,
} as const;

/**
 * Builds the hook that refuses a query parameter a route does not have.
 *
 * A hook and not the schema, because Fastify's ajv runs with `removeAdditional`.
 * `additionalProperties: false` therefore deletes an unknown parameter and answers as though it
 * had never been written, so `?limt=5` quietly returns fifty records. A route keeps
 * `additionalProperties: false` anyway, that being what documents the parameter list.
 *
 * Apply the result per route with the parameters that route takes:
 * `const rejectUnknownQuery = unknownQueryRefusal("…"); rejectUnknownQuery("limit")`.
 *
 * `explanation` is the sentence the refusal ends with, about this surface. Omit it and the message
 * stops after the parameter list.
 */
export function unknownQueryRefusal(explanation?: string) {
  return (...allowed: readonly string[]) =>
    // `query` is `unknown` rather than a record. A route with no `Querystring` type is where
    // this hook matters most, and Fastify types its query that way. Narrowed rather than
    // asserted, because there is no shape to promise here.
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

/** Sends a 404 in the shape Fastify's own errors use, so a surface answers one error shape. */
export function notFound(reply: FastifyReply, what: string, id: string): FastifyReply {
  return reply
    .code(404)
    .send({ statusCode: 404, error: "Not Found", message: `no ${what} ${id} exists` });
}

/**
 * That same body as a **response schema**: the one shape every refusal is described with.
 *
 * Reach for `refused` rather than for this. A described status is worth nothing without the
 * sentence saying what reaches it.
 *
 * A response schema is a serializer, so this one decides what a refusal can carry. The three
 * properties are what the framework's own refusals send. Fastify's validation failures also send
 * `code: "FST_ERR_VALIDATION"`, and a route declaring this for its 400 drops that field.
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
 * Describes one refused status: the shared shape, and the sentence saying what reaches it here.
 *
 * The shape is the same on every route and the sentence never is, because a caller reading one
 * route wants to know what it is about to be refused for. `why` is that sentence.
 */
export function refused(why: string) {
  return { ...errorSchema, description: why };
}

/** What a route says in the document about a query parameter it does not have. */
export const unknownParameter =
  "An unknown query parameter is a **400**, not a filter that did nothing and a request answered with everything.";
