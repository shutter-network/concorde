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

export const notSearchable =
  "A Message log is read by cursor and cannot be searched or filtered. The parameters are a window over one User's `seq`, and there is no full-text or field matching.";

export const rejectUnknownQuery = unknownQueryRefusal(notSearchable);

export const fullPageMeansMore =
  "The envelope carries **no more-results flag**, because a full page is one. `messages.length === limit` means there may be more. The next request is this one with the cursor moved on. `after` takes the largest `seq` received, to walk forwards. `before` takes the smallest, to walk back. A short page is the end of that direction for now. There is no read state of any kind (no stored position, no unread count and no receipts). So the cursor a client needs is one it already holds, because it is holding the Messages.";

export const capped = `${cappedLimit} The Messages past the cap are reachable by paging rather than lost. This is the one list in the framework with a cursor.`;

const noSuchUser =
  "No User has that id, and nothing was stored. There is deliberately no lookup in front of the write: `userId` is a foreign key onto the Users component's table, so a well-formed uuid naming nobody reaches the insert and the constraint is what refuses it. A malformed one never gets that far: the pattern on `userId` refuses it as a 400 first, which is what keeps a typo from being a 500 out of PostgreSQL.";

export const lostTheRace =
  "The Message **was not recorded**, and sending it again is the right thing to do. Nothing is wrong with the request and the log is intact: `seq` is computed per User inside the insert and a unique constraint makes a lost race visible, so this is one User's own concurrent writers outrunning a bounded retry. A 503 and not a 500 for that reason.";

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
        "Which way it travelled. **`inbound`** is the User to the agent and **`outbound`** is the agent to the User, and only a User can cause an inbound one. Decided by the server the request arrived on rather than by any field, so there is nothing anywhere for a caller to set.",
    },
    seq: {
      type: "integer",
      description:
        "This Message's number in **one User's** log, from 1, counting both directions. It is the cursor: the largest one held is what `after` takes to read whatever has arrived since. It is not global and no other User's activity moves it, so two Users' Messages are not orderable against each other by it.",
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

export const theWindow =
  "The window that matched, ascending by `seq`, with both directions interleaved as the one log they are.";
export const theStoredMessage = "The Message as it was stored, including the `seq` it was given.";

export function agentMessageRoutes(messageLog: MessageOperations): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { userId: string; text: string } }>(
      "/",
      {
        schema: {
          tags: ["Messages"],
          summary: "Send a Message to one User",
          description: `An **outbound** Message: the agent to the User \`userId\` names. There is no \`direction\` field, and no way to write an inbound Message from this server. The server the request arrived on decides which way a Message travelled. An agent talked into speaking as somebody has nowhere to say so. A \`direction\` written into the body is stripped before the handler and reaches nothing. The Message is numbered as it is written, with the next \`seq\` in that User's log across both directions. The record answered is the stored one, so there is no read-back to do. ${unknownParameter}`,
          body: agentSendSchema,
          response: {
            201: { ...messageRecordSchema, description: theStoredMessage },
            400: refused(
              "`userId` is not a uuid, `text` is missing or empty, or a query parameter was written. A well-formed id naming nobody is a 404 rather than a 400, since only the write can tell.",
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
          summary: "Read one User's Message log",
          description: `One User's Messages, both directions, in the single numbered sequence that is their log. **\`user\` is required.** Not for confidentiality: reads are not scoped, and the agent may read every log there is. It is required because \`seq\` numbers one person's log and nothing else. An interleaved read would have no cursor to page by. ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${unknownParameter}`,
          querystring: agentHistorySchema,
          response: {
            200: { ...messageListSchema, description: theWindow },
            400: refused(
              "`user` is missing or not a uuid, a cursor or `limit` is not an integer or is out of range, both cursors were passed, or a parameter this route does not take was written.",
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
    return bothCursors(reply, "a User's Messages");
  }
  return { messages: await messageLog.history(userId, asked) };
}

export function refuseSend(reply: FastifyReply, error: unknown, userId: string): FastifyReply {
  if (error instanceof UnknownUserError) return notFound(reply, "User", userId);
  if (error instanceof SeqContentionError) {
    return reply
      .code(503)
      .send({ statusCode: 503, error: "Service Unavailable", message: error.message });
  }
  throw error;
}
