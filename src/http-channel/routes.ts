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
          summary: "Submit a Message",
          description: `An **inbound** Message from the User the presented Token names. There is **no field for the submitting User and nowhere for one to arrive**. The id comes from the Token and from nothing a client can write, which is what makes the attribution trustworthy. A \`userId\` written into the body is stripped before the handler and reaches nothing. The Message and the Signal that wakes the agent for it are one transaction. A Message that was stored always has one. What the agent makes of it is **not this response**. An answer arrives on the log as an outbound Message whenever it arrives, which is what \`after=<seq>\` is for. ${bearerRequired} ${unknownParameter}`,
          body: submitSchema,
          response: {
            201: {
              ...messageRecordSchema,
              description: `${theStoredMessage} That number is the cursor to poll from for the answer.`,
            },
            400: refused("`text` is missing or empty, or a query parameter was written."),
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
          summary: "Read your own Message log",
          description: `The presented User's own Messages, both directions, in the single numbered sequence that is their log. There is **no user parameter and nothing to omit**. The log read is the one the Token names. No User can read another's by any spelling of the request. \`?user=\` is refused as the unknown parameter it is. ${cursorCases} ${fullPageMeansMore} ${capped} ${notSearchable} ${bearerRequired} ${unknownParameter}`,
          querystring: ownHistorySchema,
          response: {
            200: { ...messageListSchema, description: theWindow },
            400: refused(
              "A cursor or `limit` is not an integer or is out of range, both cursors were passed, or a parameter this route does not take was written, `user` among them, since this route has none.",
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
