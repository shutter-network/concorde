/**
 * One plugin, on the Public server, and it is what HTTP as a Channel actually is: a User
 * submitting, and a User polling their own log by cursor (ADR-0035, ADR-0048). The agent's own two
 * routes are acts on the log rather than acts of a medium, so they are the Messenger's and live in
 * `../messenger/routes.ts`. The plugin is not exported and the prefix is not configurable. Every
 * path it declares is relative, because the constructor supplies that prefix.
 *
 * The routes themselves are not listed here. `scripts/reference/route-pages.ts` renders them into
 * the reference out of the declarations below, so a table beside them would be a second list to
 * keep true and nothing would compare the two.
 *
 * The serializers, the shared sentences, the read helper and both refusal helpers are imported
 * from the Messenger's own route module rather than restated. A `MessageRecord` has one shape on every surface, and a
 * response schema is a serializer whose drift is silent, so the copy that would make this file
 * self-contained is exactly the copy that could lose a field here and nowhere else. Do not inline
 * one.
 *
 * Nothing here authenticates anybody. Both routes take the Public server's own `requireUser` as
 * one option and read the User off `request.safUser`, and neither has a parameter naming a User at
 * all, so no User can read another's log.
 *
 * The 401 and the credential are described in the shared words of `route-conventions.ts` rather
 * than restated here, because the refusal belongs to the server and to no component.
 */

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

/**
 * What a User's own routes need: the shared read, and a submission.
 *
 * `submit` takes neither a direction nor a transaction. This is the Public server, so the only
 * Message a request here can cause is an inbound one, and the transaction belongs to the
 * constructor, which opens it around the Messenger's `receive`. What comes back is the stored
 * record, which is both the 201's body and the Signal's payload.
 */
export type OwnMessageOperations = MessageHistory & {
  submit(userId: string, text: string): Promise<MessageRecord>;
};

/**
 * The body of `POST /`: what the User said, and nothing else.
 *
 * There is no `userId` here and nowhere for one to arrive. The submitting User is the one their
 * Token named, which is what makes the attribution in the Signal payload trustworthy. A client that
 * posts one anyway has it dropped by `additionalProperties: false`, so nobody can put words in
 * another User's mouth.
 */
const submitSchema = {
  type: "object",
  properties: { text: textSchema },
  required: ["text"],
  additionalProperties: false,
} as const;

/**
 * A User's own read: the window, and nothing naming a User.
 *
 * The agent's schema is this one plus a required `user`, and that is the whole difference between
 * the two surfaces. There is no such property here to omit, so a request cannot ask about somebody
 * else and nothing has to refuse one.
 */
const ownHistorySchema = {
  type: "object",
  properties: { after: afterCursor, before: beforeCursor, limit: limitSchema },
  additionalProperties: false,
} as const;

/**
 * The Public server's Message routes: a User's own log, and the one way into it from outside.
 *
 * `presentedUser` is the server's `requireUser`, taken as one option on each route and not wrapped, extended or
 * re-implemented. So an unauthenticated read or submission is the single 401 of Users.
 *
 * The hook runs at `preHandler`, after validation, so a malformed window, an unknown query
 * parameter and an empty `text` are answered before a Token is read. That leaks nothing: such a
 * refusal names a parameter or a field of the route, and never a User.
 */
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
      // Inbound, because this is the Public server's plugin, and by the User the Token named.
      // There is no field on this route for a client to put a User in. What `submit` does with it
      // is the constructor's, because a route holds no Db: one Message and one Signal, together,
      // written through the handle the Messenger handed this Channel at registration.
      async (request, reply) => {
        try {
          return reply
            .code(201)
            .send(await messageLog.submit(request.safUser.id, request.body.text));
        } catch (error) {
          return refuseSend(reply, error, request.safUser.id);
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
      // The whole difference from the agent's read is the User id. Theirs comes from a query
      // parameter, and this one from the Token the hook above verified.
      async (request, reply) => answerHistory(reply, messageLog, request.safUser.id, request.query),
    );
  };
}
