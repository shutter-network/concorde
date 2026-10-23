import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import type { MessageRecord, MessageWindow } from "../messenger/messages.ts";
import {
  answerHistory,
  capped,
  fullPageMeansMore,
  lostTheRace,
  type MessageHistory,
  messageListSchema,
  messageRecordSchema,
  notSearchable,
  refuseSend,
  rejectUnknownQuery,
  textSchema,
  theStoredMessage,
  theWindow,
} from "../messenger/routes.ts";
import {
  afterCursor,
  bearerRequired,
  beforeCursor,
  cursorCases,
  limitSchema,
  notAuthenticated,
  refused,
  unknownParameter,
} from "../route-conventions.ts";

export type OwnMessageOperations = MessageHistory & {
  submit(userId: string, text: string): Promise<MessageRecord>;
};

const submitSchema = {
  type: "object",
  properties: { text: textSchema },
  required: ["text"],
  additionalProperties: false,
} as const;

const ownHistorySchema = {
  type: "object",
  properties: { after: afterCursor, before: beforeCursor, limit: limitSchema },
  additionalProperties: false,
} as const;

export function publicMessageRoutes(
  messageLog: OwnMessageOperations,
  presentedUser: preHandlerAsyncHookHandler,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { text: string } }>(
      "/",
      {
        schema: {
          tags: ["Messages"],
          summary: "Submit a message",
          description: `Stores an inbound message for the authenticated user and emits its signal in one transaction. The body cannot select another user or a direction; extra fields are stripped. The response contains the stored message, not the agent's answer. Poll the message log for outbound replies. ${bearerRequired} ${unknownParameter}`,
          body: submitSchema,
          response: {
            201: {
              ...messageRecordSchema,
              description: `${theStoredMessage} Use its seq as the after cursor when polling for a reply.`,
            },
            400: refused("A nonempty `text` is required. Query parameters are not accepted."),
            401: refused(notAuthenticated),
            503: refused(lostTheRace),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectUnknownQuery(),
      },
      async (request, reply) => {
        try {
          return reply
            .code(201)
            .send(await messageLog.submit(request.concordeUser.id, request.body.text));
        } catch (error) {
          return refuseSend(reply, error, request.concordeUser.id);
        }
      },
    );

    fastify.get<{ Querystring: MessageWindow }>(
      "/",
      {
        schema: {
          tags: ["Messages"],
          summary: "Read your message log",
          description: `Reads both message directions for the authenticated user. There is no user parameter; other users' logs are inaccessible through this route. ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${bearerRequired} ${unknownParameter}`,
          querystring: ownHistorySchema,
          response: {
            200: { ...messageListSchema, description: theWindow },
            400: refused(
              "Invalid cursor or limit, both cursors supplied, or an unknown query parameter. There is no user parameter.",
            ),
            401: refused(notAuthenticated),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectUnknownQuery("after", "before", "limit"),
      },
      async (request, reply) =>
        answerHistory(reply, messageLog, request.concordeUser.id, request.query),
    );
  };
}
