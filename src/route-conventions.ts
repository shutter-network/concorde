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
 * - a log is paged by **one cursor pair**, `after` or `before` and never both;
 * - a 404 body matches **Fastify's own error shape**, and every refusal is described
 *   with the one schema below rather than with a shape per part.
 *
 * Each has a reason, and the reason is written beside it below.
 */

import type { FastifyReply } from "fastify";

/**
 * How many records a list answers with by default, and the most it will.
 *
 * The cap is on every list; the cursor below is not. On a list that has no cursor and no
 * offset either, **the records past `maxLimit` are unreachable** except by narrowing with
 * whatever filter the route offers, and that is worth stating plainly rather than leaving
 * to be discovered: nothing is being refused, there is simply no paging on that route. On a
 * list that takes the cursor pair below, the cap bounds one page and the rest is reached by
 * asking again. Either way a list answers in an **envelope** rather than as a bare array.
 * That shape was kept for the day paging arrived, and paging arrived without spending it: a
 * page carries its own cursor in the largest `seq` it holds, so nothing sits beside the
 * records and no list has a more-results flag
 * ([ADR-0035](../docs/adr/0035-a-users-messages-are-one-log-read-by-cursor.md)).
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
 * Which stretch of a log a read asks for: one cursor, or the other, or neither, and a limit.
 *
 * The shape carries no User id and nothing else naming whose log it is, because which log is
 * read is settled elsewhere on every surface that has one: by a Token on the Public server
 * and by a query parameter on the Agent server. So it is the same shape wherever a log is
 * paged, and a part wanting its own name for it aliases this rather than declaring a second
 * ([ADR-0035](../docs/adr/0035-a-users-messages-are-one-log-read-by-cursor.md)).
 *
 * What the three motions are and what order they all answer in is `cursorCases` below, said
 * once and said to the client rather than twice and once to a reader of this file. What the
 * type is for is the constraint that paragraph ends on: `after` and `before` are both
 * optional and both at once is two windows, which the route refuses with `bothCursors` below
 * rather than the read resolving it.
 */
export type CursorWindow = {
  readonly after?: number;
  readonly before?: number;
  readonly limit: number;
};

/**
 * A cursor: one `seq`, or the 0 no record has.
 *
 * Validated as an integer so that `?after=abc` is the 400 it earned rather than a query
 * PostgreSQL refuses to run, the same reason an id is pattern-validated.
 *
 * `0` is deliberately allowed even though nothing is numbered it: `after=0` is how a client
 * asks for a log **from its beginning**, oldest first, which no other spelling expresses,
 * since no cursor at all means the newest page instead and `after=1` would skip the first
 * record.
 */
const cursorSchema = { type: "integer", minimum: 0 } as const;

/**
 * The same cursor twice, described as the two different motions it is.
 *
 * One `cursorSchema` for the validation and two descriptions over it, because what `after`
 * and `before` share is their shape and nothing else: a single description on the constant
 * would have to be true of both and would therefore say nothing about either. A route's own
 * description still carries all three cases together, which is `cursorCases` below, since
 * the third is the one a parameter list cannot show, being the *absence* of both of these.
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
 * The three cursor cases, the one order they all answer in, and why both at once is a 400,
 * as the paragraph a cursored read's description carries.
 *
 * The sharpest sentences either document has, because **no schema conveys any part of them**:
 * `after` and `before` are two optional integers, and nothing about that shape says which of
 * them is the newest page, that all three cases answer ascending, or that passing both is
 * refused. A client that guesses wrong renders a log backwards and nothing anywhere reports
 * it ([ADR-0040](../docs/adr/0040-the-gateway-describes-its-own-http-api.md)).
 *
 * Written here rather than in a part for the reason `unknownParameter` below is: it is the
 * same fact on every cursored read of every part, so a second copy is a second chance to
 * disagree about what `before` means, which is a thing no client could report and no test of
 * one surface would catch. What a part adds beside it is what its own log is and what
 * reaching the records past the cap costs there, which is the part's to say.
 */
export const cursorCases =
  "**Three cursor cases, one order.** No cursor answers the newest page, which is what a client opening a conversation wants. `before=N` answers the newest page strictly below `N`, which is scrolling back. `after=N` walks forwards from `N`, which is polling, and `after=0` is how a log is read from its beginning, since nothing is numbered 0 and no cursor at all means the newest page instead. All three answer **ascending by `seq`**, so a client concatenates pages without reversing anything. Passing `after` and `before` together is a **400**, because it describes two windows rather than one.";

/**
 * Both cursors at once, refused in the same body shape as `notFound` below.
 *
 * A client bug worth naming rather than one of the two silently winning, and a refusal rather
 * than a resolution: a read given both would have to decide which window was meant, and there
 * is no answer to that a caller could have predicted.
 *
 * `whichLog` names the records the caller was asking for, and it is an argument because a
 * shared refusal saying the wrong noun is worse than two refusals: somebody asking about one
 * part's log should not be answered about another's. A noun phrase rather than `notFound`'s
 * bare noun, because it goes into a sentence rather than beside an id, and the rest of that
 * sentence is the same for every part, the two motions being the same wherever they are.
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
