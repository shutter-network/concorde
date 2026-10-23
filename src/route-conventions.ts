import type { FastifyReply } from "fastify";

const defaultLimit = 50;
const maxLimit = 200;

export const limitSchema = {
  type: "integer",
  minimum: 1,
  maximum: maxLimit,
  default: defaultLimit,
} as const;

export const cappedLimit = `The limit defaults to ${limitSchema.default}; allowed values are 1–${limitSchema.maximum}. Out-of-range values return 400.`;

export type CursorWindow = {
  readonly after?: number;
  readonly before?: number;
  readonly limit: number;
};

const cursorSchema = { type: "integer", minimum: 0, maximum: 2147483647 } as const;

export const afterCursor = {
  ...cursorSchema,
  description:
    "Read forward from this sequence number, excluding it. Use `after=0` to start at the beginning.",
} as const;

export const beforeCursor = {
  ...cursorSchema,
  description:
    "Read the latest page below this sequence number, excluding it. Results remain in ascending order.",
} as const;

export const cursorCases =
  "Without a cursor, returns the latest page. `before=N` returns the latest page below N; `after=N` returns the next page above N. Use `after=0` to read from the beginning. Results are always ascending by seq. Supplying both cursors returns 400.";

export function bothCursors(reply: FastifyReply, whichLog: string): FastifyReply {
  return reply.code(400).send({
    statusCode: 400,
    error: "Bad Request",
    message: `Use after or before for ${whichLog}, not both. Omit both for the latest page.`,
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
      const refusal = `Unknown query parameter(s): ${named}. Accepted: ${takes}.`;
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
    .send({ statusCode: 404, error: "Not Found", message: `No ${what} ${id} exists` });
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

export const unknownParameter = "Unknown query parameters return 400.";

export const bearerRequired =
  "Requires authentication through a scheme installed in this deployment. If password auth is installed, obtain a token from `POST /auth/tokens` and send `Authorization: Bearer <token>`.";

export const authenticationFailed =
  "Authentication failed. Missing, invalid, or expired credentials return the same response without revealing whether a user exists.";

export const notAuthenticated = `${authenticationFailed}`;
