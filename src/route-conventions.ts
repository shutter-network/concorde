import type { FastifyReply } from "fastify";

const defaultLimit = 50;
const maxLimit = 200;

export const limitSchema = {
  type: "integer",
  minimum: 1,
  maximum: maxLimit,
  default: defaultLimit,
} as const;

export const cappedLimit = `\`limit\` defaults to ${limitSchema.default} and is capped at ${limitSchema.maximum}. A larger value is **refused with a 400** rather than quietly reduced.`;

export type CursorWindow = {
  readonly after?: number;
  readonly before?: number;
  readonly limit: number;
};

const cursorSchema = { type: "integer", minimum: 0, maximum: 2147483647 } as const;

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

export const cursorCases =
  "**Three cursor cases, one order.** No cursor answers the newest page, which is what a client opening a conversation wants. `before=N` answers the newest page strictly below `N`, which is scrolling back. `after=N` walks forwards from `N`, which is polling, and `after=0` is how a log is read from its beginning, since nothing is numbered 0 and no cursor at all means the newest page instead. All three answer **ascending by `seq`**, so a client concatenates pages without reversing anything. Passing `after` and `before` together is a **400**, because it describes two windows rather than one.";

export function bothCursors(reply: FastifyReply, whichLog: string): FastifyReply {
  return reply.code(400).send({
    statusCode: 400,
    error: "Bad Request",
    message: `after and before describe two different windows of ${whichLog}: pass after to walk forwards, before to walk backwards, or neither for the newest page.`,
  });
}

export const idSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
} as const;

export const idParams = {
  type: "object",
  properties: { id: idSchema },
  required: ["id"],
  additionalProperties: false,
} as const;

export function unknownQueryRefusal(explanation?: string) {
  return (...allowed: readonly string[]) =>
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

export function notFound(reply: FastifyReply, what: string, id: string): FastifyReply {
  return reply
    .code(404)
    .send({ statusCode: 404, error: "Not Found", message: `no ${what} ${id} exists` });
}

export const errorSchema = {
  type: "object",
  properties: {
    statusCode: { type: "integer" },
    error: { type: "string" },
    message: { type: "string" },
  },
  required: ["statusCode", "error", "message"],
} as const;

export function refused(why: string) {
  return { ...errorSchema, description: why };
}

export const unknownParameter =
  "An unknown query parameter is a **400**, not a filter that did nothing and a request answered with everything.";

export const bearerRequired =
  "**Requires a bearer Token**, presented as `Authorization: Bearer <token>` and obtained from `POST /auth/tokens`. The User acted on is the one the Gateway authenticated, and no parameter anywhere names another.";

export const authenticationFailed =
  "Authentication failed, which is the whole of what is said: a wrong password, an id nobody holds, a User with no password, and a Token that is missing, malformed, unknown or expired are one status and one message, so nothing here answers who exists.";

export const notAuthenticated = `${authenticationFailed} This part authenticates nobody: the refusal is \`publicServer.requireUser\`, taken as one option on the route, so it is the same 401 every protected route on this server answers, whichever scheme the deployment accepts.`;
