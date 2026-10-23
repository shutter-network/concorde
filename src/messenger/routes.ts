import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  afterCursor,
  beforeCursor,
  bothCursors,
  cappedLimit,
  cursorCases,
  idSchema,
  limitSchema,
  notFound,
  refused,
  unknownParameter,
  unknownQueryRefusal,
} from "../route-conventions.ts";
import {
  type MessageRecord,
  type MessageWindow,
  SeqContentionError,
  UnknownUserError,
} from "./messages.ts";
import { messageDirections } from "./schema/index.ts";

export type MessageHistory = {
  history(userId: string, window: MessageWindow): Promise<MessageRecord[]>;
};

export type MessageOperations = MessageHistory & {
  send(userId: string, text: string): Promise<MessageRecord>;
};

export const notSearchable = "Supports cursor paging, not search or field filters.";

export const rejectUnknownQuery = unknownQueryRefusal(notSearchable);

export const fullPageMeansMore =
  "A full page may have more results. Continue forward with its largest `seq` as `after`, or backward with its smallest as `before`. A short page ends that direction for now. Clients store their own cursors; there are no unread counts or read receipts.";

export const capped = `${cappedLimit}`;

const noSuchUser = "No user has this id. Nothing was stored.";

export const lostTheRace =
  "Concurrent writes exhausted the sequence allocation retries. The message was not recorded; retry the request.";

export const textSchema = { type: "string", minLength: 1 } as const;

const agentSendSchema = {
  type: "object",
  properties: { userId: idSchema, text: textSchema },
  required: ["userId", "text"],
  additionalProperties: false,
} as const;

const agentHistorySchema = {
  type: "object",
  properties: { user: idSchema, after: afterCursor, before: beforeCursor, limit: limitSchema },
  required: ["user"],
  additionalProperties: false,
} as const;

export const messageRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    userId: { type: "string" },
    direction: {
      type: "string",
      enum: messageDirections,
      description:
        "`inbound` means user to agent; `outbound` means agent to user. The route determines the direction, not a body field.",
    },
    seq: {
      type: "integer",
      description:
        "Sequence within this user's message log, starting at 1 and counting both directions. Use it as the paging cursor; it does not order messages across users.",
    },
    text: { type: "string" },
    createdAt: { type: "string" },
  },
  required: ["id", "userId", "direction", "seq", "text", "createdAt"],
} as const;

export const messageListSchema = {
  type: "object",
  properties: { messages: { type: "array", items: messageRecordSchema } },
  required: ["messages"],
} as const;

export const theWindow = "Messages in ascending sequence order, including both directions.";
export const theStoredMessage = "The stored message and its assigned sequence number.";

export function agentMessageRoutes(messageLog: MessageOperations): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { userId: string; text: string } }>(
      "/",
      {
        schema: {
          tags: ["Messages"],
          summary: "Send a message to a user",
          description: `Stores an outbound message and stages delivery through the registered channel. The sequence counts both directions in the recipient's log. This route cannot create inbound messages; a direction field in the body is stripped. ${unknownParameter}`,
          body: agentSendSchema,
          response: {
            201: { ...messageRecordSchema, description: theStoredMessage },
            400: refused(
              "A UUID userId and nonempty text are required. Unknown users return 404. Query parameters are not accepted.",
            ),
            404: refused(noSuchUser),
            503: refused(lostTheRace),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => {
        try {
          return reply
            .code(201)
            .send(await messageLog.send(request.body.userId, request.body.text));
        } catch (error) {
          return refuseSend(reply, error, request.body.userId);
        }
      },
    );

    fastify.get<{ Querystring: MessageWindow & { user: string } }>(
      "/",
      {
        schema: {
          tags: ["Messages"],
          summary: "Read a user's message log",
          description: `Reads both directions for the required user id. The agent may read any user's log. ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${unknownParameter}`,
          querystring: agentHistorySchema,
          response: {
            200: { ...messageListSchema, description: theWindow },
            400: refused(
              "Missing or invalid user UUID, invalid cursor or limit, both cursors supplied, or an unknown query parameter.",
            ),
          },
        },
        preValidation: rejectUnknownQuery("user", "after", "before", "limit"),
      },
      async (request, reply) => answerHistory(reply, messageLog, request.query.user, request.query),
    );
  };
}

export async function answerHistory(
  reply: FastifyReply,
  messageLog: MessageHistory,
  userId: string,
  asked: MessageWindow,
): Promise<FastifyReply | { readonly messages: MessageRecord[] }> {
  if (asked.after !== undefined && asked.before !== undefined) {
    return bothCursors(reply, "a user's messages");
  }
  return { messages: await messageLog.history(userId, asked) };
}

export function refuseSend(reply: FastifyReply, error: unknown, userId: string): FastifyReply {
  if (error instanceof UnknownUserError) return notFound(reply, "user", userId);
  if (error instanceof SeqContentionError) {
    return reply
      .code(503)
      .send({ statusCode: 503, error: "Service Unavailable", message: error.message });
  }
  throw error;
}
